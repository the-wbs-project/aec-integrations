// ---------------------------------------------------------------------------
// Thin HTTP client for the workflow API.
// ---------------------------------------------------------------------------
import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface RunStartRequest {
  record_ids: string[];
  model: string;
  search_tool?: 'web' | 'serpapi';
  search_provider?: 'serpapi' | 'searchapi';
}

export interface RunStartResponse {
  runId: string;
  workflow: string;
  recordIds: string[];
  model: string;
}

export interface RunRecord {
  recordId: string;
  status: 'queued' | 'in_progress' | 'done' | 'error';
  turns: number;
  result?: unknown;
  error?: string;
  fieldsUpdated?: string[];
}

export interface RunStatus {
  runId: string;
  workflow: string;
  model: string;
  searchTool: 'web' | 'serpapi';
  searchProvider: 'serpapi' | 'searchapi';
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  step: number;
  batchId?: string;
  records: RunRecord[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
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

  getStatus(runId: string) {
    return this.http.get<RunStatus>(`/api/workflows/runs/${runId}`);
  }

  getOptions(workflow: string, refresh = false) {
    const url = `/api/workflows/${workflow}/options${refresh ? '?refresh=1' : ''}`;
    return this.http.get<OptionsResponse>(url);
  }
}
