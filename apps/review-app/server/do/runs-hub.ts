// ---------------------------------------------------------------------------
// RunsHub — singleton Durable Object that owns the live run registry.
//
// Replaces the KV-based `runs:recent` polling pattern. One DO instance polls
// instance.status() on a 3-second alarm for every non-terminal run, applies
// deltas to durable storage, and pushes them to subscribed WebSocket clients
// (the bell + /runs page on the `recent` channel; the run-detail dialog on a
// per-run channel).
//
// On terminal status, the DO also persists a one-row summary to the Airtable
// `runs` table so the run history outlives the in-memory recent list.
// ---------------------------------------------------------------------------
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { workflowBinding } from '../workflows/registry';
import { getCapturedError } from '../services/run-errors';
import { appendRunRow } from '../services/runs-airtable';

export interface RunRecord {
  runId: string;
  workflow: string;
  recordId: string;
  recordLabel?: string;
  parentRunId?: string;
  triggeredBy: 'http' | 'cron' | 'parent-orchestrator';
  forceRefresh: boolean;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: string;
  error?: { name: string; message: string; stack?: string };
  output?: unknown;
  airtableRowId?: string;
  /**
   * Self-reported confidence from research workflows (extracted from
   * `output.research.confidence`). 'low' surfaces with an amber badge in the
   * UI so curators can spot best-effort completions at a glance.
   */
  confidence?: 'high' | 'medium' | 'low';
}

/**
 * Pull `confidence` out of a workflow output payload if present. Research
 * workflows return `{ research: { confidence }, ... }`; everything else
 * leaves it undefined.
 */
function extractConfidence(output: unknown): 'high' | 'medium' | 'low' | undefined {
  if (output == null || typeof output !== 'object') return undefined;
  const research = (output as { research?: unknown }).research;
  if (research == null || typeof research !== 'object') return undefined;
  const c = (research as { confidence?: unknown }).confidence;
  return c === 'high' || c === 'medium' || c === 'low' ? c : undefined;
}

export interface RunStartedPayload {
  runId: string;
  workflow: string;
  recordId: string;
  recordLabel?: string;
  parentRunId?: string;
  triggeredBy: 'http' | 'cron' | 'parent-orchestrator';
  forceRefresh?: boolean;
  model?: string;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'complete',
  'errored',
  'terminated',
  'timeout',
]);

const RECENT_LIMIT = 100;
const POLL_INTERVAL_MS = 3000;
// 100 KB ceiling so DO storage stays under its 128 KB per-key limit even after
// status / metadata fields are tacked onto the record.
const MAX_OUTPUT_BYTES = 100_000;

export class RunsHub extends DurableObject<Env> {
  private recent: RunRecord[] = [];
  private inflight = new Set<string>();
  private loaded = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      await this.load();
    });
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ensureLoaded();
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/ws') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected websocket', { status: 426 });
      }
      const channel = url.searchParams.get('channel');
      if (channel !== 'recent' && channel !== 'run') {
        return new Response('Invalid channel', { status: 400 });
      }
      const runId = channel === 'run' ? url.searchParams.get('runId') : null;
      if (channel === 'run' && !runId) {
        return new Response('Missing runId', { status: 400 });
      }
      return this.acceptWs(channel, runId ?? undefined);
    }

    if (path === '/run-started' && request.method === 'POST') {
      const body = (await request.json()) as RunStartedPayload;
      await this.runStarted(body);
      return new Response(null, { status: 204 });
    }

    if (path === '/snapshot' && request.method === 'GET') {
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 25)));
      return Response.json({ runs: this.recent.slice(0, limit) });
    }

    if (path.startsWith('/run/') && request.method === 'GET') {
      const id = path.slice('/run/'.length);
      const rec = await this.lookup(id);
      if (!rec) return new Response(null, { status: 404 });
      return Response.json({ run: rec });
    }

    return new Response('Not found', { status: 404 });
  }

  override async alarm(): Promise<void> {
    await this.ensureLoaded();
    if (this.inflight.size === 0) return;

    const ids = [...this.inflight];
    const before = new Map<string, RunRecord>();
    for (const id of ids) {
      const rec = await this.lookup(id);
      if (rec) before.set(id, rec);
      else this.inflight.delete(id); // unknown — drop it
    }

    const updates = await Promise.all(
      [...before.entries()].map(async ([id, rec]) => ({ id, rec, next: await this.poll(rec) })),
    );

    let listChanged = false;
    for (const { id, rec, next } of updates) {
      if (!hasMeaningfulDelta(rec, next)) continue;

      await this.ctx.storage.put(`run:${id}`, next);
      const idx = this.recent.findIndex((r) => r.runId === id);
      if (idx >= 0) {
        this.recent[idx] = next;
        listChanged = true;
      }

      if (TERMINAL_STATUSES.has(next.status)) {
        this.inflight.delete(id);
        this.broadcast(['recent', `run:${id}`], { type: 'run-completed', run: next });
        this.ctx.waitUntil(this.persistAirtable(next));
      } else {
        this.broadcast(['recent', `run:${id}`], { type: 'run-updated', run: next });
      }
    }

    if (listChanged) {
      await this.ctx.storage.put('recent', this.recent);
    }
    await this.ctx.storage.put('inflight', [...this.inflight]);

    if (this.inflight.size > 0) {
      await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  override async webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): Promise<void> {
    // No client → server protocol yet. The hub publishes; clients listen.
  }

  override async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // The runtime cleans up tagged sockets automatically.
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // No-op.
  }

  // --- Internals ----------------------------------------------------------

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async load(): Promise<void> {
    const recent = (await this.ctx.storage.get<RunRecord[]>('recent')) ?? [];
    const inflight = (await this.ctx.storage.get<string[]>('inflight')) ?? [];
    this.recent = recent;
    this.inflight = new Set(inflight);
    this.loaded = true;
  }

  private async lookup(runId: string): Promise<RunRecord | undefined> {
    const cached = this.recent.find((r) => r.runId === runId);
    if (cached) return cached;
    return (await this.ctx.storage.get<RunRecord>(`run:${runId}`)) ?? undefined;
  }

  private async runStarted(payload: RunStartedPayload): Promise<void> {
    if (this.recent.some((r) => r.runId === payload.runId)) {
      // Idempotent: workflow step retries can re-fire run-started.
      return;
    }
    const rec: RunRecord = {
      runId: payload.runId,
      workflow: payload.workflow,
      recordId: payload.recordId,
      recordLabel: payload.recordLabel,
      parentRunId: payload.parentRunId,
      triggeredBy: payload.triggeredBy,
      forceRefresh: payload.forceRefresh ?? false,
      model: payload.model,
      startedAt: new Date().toISOString(),
      status: 'queued',
    };
    this.recent = [rec, ...this.recent].slice(0, RECENT_LIMIT);
    this.inflight.add(rec.runId);
    await this.ctx.storage.put(`run:${rec.runId}`, rec);
    await this.ctx.storage.put('recent', this.recent);
    await this.ctx.storage.put('inflight', [...this.inflight]);

    this.broadcast(['recent', `run:${rec.runId}`], { type: 'run-started', run: rec });

    // Schedule the first poll quickly so 'queued' → 'running' shows up fast.
    await this.ctx.storage.setAlarm(Date.now() + 1000);
  }

  private async poll(rec: RunRecord): Promise<RunRecord> {
    const binding = workflowBinding(this.env, rec.workflow);
    if (!binding) {
      return { ...rec, status: 'unknown' };
    }
    try {
      const inst = await binding.get(rec.runId);
      const status = await inst.status();
      const statusName = (status as { status?: string }).status ?? 'unknown';
      const baseError = (status as { error?: unknown }).error;
      const rawOutput = (status as { output?: unknown }).output;

      let error = rec.error;
      if (baseError) {
        const captured = await getCapturedError(this.env, rec.runId);
        if (captured) {
          error = { name: captured.name, message: captured.message, stack: captured.stack };
        } else if (typeof baseError === 'object' && baseError !== null) {
          const e = baseError as Record<string, unknown>;
          error = {
            name: typeof e['name'] === 'string' ? (e['name'] as string) : 'Error',
            message:
              typeof e['message'] === 'string' ? (e['message'] as string) : String(baseError),
            stack: typeof e['stack'] === 'string' ? (e['stack'] as string) : undefined,
          };
        } else {
          error = { name: 'Error', message: String(baseError) };
        }
      }

      const nextOutput = clampOutput(rawOutput ?? rec.output);
      const next: RunRecord = {
        ...rec,
        status: statusName,
        error,
        output: nextOutput,
        confidence: extractConfidence(nextOutput) ?? rec.confidence,
      };
      if (TERMINAL_STATUSES.has(statusName)) {
        next.finishedAt = new Date().toISOString();
        next.durationMs = Date.parse(next.finishedAt) - Date.parse(rec.startedAt);
      }
      return next;
    } catch (err) {
      return {
        ...rec,
        status: 'unknown',
        error:
          rec.error ??
          {
            name: 'PollError',
            message: err instanceof Error ? err.message : String(err),
          },
      };
    }
  }

  private acceptWs(channel: 'recent' | 'run', runId?: string): Promise<Response> {
    const pair = new WebSocketPair();
    const tag = channel === 'recent' ? 'recent' : `run:${runId}`;
    this.ctx.acceptWebSocket(pair[1], [tag]);

    if (channel === 'recent') {
      pair[1].send(
        JSON.stringify({ type: 'snapshot', channel: 'recent', runs: this.recent }),
      );
      return Promise.resolve(new Response(null, { status: 101, webSocket: pair[0] }));
    }

    // Per-run snapshot: prefer the in-memory recent list, fall back to durable
    // storage for runs that have rolled off the recent cap.
    return (async () => {
      const rec = await this.lookup(runId!);
      try {
        pair[1].send(
          JSON.stringify({ type: 'snapshot', channel: 'run', run: rec ?? null }),
        );
      } catch {
        // Connection raced to close; nothing to do.
      }
      return new Response(null, { status: 101, webSocket: pair[0] });
    })();
  }

  private broadcast(tags: string[], message: object): void {
    const payload = JSON.stringify(message);
    const seen = new Set<WebSocket>();
    for (const tag of tags) {
      for (const ws of this.ctx.getWebSockets(tag)) {
        if (seen.has(ws)) continue;
        seen.add(ws);
        try {
          ws.send(payload);
        } catch {
          // Runtime cleans up broken sockets.
        }
      }
    }
  }

  private async persistAirtable(rec: RunRecord): Promise<void> {
    if (rec.airtableRowId) return;
    try {
      const airtableRowId = await appendRunRow(this.env, rec);
      const updated = { ...rec, airtableRowId };
      await this.ctx.storage.put(`run:${rec.runId}`, updated);
      const idx = this.recent.findIndex((r) => r.runId === rec.runId);
      if (idx >= 0) {
        this.recent[idx] = updated;
        await this.ctx.storage.put('recent', this.recent);
      }
    } catch (err) {
      console.error('[RunsHub] failed to write Airtable row', rec.runId, String(err));
    }
  }
}

function hasMeaningfulDelta(prev: RunRecord, next: RunRecord): boolean {
  if (prev.status !== next.status) return true;
  if (prev.finishedAt !== next.finishedAt) return true;
  if (JSON.stringify(prev.error ?? null) !== JSON.stringify(next.error ?? null)) return true;
  if (JSON.stringify(prev.output ?? null) !== JSON.stringify(next.output ?? null)) return true;
  return false;
}

function clampOutput(output: unknown): unknown {
  if (output == null) return output;
  const json = JSON.stringify(output);
  if (json.length <= MAX_OUTPUT_BYTES) return output;
  return {
    truncated: true,
    note: `Output exceeded ${MAX_OUTPUT_BYTES} bytes; full payload available in Cloudflare Workflows.`,
    preview: json.slice(0, 2000),
  };
}
