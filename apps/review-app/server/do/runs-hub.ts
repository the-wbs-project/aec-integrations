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
import { listRecords, asString } from '../services/airtable';

export interface RunRecord {
  runId: string;
  workflow: string;
  recordId: string;
  recordLabel?: string;
  parentRunId?: string;
  triggeredBy: 'http' | 'mcp' | 'cron' | 'parent-orchestrator' | 'auto-enrich' | 'queue';
  forceRefresh: boolean;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: string;
  error?: { name: string; message: string; stack?: string };
  output?: unknown;
  airtableRowId?: string;
  /** True when this row mirrors a prompt_queue Airtable row (workflow="pb:*"). */
  isQueueJob?: boolean;
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
  triggeredBy: 'http' | 'mcp' | 'cron' | 'parent-orchestrator' | 'auto-enrich';
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

// Cadence for polling the Airtable prompt_queue table when no Cloudflare
// Workflow runs are inflight. The dispatcher itself runs every 10 minutes,
// so this just needs to be fast enough that bell users see queue rows
// appear / change state without feeling stuck.
const QUEUE_POLL_INTERVAL_MS = 30_000;
// How far back to consider terminal queue rows (so a job that completed since
// the last poll still shows up as "completed" in the bell).
const QUEUE_TERMINAL_LOOKBACK_MS = 5 * 60_000;
// Prefix that distinguishes queue-row runIds from Cloudflare Workflow UUIDs.
const QUEUE_RUN_ID_PREFIX = 'pb:';

// Map prompt_queue.status → RunRecord.status used by the bell UI.
function mapQueueStatus(raw: string): string {
  switch (raw) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'complete';
    case 'failed':
      return 'errored';
    default:
      return raw || 'unknown';
  }
}

// Coerce the queue's `requested_by` (free-form: "cron:…", "mcp:…", an email)
// into one of the RunRecord.triggeredBy union members so the UI badge stays
// stable.
function inferTriggeredBy(requestedBy: string | undefined): RunRecord['triggeredBy'] {
  if (!requestedBy) return 'queue';
  if (requestedBy.startsWith('cron:')) return 'cron';
  if (requestedBy.startsWith('mcp:')) return 'mcp';
  if (requestedBy.startsWith('http:')) return 'http';
  if (requestedBy.includes('@')) return 'http'; // user email — manual /prompts page click
  return 'queue';
}

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

    // Always reconcile prompt_queue rows so button-triggered jobs surface in
    // the bell alongside Cloudflare Workflow runs.
    try {
      await this.pollQueue();
    } catch (err) {
      console.error('[RunsHub] pollQueue failed', String(err));
    }

    // Poll Cloudflare Workflow instances only when there are inflight runs.
    if (this.inflight.size > 0) {
      const ids = [...this.inflight];
      const before = new Map<string, RunRecord>();
      for (const id of ids) {
        const rec = await this.lookup(id);
        if (rec) before.set(id, rec);
        else this.inflight.delete(id);
      }

      const updates = await Promise.all(
        [...before.entries()].map(async ([id, rec]) => ({
          id,
          rec,
          next: await this.poll(rec),
        })),
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
    }

    // Always reschedule. Workflow polling needs 3s cadence when something is
    // inflight; queue polling is fine at 30s. Pick the smaller interval so
    // the alarm covers both consumers.
    const nextDelay =
      this.inflight.size > 0 ? POLL_INTERVAL_MS : QUEUE_POLL_INTERVAL_MS;
    await this.ctx.storage.setAlarm(Date.now() + nextDelay);
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
    // The alarm is the only thing that re-pulls prompt_queue, so make sure
    // one is scheduled even when no Cloudflare Workflow runs are inflight.
    const existing = await this.ctx.storage.getAlarm();
    if (existing == null) {
      await this.ctx.storage.setAlarm(Date.now() + QUEUE_POLL_INTERVAL_MS);
    }
  }

  private async load(): Promise<void> {
    const recent = (await this.ctx.storage.get<RunRecord[]>('recent')) ?? [];
    const inflight = (await this.ctx.storage.get<string[]>('inflight')) ?? [];
    this.recent = recent;
    this.inflight = new Set(inflight);
    this.loaded = true;
  }

  // -------------------------------------------------------------------------
  // pollQueue — reconcile Airtable prompt_queue rows into `recent`.
  //
  // Fetches every pending/running row plus terminal rows that flipped within
  // QUEUE_TERMINAL_LOOKBACK_MS, maps them to RunRecord shape with a
  // "pb:<airtableId>" runId, and broadcasts deltas. Queue rows live entirely
  // outside the `inflight` set — this method is the only thing that polls
  // them, so the workflow-poll path never tries to call workflowBinding() on
  // a "pb:*" id.
  // -------------------------------------------------------------------------
  private async pollQueue(): Promise<void> {
    const cutoff = new Date(Date.now() - QUEUE_TERMINAL_LOOKBACK_MS).toISOString();
    const filter =
      `OR({status} = 'pending', {status} = 'running', ` +
      `AND(OR({status} = 'completed', {status} = 'failed'), ` +
      `IS_AFTER({completed_at}, '${cutoff}')))`;

    let rows: Awaited<ReturnType<typeof listRecords>>;
    try {
      rows = await listRecords(this.env, 'promptQueue', {
        filterByFormula: filter,
        fields: [
          'playbook_slug',
          'playbook_title',
          'status',
          'requested_by',
          'target_record_id',
          'aspect',
          'force_refresh',
          'created_at',
          'started_at',
          'completed_at',
          'result_summary',
          'error',
        ],
        sort: [{ field: 'created_at', direction: 'desc' }],
        maxRecords: RECENT_LIMIT,
      });
    } catch (err) {
      console.error('[RunsHub] queue listRecords failed', String(err));
      return;
    }

    let listChanged = false;
    for (const row of rows) {
      const queueRunId = `${QUEUE_RUN_ID_PREFIX}${row.id}`;
      const slug = asString(row.fields['playbook_slug']) ?? 'unknown';
      const title = asString(row.fields['playbook_title']);
      const rawStatus = asString(row.fields['status']) ?? 'pending';
      const status = mapQueueStatus(rawStatus);
      const targetRecordId = asString(row.fields['target_record_id']) ?? '';
      const requestedBy = asString(row.fields['requested_by']);
      const forceRefreshRaw = row.fields['force_refresh'];
      const forceRefresh = typeof forceRefreshRaw === 'boolean' ? forceRefreshRaw : false;
      const startedAt =
        asString(row.fields['started_at']) ??
        asString(row.fields['created_at']) ??
        new Date().toISOString();
      const completedAt = asString(row.fields['completed_at']);
      const errorMsg = asString(row.fields['error']);
      const summary = asString(row.fields['result_summary']);

      const next: RunRecord = {
        runId: queueRunId,
        workflow: `pb:${slug}`,
        recordId: targetRecordId,
        recordLabel: title ?? slug,
        triggeredBy: inferTriggeredBy(requestedBy),
        forceRefresh,
        startedAt,
        status,
        isQueueJob: true,
        ...(completedAt && TERMINAL_STATUSES.has(status)
          ? {
              finishedAt: completedAt,
              durationMs:
                Date.parse(completedAt) - Date.parse(startedAt) || undefined,
            }
          : {}),
        ...(errorMsg && status === 'errored'
          ? { error: { name: 'PlaybookError', message: errorMsg } }
          : {}),
        ...(summary ? { output: { summary } } : {}),
      };

      const existing = await this.lookup(queueRunId);
      if (!existing) {
        this.recent = [next, ...this.recent].slice(0, RECENT_LIMIT);
        listChanged = true;
        await this.ctx.storage.put(`run:${queueRunId}`, next);
        this.broadcast(['recent', `run:${queueRunId}`], { type: 'run-started', run: next });
        continue;
      }

      const merged: RunRecord = { ...existing, ...next };
      if (!queueDelta(existing, merged)) continue;

      const idx = this.recent.findIndex((r) => r.runId === queueRunId);
      if (idx >= 0) {
        this.recent[idx] = merged;
        listChanged = true;
      } else {
        this.recent = [merged, ...this.recent].slice(0, RECENT_LIMIT);
        listChanged = true;
      }
      await this.ctx.storage.put(`run:${queueRunId}`, merged);

      const eventType: 'run-updated' | 'run-completed' = TERMINAL_STATUSES.has(merged.status)
        ? 'run-completed'
        : 'run-updated';
      this.broadcast(['recent', `run:${queueRunId}`], { type: eventType, run: merged });
    }

    if (listChanged) {
      await this.ctx.storage.put('recent', this.recent);
    }
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

// Same comparison shape as hasMeaningfulDelta but tolerant of fields the
// queue path doesn't populate (no Cloudflare Workflow output payload).
function queueDelta(prev: RunRecord, next: RunRecord): boolean {
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
