export function formatDate(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Returns a short relative-time string for a past timestamp:
 *   "just now", "5 min ago", "3 hr ago", "2 days ago", "3 mo ago", "2 yr ago".
 * Returns '' for invalid or future dates.
 */
export function relativeTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 0) return '';

  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(days / 365);
  return `${years} yr ago`;
}

export function formatDateWithRelative(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = formatDate(iso);
  const rel = relativeTime(iso);
  return rel ? `${d} (${rel})` : d;
}
