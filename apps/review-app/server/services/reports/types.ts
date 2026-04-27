// ---------------------------------------------------------------------------
// Shared types for the weekly cost report pipeline.
// ---------------------------------------------------------------------------

/** Message shape for the REPORTS_QUEUE producer/consumer. */
export type ReportJob =
  | { kind: 'weekly-cost-report'; triggeredBy: 'cron' | 'http'; lookbackDays?: number };

/** Per-workflow row used in both AI Gateway and SearchAPI sections. */
export interface WorkflowCostRow {
  workflow: string;
  calls: number;
  costUsd: number;
}

/** Aggregated summary for one source (AI Gateway or SearchAPI). */
export interface CostSummary {
  rows: WorkflowCostRow[];
  totalCalls: number;
  totalCostUsd: number;
  /** Items we couldn't attribute to a workflow (no metadata). */
  unattributedCalls: number;
  unattributedCostUsd: number;
  /** Notes/warnings to surface in the email (e.g. paging cutoff). */
  notes: string[];
}
