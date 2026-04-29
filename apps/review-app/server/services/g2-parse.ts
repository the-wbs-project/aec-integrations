// ---------------------------------------------------------------------------
// G2 product page parser. Extracts review count + average rating from the
// page's structured data.
//
// G2 ships at least three places where the rating lives, in rough order of
// reliability:
//   1. JSON-LD <script type="application/ld+json"> with @type "Product" and
//      an aggregateRating object: { ratingValue, reviewCount }.
//   2. Microdata <meta itemprop="ratingValue"> / itemprop="reviewCount">.
//   3. The visible header text ("4.5 out of 5 (1,234 reviews)").
//
// We prefer (1), fall back to (2). (3) is a last-resort string match —
// brittle, so we only use it if the first two yield nothing AND the page
// contains a clear "out of 5" pattern.
// ---------------------------------------------------------------------------

export interface G2Snapshot {
  ratingValue: number | null;
  reviewCount: number | null;
}

const JSON_LD_BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_RATING = /<meta[^>]+itemprop=["']ratingValue["'][^>]+content=["']([^"']+)["']/i;
const META_REVIEWS = /<meta[^>]+itemprop=["']reviewCount["'][^>]+content=["']([^"']+)["']/i;
const VISIBLE_RATING = /(\d(?:\.\d+)?)\s*out\s*of\s*5/i;
const VISIBLE_REVIEWS = /\(\s*([\d,]+)\s+reviews?\s*\)/i;

interface AggregateRating {
  ratingValue?: number | string;
  reviewCount?: number | string;
}

function asPositiveNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string') {
    const cleaned = v.replace(/,/g, '').trim();
    const n = Number(cleaned);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function findAggregateRating(node: unknown): AggregateRating | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findAggregateRating(child);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  // Direct hit: any object with @type === 'AggregateRating' or that itself
  // has an aggregateRating field.
  const type = obj['@type'];
  if (type === 'AggregateRating' || (Array.isArray(type) && type.includes('AggregateRating'))) {
    return obj as AggregateRating;
  }
  const direct = obj['aggregateRating'];
  if (direct && typeof direct === 'object') {
    return direct as AggregateRating;
  }
  // Recurse — JSON-LD often wraps things in a @graph array.
  for (const key of Object.keys(obj)) {
    const found = findAggregateRating(obj[key]);
    if (found) return found;
  }
  return null;
}

function fromJsonLd(html: string): G2Snapshot | null {
  let match: RegExpExecArray | null;
  JSON_LD_BLOCK.lastIndex = 0;
  while ((match = JSON_LD_BLOCK.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some pages embed multiple JSON objects in a single script — skip.
      continue;
    }
    const agg = findAggregateRating(parsed);
    if (!agg) continue;
    const ratingValue = asPositiveNumber(agg.ratingValue);
    const reviewCount = asPositiveNumber(agg.reviewCount);
    if (ratingValue !== null || reviewCount !== null) {
      return { ratingValue, reviewCount };
    }
  }
  return null;
}

function fromMicrodata(html: string): G2Snapshot | null {
  const ratingMatch = html.match(META_RATING);
  const reviewsMatch = html.match(META_REVIEWS);
  if (!ratingMatch && !reviewsMatch) return null;
  return {
    ratingValue: ratingMatch ? asPositiveNumber(ratingMatch[1]) : null,
    reviewCount: reviewsMatch ? asPositiveNumber(reviewsMatch[1]) : null,
  };
}

function fromVisibleText(html: string): G2Snapshot | null {
  const ratingMatch = html.match(VISIBLE_RATING);
  const reviewsMatch = html.match(VISIBLE_REVIEWS);
  if (!ratingMatch && !reviewsMatch) return null;
  return {
    ratingValue: ratingMatch ? asPositiveNumber(ratingMatch[1]) : null,
    reviewCount: reviewsMatch ? asPositiveNumber(reviewsMatch[1]) : null,
  };
}

/**
 * Parse a G2 product page. Returns whatever signal is recoverable. Returns
 * a snapshot with both fields null when the page yields nothing — the caller
 * should treat that as "fall through to T04 LLM fallback".
 */
export function parseG2ProductPage(html: string): G2Snapshot {
  // Sanity bound: rating must be between 1.0 and 5.0; clamp anything else to null.
  const merged: G2Snapshot = { ratingValue: null, reviewCount: null };
  for (const candidate of [fromJsonLd(html), fromMicrodata(html), fromVisibleText(html)]) {
    if (!candidate) continue;
    if (merged.ratingValue === null && candidate.ratingValue !== null) {
      const r = candidate.ratingValue;
      merged.ratingValue = r >= 1 && r <= 5 ? r : null;
    }
    if (merged.reviewCount === null && candidate.reviewCount !== null) {
      merged.reviewCount = candidate.reviewCount;
    }
    if (merged.ratingValue !== null && merged.reviewCount !== null) break;
  }
  return merged;
}
