/**
 * Map an enrichment status string to a badge variant token.
 * Shared by the vendors list/detail and tools list/detail pages so the
 * same status reads as the same color across the app.
 */
export type BadgeVariant = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export function enrichmentVariant(status: string | undefined | null): BadgeVariant {
  if (!status) return 'neutral';
  const s = status.toLowerCase();
  if (s === 'enriched' || s === 'success' || s === 'complete' || s === 'completed') return 'success';
  if (s === 'partial' || s === 'in_progress' || s === 'pending' || s === 'queued') return 'warning';
  if (s === 'error' || s === 'failed' || s === 'failure') return 'danger';
  if (s === 'skipped' || s === 'stale') return 'info';
  return 'neutral';
}
