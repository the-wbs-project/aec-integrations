// ---------------------------------------------------------------------------
// Capterra product page parser. Extracts review count + average rating from
// the page's structured data.
//
// Capterra ships JSON-LD with @type "Product" and an aggregateRating object
// ({ ratingValue, reviewCount }) on every product page. Microdata is
// inconsistent — sometimes present, sometimes JS-rendered only. Visible
// text ("4.6 (1,234)") is the last-resort backstop.
// ---------------------------------------------------------------------------

export interface CapterraSnapshot {
  ratingValue: number | null;
  reviewCount: number | null;
}

const JSON_LD_BLOCK = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const META_RATING = /<meta[^>]+itemprop=["']ratingValue["'][^>]+content=["']([^"']+)["']/i;
const META_REVIEWS = /<meta[^>]+itemprop=["']reviewCount["'][^>]+content=["']([^"']+)["']/i;
// Capterra commonly renders "4.6 (1,234)" or "(1,234 reviews)". Accept either.
const VISIBLE_RATING = /(\d(?:\.\d+)?)\s*(?:out\s*of\s*5|\/\s*5)/i;
const VISIBLE_REVIEWS = /\(\s*([\d,]+)\s*(?:reviews?)?\s*\)/i;

interface AggregateRating {
  ratingValue?: number | string;
  reviewCount?: number | string;
  ratingCount?: number | string;
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
  const type = obj['@type'];
  if (type === 'AggregateRating' || (Array.isArray(type) && type.includes('AggregateRating'))) {
    return obj as AggregateRating;
  }
  const direct = obj['aggregateRating'];
  if (direct && typeof direct === 'object') {
    return direct as AggregateRating;
  }
  for (const key of Object.keys(obj)) {
    const found = findAggregateRating(obj[key]);
    if (found) return found;
  }
  return null;
}

function fromJsonLd(html: string): CapterraSnapshot | null {
  let match: RegExpExecArray | null;
  JSON_LD_BLOCK.lastIndex = 0;
  while ((match = JSON_LD_BLOCK.exec(html)) !== null) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const agg = findAggregateRating(parsed);
    if (!agg) continue;
    const ratingValue = asPositiveNumber(agg.ratingValue);
    // Capterra sometimes uses ratingCount instead of reviewCount.
    const reviewCount =
      asPositiveNumber(agg.reviewCount) ?? asPositiveNumber(agg.ratingCount);
    if (ratingValue !== null || reviewCount !== null) {
      return { ratingValue, reviewCount };
    }
  }
  return null;
}

function fromMicrodata(html: string): CapterraSnapshot | null {
  const ratingMatch = html.match(META_RATING);
  const reviewsMatch = html.match(META_REVIEWS);
  if (!ratingMatch && !reviewsMatch) return null;
  return {
    ratingValue: ratingMatch ? asPositiveNumber(ratingMatch[1]) : null,
    reviewCount: reviewsMatch ? asPositiveNumber(reviewsMatch[1]) : null,
  };
}

function fromVisibleText(html: string): CapterraSnapshot | null {
  const ratingMatch = html.match(VISIBLE_RATING);
  const reviewsMatch = html.match(VISIBLE_REVIEWS);
  if (!ratingMatch && !reviewsMatch) return null;
  return {
    ratingValue: ratingMatch ? asPositiveNumber(ratingMatch[1]) : null,
    reviewCount: reviewsMatch ? asPositiveNumber(reviewsMatch[1]) : null,
  };
}

/**
 * Parse a Capterra product page. Returns whatever signal is recoverable.
 * Returns both nulls when the page yields nothing — caller treats that as
 * "fall through to T04 LLM fallback".
 */
export function parseCapterraProductPage(html: string): CapterraSnapshot {
  const merged: CapterraSnapshot = { ratingValue: null, reviewCount: null };
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
