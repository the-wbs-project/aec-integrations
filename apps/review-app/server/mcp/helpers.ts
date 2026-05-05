// ---------------------------------------------------------------------------
// Shared helpers for MCP tool handlers.
//
// MCP tools return `{ content: [{ type: 'text', text: '...' }] }` blocks.
// LLMs prefer compact, non-prose JSON, so we stringify the payload directly
// and trust the caller to JSON.parse it. Errors flip `isError: true`.
//
// The MCP SDK's tool callback type expects `[key: string]: unknown` on the
// return shape, so these helpers return plain object literals (no named
// interface) — matching the inline shape used in the original agent.
// ---------------------------------------------------------------------------
export function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

export function err(message: string) {
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: message }],
  };
}

export function toMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// Rejected-product filtering.
//
// MCP tools must never expose products with promotion_status="rejected" —
// not as primary records, and not as nested LinkRefs / summaries. The web
// app still needs to see rejected products (curators triage them), so the
// filter lives here at the MCP layer instead of in hydrate.ts.
// ---------------------------------------------------------------------------
export function buildRejectedProductIds(
  productRecords: { id: string; get(field: string): unknown }[],
): Set<string> {
  const set = new Set<string>();
  for (const r of productRecords) {
    if (r.get('promotion_status') === 'rejected') set.add(r.id);
  }
  return set;
}
