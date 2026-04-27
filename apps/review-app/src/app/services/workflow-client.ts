// ---------------------------------------------------------------------------
// Thin HTTP client for the workflow API.
// ---------------------------------------------------------------------------
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface RunStartRequest {
  record_ids: string[];
  model: string;
  search_tool?: 'searchapi' | 'web';
}

export interface RunStartResponse {
  workflow: string;
  model: string;
  runs: Array<{ runId: string; recordId: string }>;
}

/**
 * Cloudflare Workflows InstanceStatus shape — what `instance.status()`
 * returns. Mirrored from @cloudflare/workers-types so the UI doesn't have
 * to depend on it.
 */
export interface InstanceStatus {
  runId: string;
  workflow: string;
  status:
    | 'queued'
    | 'running'
    | 'paused'
    | 'errored'
    | 'terminated'
    | 'complete'
    | 'waiting'
    | 'waitingForPause'
    | 'unknown';
  error?: { name: string; message: string };
  output?: unknown;
}

export interface OptionRecord {
  id: string;
  label: string;
}

export interface OptionGroup {
  key: 'missing' | 'stale' | 'recent';
  label: string;
  records: OptionRecord[];
}

export type OptionsResponse =
  | { supported: false }
  | {
      supported: true;
      table: string;
      primaryField: string;
      stalenessField: string;
      staleAfterDays: number;
      groups: OptionGroup[];
    };

@Injectable({ providedIn: 'root' })
export class WorkflowClient {
  private http = inject(HttpClient);

  startRun(workflow: string, body: RunStartRequest) {
    return this.http.post<RunStartResponse>(`/api/workflows/${workflow}/run`, body);
  }

  getStatus(workflow: string, runId: string) {
    return this.http.get<InstanceStatus>(`/api/workflows/${workflow}/runs/${runId}`);
  }

  getOptions(workflow: string, refresh = false) {
    const url = `/api/workflows/${workflow}/options${refresh ? '?refresh=1' : ''}`;
    return this.http.get<OptionsResponse>(url);
  }
}
