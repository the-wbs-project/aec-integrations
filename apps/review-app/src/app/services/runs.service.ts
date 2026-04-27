// ---------------------------------------------------------------------------
// Recent runs service.
//
// Single source of truth for the notification bell + /runs page. Polls
// /api/runs/recent every POLL_MS while there are non-terminal runs in flight,
// and slows to LONG_POLL_MS when everything has settled. Components subscribe
// to `runs` (signal-style) and `inFlightCount` (computed) — they don't
// schedule their own polling.
// ---------------------------------------------------------------------------
import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { RunStartRequest, RunStartResponse } from './workflow-client';

const POLL_MS = 3_000;
const LONG_POLL_MS = 30_000;

const TERMINAL_STATUSES = new Set(['complete', 'errored', 'terminated']);

export interface RecentRunRow {
  runId: string;
  workflow: string;
  recordId: string;
  recordLabel?: string;
  startedAt: string;
  status: string;
  error?: unknown;
  output?: unknown;
}

interface RecentResponse {
  runs: RecentRunRow[];
}

@Injectable({ providedIn: 'root' })
export class RunsService {
  private http = inject(HttpClient);

  private readonly _runs = signal<RecentRunRow[]>([]);
  readonly runs = this._runs.asReadonly();

  /** Number of runs that are not in a terminal state. */
  readonly inFlightCount = computed(() =>
    this._runs().filter((r) => !TERMINAL_STATUSES.has(r.status)).length,
  );

  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;

  /** Begin polling. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.poll();
  }

  /** Force a refresh now (e.g. immediately after kicking off a run). */
  refresh(): void {
    this.fetchAndSchedule(POLL_MS);
  }

  /** Spawn a workflow run, then refresh so the bell picks it up immediately. */
  startRun(workflow: string, body: RunStartRequest) {
    const obs = this.http.post<RunStartResponse>(`/api/workflows/${workflow}/run`, body);
    obs.subscribe({
      next: () => this.refresh(),
      error: () => this.refresh(),
    });
    return obs;
  }

  private poll(): void {
    this.fetchAndSchedule();
  }

  private fetchAndSchedule(forceMs?: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.http.get<RecentResponse>('/api/runs/recent?limit=25').subscribe({
      next: (resp) => {
        this._runs.set(resp.runs ?? []);
        const next = forceMs ?? (this.inFlightCount() > 0 ? POLL_MS : LONG_POLL_MS);
        this.timer = setTimeout(() => this.poll(), next);
      },
      error: () => {
        // Back off on error; don't spam the worker if it's down.
        this.timer = setTimeout(() => this.poll(), LONG_POLL_MS);
      },
    });
  }
}
