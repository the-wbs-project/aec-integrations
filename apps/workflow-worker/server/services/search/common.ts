// ---------------------------------------------------------------------------
// Shared helpers for the search providers (ported from apps/n8n-utils).
// ---------------------------------------------------------------------------

export function stripFavicons(raw: Record<string, unknown>): void {
  const organic = raw['organic_results'];
  if (!Array.isArray(organic)) return;
  for (const result of organic) {
    if (result && typeof result === 'object') {
      delete (result as Record<string, unknown>)['favicon'];
    }
  }
}

export function paramsToQueryString(params: Record<string, string>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) search.append(k, v);
  return search.toString();
}
