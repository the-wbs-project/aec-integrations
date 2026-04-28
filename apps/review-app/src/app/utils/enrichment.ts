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

/**
 * Map a run's status + confidence to a badge variant. Forced-emit results
 * from the research workflows complete with status='complete' but
 * confidence='low' — render those as warning (amber) so curators can see
 * at a glance that the run was a best-effort completion.
 */
export function runStatusVariant(
  status: string | undefined | null,
  confidence?: 'high' | 'medium' | 'low' | null,
): BadgeVariant {
  const base = enrichmentVariant(status);
  if (base === 'success' && confidence === 'low') return 'warning';
  return base;
}
