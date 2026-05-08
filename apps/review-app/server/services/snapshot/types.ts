// ---------------------------------------------------------------------------
// Shared types for the daily-stats snapshot pipeline.
// ---------------------------------------------------------------------------

export const SNAPSHOTS_QUEUE_NAME = 'aeci-review-snapshots';

/** Message shape for the SNAPSHOTS_QUEUE producer/consumer. */
export type SnapshotJob = {
  kind: 'daily-stats-snapshot';
  triggeredBy: 'cron' | 'http';
  /** Override snapshot date (UTC YYYY-MM-DD). Defaults to "today" in UTC. */
  date?: string;
};
