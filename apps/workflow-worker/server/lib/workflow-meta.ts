// ---------------------------------------------------------------------------
// Workflow metadata. Every workflow exports a `meta` object alongside its
// WorkflowEntrypoint class. The metadata powers:
//   - GET /api/workflows                — listing
//   - GET /api/workflows/:name/options  — grouped record picker
//   - the routes/registry → binding-name map
// ---------------------------------------------------------------------------
import type { AirtableTables } from '../env';

export type AirtableTableKey = keyof AirtableTables;

/**
 * Optional grouped-picker config. When present, the runner UI renders three
 * buckets (missing primaryField / stale / recent) instead of a free-text
 * record-id input.
 */
export interface WorkflowOptionsConfig {
  primaryField: string;
  stalenessField: string;
  labelField: string;
  staleAfterDays?: number;
}

export interface WorkflowMeta {
  /** Stable URL slug (e.g. 'tool-api-check'). */
  slug: string;
  /** Short description, surfaced by GET /api/workflows. */
  description: string;
  /** The table this workflow's record_id belongs to. */
  table: AirtableTableKey;
  /** Optional grouped-picker config. */
  options?: WorkflowOptionsConfig;
}

/** Params every WorkflowRunner instance receives via `env.WF.create({ params })`. */
export interface RunParams {
  recordId: string;
  model: string;
  searchTool: 'web' | 'serpapi';
  searchProvider: 'serpapi' | 'searchapi';
}
