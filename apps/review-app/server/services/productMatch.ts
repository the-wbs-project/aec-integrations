// ---------------------------------------------------------------------------
// productMatch
//
// Shared dedupe primitive for products. Two callers:
//   1. createProductAndStartOrchestrator — runs this BEFORE inserting a new
//      product so we can refuse to create likely duplicates.
//   2. The MCP `find_product` tool — exposes the same logic so playbooks can
//      look up an existing record by candidate name / website / vendor before
//      they decide to create.
//
// Matching is name-normalization + hostname comparison. No fuzzy distance
// metrics — just the cheap signals that catch the common failure modes:
//   • "Bluebeam Revu" vs "Bluebeam Revu, Inc."
//   • "ACC" vs "Autodesk Construction Cloud" — handled when the candidate
//     and existing product share the same vendor and one normalized name is
//     a token-subset of the other.
//   • "Procore" vs "procore.com" listed under different casing.
//
// Rejected products are never returned. The match info contains everything an
// LLM needs to either accept the existing record or pass `allow_duplicate` to
// override.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import { fetchProducts } from './airtable';
import { buildLookupMaps, hydrateProduct } from '../hydrate';
import type { Product } from '../types';

/**
 * Normalize a product name for comparison. Lowercases, strips common legal
 * suffixes, drops punctuation, and collapses whitespace. Returns "" for input
 * that normalizes away entirely (e.g. just punctuation).
 */
export function normalizeName(name: string): string {
  if (!name) return '';
  let n = name.toLowerCase().trim();
  // Strip trailing legal suffixes — repeated until nothing more to strip
  // (handles "Acme, Inc., LLC.").
  for (let i = 0; i < 3; i++) {
    const before = n;
    n = n.replace(
      /[\s,]*\b(inc|incorporated|llc|l\.l\.c\.|ltd|limited|corp|corporation|co|company|gmbh|ag|sa|s\.a\.|plc|pty|bv|nv|kk)\.?$/i,
      '',
    );
    if (n === before) break;
  }
  // Drop all non-alphanumeric (kills punctuation, hyphens, slashes).
  n = n.replace(/[^a-z0-9]+/g, ' ').trim();
  // Collapse internal whitespace.
  n = n.replace(/\s+/g, ' ');
  return n;
}

/**
 * Extract a normalized hostname from a URL string. Lowercases, strips a
 * leading "www.", and returns undefined when the input isn't a parseable URL.
 * Accepts bare hostnames ("acme.com") by trying with an "https://" prefix.
 */
export function normalizeHostname(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  const candidates = /^[a-z]+:\/\//i.test(trimmed)
    ? [trimmed]
    : [`https://${trimmed}`, trimmed];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      if (host) return host;
    } catch {
      // try next
    }
  }
  return undefined;
}

export type MatchConfidence = 'high' | 'medium' | 'low';

export interface ProductMatchSummary {
  id: string;
  name: string;
  website?: string;
  vendors: { id: string; name: string }[];
  description?: string;
  researchStatus?: string;
  promotionStatus?: string;
}

export interface ProductMatch {
  product: ProductMatchSummary;
  confidence: MatchConfidence;
  reasons: string[];
}

export interface FindProductMatchesInput {
  name?: string;
  website?: string;
  vendorId?: string;
}

const MAX_RESULTS = 10;

function summarize(product: Product): ProductMatchSummary {
  return {
    id: product.id,
    name: product.name,
    website: product.website,
    vendors: product.vendors.map((v) => ({ id: v.id, name: v.name })),
    description: product.description,
    researchStatus: product.researchStatus,
    promotionStatus: product.promotionStatus,
  };
}

function tokens(normalized: string): Set<string> {
  if (!normalized) return new Set();
  return new Set(normalized.split(' ').filter((t) => t.length > 1));
}

function isTokenSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/**
 * Score a single candidate against the input. Returns null if no signal.
 * Confidence ranking:
 *   • high   — exact normalized-name match; OR hostname match;
 *              OR same vendor + one normalized name is a token-subset of the other.
 *   • medium — token-subset match across vendors (no shared hostname).
 *   • low    — raw substring containment on the lowercased name.
 */
function scoreCandidate(
  product: Product,
  inputNorm: string,
  inputHost: string | undefined,
  inputVendorId: string | undefined,
  inputTokens: Set<string>,
): ProductMatch | null {
  const reasons: string[] = [];
  let confidence: MatchConfidence | null = null;

  const productNorm = normalizeName(product.name);
  const productHost = normalizeHostname(product.website);
  const productTokens = tokens(productNorm);
  const sharesVendor =
    !!inputVendorId && product.vendors.some((v) => v.id === inputVendorId);

  // --- High-confidence signals ---------------------------------------------
  if (inputNorm && productNorm && inputNorm === productNorm) {
    confidence = 'high';
    reasons.push(`normalized name match ("${productNorm}")`);
  }
  if (inputHost && productHost && inputHost === productHost) {
    confidence = 'high';
    reasons.push(`website hostname match (${productHost})`);
  }
  if (
    sharesVendor &&
    inputTokens.size > 0 &&
    productTokens.size > 0 &&
    (isTokenSubset(inputTokens, productTokens) ||
      isTokenSubset(productTokens, inputTokens))
  ) {
    confidence = 'high';
    reasons.push('shared vendor + name is a token subset');
  }

  // --- Medium-confidence signals -------------------------------------------
  if (
    !confidence &&
    inputTokens.size > 0 &&
    productTokens.size > 0 &&
    (isTokenSubset(inputTokens, productTokens) ||
      isTokenSubset(productTokens, inputTokens))
  ) {
    confidence = 'medium';
    reasons.push('one normalized name is a token subset of the other');
  }

  // --- Low-confidence signals ----------------------------------------------
  if (!confidence && inputNorm && productNorm) {
    if (productNorm.includes(inputNorm) || inputNorm.includes(productNorm)) {
      confidence = 'low';
      reasons.push('substring match on normalized name');
    }
  }

  if (!confidence) return null;
  return { product: summarize(product), confidence, reasons };
}

const CONFIDENCE_RANK: Record<MatchConfidence, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

/**
 * Find existing products that look like duplicates of the input. Caller
 * provides at least one of name/website. Rejected products are filtered out.
 * Results are sorted by confidence (high → low) and capped at MAX_RESULTS.
 */
export async function findProductMatches(
  env: Env,
  input: FindProductMatchesInput,
): Promise<ProductMatch[]> {
  const name = input.name?.trim();
  const website = input.website?.trim();
  if (!name && !website) return [];

  const inputNorm = name ? normalizeName(name) : '';
  const inputHost = normalizeHostname(website);
  const inputTokens = tokens(inputNorm);
  // No usable signal — bail rather than scanning the table for nothing.
  if (!inputNorm && !inputHost) return [];

  const [records, maps] = await Promise.all([
    fetchProducts(env),
    buildLookupMaps(env),
  ]);

  const matches: ProductMatch[] = [];
  for (const r of records) {
    if (r.get('promotion_status') === 'rejected') continue;
    const product = hydrateProduct(r, maps);
    const m = scoreCandidate(
      product,
      inputNorm,
      inputHost,
      input.vendorId,
      inputTokens,
    );
    if (m) matches.push(m);
  }

  matches.sort((a, b) => {
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    return a.product.name.localeCompare(b.product.name);
  });

  return matches.slice(0, MAX_RESULTS);
}
