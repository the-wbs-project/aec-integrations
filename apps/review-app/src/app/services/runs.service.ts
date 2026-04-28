// ---------------------------------------------------------------------------
// Recent runs service.
//
// Single source of truth for the notification bell + /runs page. Subscribes to
// the worker's `/api/runs/ws?channel=recent` WebSocket and applies snapshot
// + delta events to a signal-backed runs() list. Components consume the
// runs() and inFlightCount() signals — they don't open WebSockets themselves.
//
// On disconnect we reconnect with exponential backoff (1s → 30s) and rely on
// the server's snapshot-on-connect to resync state.
// ---------------------------------------------------------------------------
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { RunStartRequest, RunStartResponse } from './workflow-client';

const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated', 'timeout']);

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECENT_LIMIT = 100;

export interface RecentRunRow {
  runId: string;
  workflow: string;
  recordId: string;
  recordLabel?: string;
  parentRunId?: string;
  triggeredBy?: string;
  forceRefresh?: boolean;
  model?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  status: string;
  error?: { name?: string; message?: string; stack?: string } | string | unknown;
  output?: unknown;
  /**
   * Self-reported confidence from research workflows. When status is
   * 'complete' but confidence is 'low' the UI renders the run with an amber
   * pill so a curator can spot best-effort completions at a glance.
   */
  confidence?: 'high' | 'medium' | 'low';
}

type HubEvent =
  | { type: 'snapshot'; channel: 'recent'; runs: RecentRunRow[] }
  | { type: 'snapshot'; channel: 'run'; run: RecentRunRow | null }
  | { type: 'run-started'; run: RecentRunRow }
  | { type: 'run-updated'; run: RecentRunRow }
  | { type: 'run-completed'; run: RecentRunRow };

@Injectable({ providedIn: 'root' })
export class RunsService {
  private http = inject(HttpClient);
  private destroyRef = inject(DestroyRef);

  private readonly _runs = signal<RecentRunRow[]>([]);
  readonly runs = this._runs.asReadonly();

  /** Number of runs that are not in a terminal state. */
  readonly inFlightCount = computed(() =>
    this._runs().filter((r) => !TERMINAL_STATUSES.has(r.status)).length,
  );

  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private started = false;

  constructor() {
    this.destroyRef.onDestroy(() => this.stop());
  }

  /** Begin streaming. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  /**
   * No-op kept for API compatibility — pushes were polled before; now they
   * arrive over the WebSocket so an explicit refresh is unnecessary.
   */
  refresh(): void {
    // intentionally empty
  }

  /**
   * Spawn a workflow run; the hub broadcasts `run-started` over the WebSocket
   * so callers don't need to subscribe to the response. We subscribe
   * internally with no-op handlers so the HTTP request actually fires even
   * when the call site (e.g. EnrichSplitButton) doesn't subscribe.
   */
  startRun(workflow: string, body: RunStartRequest) {
    const obs = this.http.post<RunStartResponse>(`/api/workflows/${workflow}/run`, body);
    obs.subscribe({ next: () => undefined, error: () => undefined });
    return obs;
  }

  // --- Internals ----------------------------------------------------------

  private connect(): void {
    if (!this.started) return;
    this.clearReconnect();

    const url = this.wsUrl('recent');
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onmessage = (ev) => this.handleMessage(ev.data);
    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_INITIAL_MS;
    };
    socket.onerror = () => {
      // No remediation here — onclose follows and triggers reconnect.
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = null;
      this.scheduleReconnect();
    };
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let event: HubEvent;
    try {
      event = JSON.parse(data) as HubEvent;
    } catch {
      return;
    }

    switch (event.type) {
      case 'snapshot':
        if (event.channel === 'recent') {
          this._runs.set(event.runs ?? []);
        }
        return;
      case 'run-started':
      case 'run-updated':
      case 'run-completed':
        this.upsert(event.run);
        return;
    }
  }

  private upsert(row: RecentRunRow): void {
    const current = this._runs();
    const idx = current.findIndex((r) => r.runId === row.runId);
    if (idx === -1) {
      // Newest first; cap to recent limit so memory stays bounded.
      this._runs.set([row, ...current].slice(0, RECENT_LIMIT));
      return;
    }
    const next = current.slice();
    next[idx] = { ...current[idx], ...row };
    this._runs.set(next);
  }

  private wsUrl(channel: 'recent'): string {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}/api/runs/ws?channel=${channel}`;
  }

  private scheduleReconnect(): void {
    if (!this.started) return;
    this.clearReconnect();
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private stop(): void {
    this.started = false;
    this.clearReconnect();
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }
}
