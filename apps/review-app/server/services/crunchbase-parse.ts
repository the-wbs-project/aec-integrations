// ---------------------------------------------------------------------------
// Crunchbase organization-page parser. Pure: takes rendered HTML, returns a
// typed snapshot. No network, no env. Safe to unit-test from fixtures.
//
// Strategy:
//   Crunchbase wraps every label/value pair in `<div class="tile-field">`,
//   with the label inside `.wrappable-label-with-info` (or
//   `.field-type-label`) and the value as the remaining text. We collect all
//   tile-fields into a label→value map, then read named fields off it. This
//   is far more stable than text-blob regexes — Crunchbase rotates obfuscated
//   CSS class hashes but keeps these semantic class names.
//
// Fields not in tile-fields (description, hero scores, lists block) get
// per-section regexes against the stripped text.
// ---------------------------------------------------------------------------

export interface CrunchbaseSnapshot {
  legalName: string | null;
  alsoKnownAs: string | null;
  operatingStatus: string | null;
  companyType: string | null;
  publicPrivate: string | null;
  description: string | null;
  headquarters: string | null;
  parentCompany: string | null;
  /** Headcount range Crunchbase shows as a small "51-100" pill. Maps to Airtable `company_size`. */
  headcountRange: string | null;
  website: string | null;
  industries: string[];
  phoneNumber: string | null;
  contactEmail: string | null;

  cbRank: number | null;
  growthScore: number | null;
  heatScore: number | null;
  monthlyWebVisits: number | null;
  lists: CrunchbaseList[];
}

export interface CrunchbaseList {
  name: string;
  countOrgs?: number;
  /** Kept verbatim ("$823.8B") because units vary; downstream consumers parse if they need to. */
  totalFunding?: string;
  countInvestors?: number;
}

/**
 * Parse a Crunchbase organization page. Returns a snapshot with `null` /
 * empty arrays for fields that weren't found. Never throws.
 */
export function parseCrunchbaseHtml(html: string): CrunchbaseSnapshot {
  const tiles = extractTileFields(html);
  const enums = extractFieldTypeEnums(html);
  const text = stripHtml(html);

  return {
    legalName: tiles.get('legal name') ?? null,
    alsoKnownAs: tiles.get('also known as') ?? null,
    operatingStatus: tiles.get('operating status') ?? null,
    companyType: tiles.get('company type') ?? null,
    publicPrivate: pickPublicPrivate(enums),
    description: extractDescription(html, text),
    headquarters: extractHeadquarters(text),
    parentCompany: extractParentCompany(html) ?? extractParentFromText(text),
    headcountRange: pickHeadcountRange(enums),
    website: extractWebsite(text),
    industries: extractIndustriesFromAnchors(html),
    phoneNumber: cleanPhone(tiles.get('phone number') ?? null),
    contactEmail: tiles.get('contact email') ?? null,
    cbRank: extractScore(text, 'CB Rank', /^\d[\d,]*$/, { allowLarge: true }),
    growthScore: extractScore(text, 'Growth Score', /^\d{1,3}$/),
    heatScore: extractScore(text, 'Heat Score', /^\d{1,3}$/),
    monthlyWebVisits: extractMonthlyWebVisits(text),
    lists: extractLists(text),
  };
}

/**
 * True when the snapshot meets the "successful scrape" bar — at least 3 of
 * {description, headquarters, headcountRange, phoneNumber, contactEmail}
 * extracted. Below this, the workflow falls through to the LLM/leaf
 * fallback.
 */
export function isSnapshotUseful(snapshot: CrunchbaseSnapshot): boolean {
  let count = 0;
  if (snapshot.description) count++;
  if (snapshot.headquarters) count++;
  if (snapshot.headcountRange) count++;
  if (snapshot.phoneNumber) count++;
  if (snapshot.contactEmail) count++;
  return count >= 3;
}

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

/** Strip tags, decode entities, collapse whitespace. Used by section regexes. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n+/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Pull every `<div class="tile-field">…</div>` from the HTML and extract its
 * label and value. Crunchbase emits these for ~80% of the structured facts
 * (Details block, Funding Rounds count, Sub-Orgs count, etc.).
 *
 * Returns a Map keyed by lowercased label, value-trimmed. If the same label
 * appears twice (Crunchbase repeats some tiles in mobile/desktop variants),
 * the first occurrence wins.
 */
export function extractTileFields(html: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match each tile-field div, including any nested divs. Reluctant body
  // match isn't enough (nested divs would close early) — we balance manually
  // with a tag counter.
  const tileRe = /<div\b[^>]*class=("[^"]*\btile-field\b[^"]*"|'[^']*\btile-field\b[^']*')[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tileRe.exec(html)) !== null) {
    const start = match.index + match[0].length;
    const end = findClosingTagEnd(html, start, 'div');
    if (end < 0) continue;
    const tileHtml = html.slice(start, end);
    const { label, value } = parseTileFieldInner(tileHtml);
    if (label && value && !map.has(label)) {
      map.set(label, value);
    }
  }
  return map;
}

function parseTileFieldInner(tileHtml: string): { label: string | null; value: string | null } {
  // Label lives in `.wrappable-label-with-info` or `.field-type-label`.
  const labelRe = /<(?:span|div)\b[^>]*class=("[^"]*(?:wrappable-label-with-info|field-type-label)[^"]*"|'[^']*(?:wrappable-label-with-info|field-type-label)[^']*')[^>]*>/i;
  const labelMatch = tileHtml.match(labelRe);
  if (!labelMatch || labelMatch.index === undefined) {
    return { label: null, value: null };
  }
  const labelStart = labelMatch.index + labelMatch[0].length;
  const labelTag = labelMatch[0].startsWith('<span') ? 'span' : 'div';
  const labelEnd = findClosingTagEnd(tileHtml, labelStart, labelTag);
  if (labelEnd < 0) return { label: null, value: null };

  const labelText = stripHtml(tileHtml.slice(labelStart, labelEnd)).trim().toLowerCase();
  // Value is the rest of the tile after the label closes. Strip remaining
  // tags and collapse whitespace.
  const remaining = tileHtml.slice(labelEnd);
  // Closing label tag is `</span>` or `</div>`; skip past it.
  const valueText = stripHtml(remaining.replace(new RegExp(`^\\s*</${labelTag}>`, 'i'), ''))
    .replace(/\s+/g, ' ')
    .trim();
  return { label: labelText || null, value: valueText || null };
}

/**
 * Given a position in `html` immediately after an opening tag, find the
 * index of the end of the matching closing tag (just past `</tag>`). Returns
 * -1 if not found. Handles nested same-tag elements.
 */
function findClosingTagEnd(html: string, startAfterOpen: number, tag: string): number {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
  openRe.lastIndex = startAfterOpen;
  closeRe.lastIndex = startAfterOpen;
  let depth = 1;
  while (depth > 0) {
    const nextOpen = openRe.exec(html);
    const nextClose = closeRe.exec(html);
    if (!nextClose) return -1;
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth++;
      closeRe.lastIndex = nextOpen.index + nextOpen[0].length;
      continue;
    }
    depth--;
    if (depth === 0) return nextClose.index + nextClose[0].length;
    openRe.lastIndex = nextClose.index + nextClose[0].length;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// DOM-aware extractors. These read structural class names / hrefs from the
// rendered HTML rather than guessing from stripped text — much more stable
// against layout changes (the .field-type-enum and category-anchor patterns
// have been consistent on Crunchbase for years).
// ---------------------------------------------------------------------------

/**
 * Pull every `.field-type-enum` value from the page. Crunchbase uses this
 * class for every enum-style field in the hero pill row: public/private
 * status ("Private"), operating status ("Active"), company type ("For
 * Profit"), and the headcount range ("101-250"). The wrapping element is
 * `<span>` for plain enums and `<a>` for clickable ones (e.g. headcount
 * links to a search) — we match either.
 */
export function extractFieldTypeEnums(html: string): string[] {
  const re = /<(span|a)\b[^>]*class=("[^"]*\bfield-type-enum\b[^"]*"|'[^']*\bfield-type-enum\b[^']*')[^>]*>([\s\S]*?)<\/\1>/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const value = stripHtml(m[3]).trim();
    if (value) out.push(value);
  }
  return out;
}

const PUBLIC_PRIVATE_VALUES = new Set(['Public', 'Private', 'Subsidiary', 'Nonprofit']);

function pickPublicPrivate(enums: string[]): string | null {
  for (const v of enums) {
    const normalized = v.replace(/Non[- ]Profit/i, 'Nonprofit');
    if (PUBLIC_PRIVATE_VALUES.has(normalized)) return normalized;
  }
  return null;
}

function pickHeadcountRange(enums: string[]): string | null {
  for (const v of enums) {
    // Crunchbase headcount pills look like "1-10", "51-100", "1001-5000"
    // — exact "lo-hi" with sane bounds.
    const m = v.match(/^(\d{1,6})-(\d{1,6})$/);
    if (!m) continue;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    if (lo > 0 && hi > lo && hi <= 1_000_000) return v;
  }
  return null;
}

/**
 * Extract industry tags via the canonical Crunchbase category anchor:
 *   <a href="/search/organizations/field/organization/categories/<slug>">
 *     <span>Risk Management</span>
 *   </a>
 * Stable across vendors and rendering — every industry chip is one of these
 * anchors. Replaces the old whitelist-based text walker, which silently
 * dropped any industry not in our hardcoded list.
 */
export function extractIndustriesFromAnchors(html: string): string[] {
  const re = /<a\b[^>]*href=("[^"]*\/categories\/[^"\s]+"|'[^']*\/categories\/[^'\s]+')[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtml(m[2]).trim();
    if (!text) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Pull "Acquired by <Parent>" from the hero meta row. Crunchbase renders this
 * as a `<span>Acquired by</span>` immediately followed by a
 * `<field-formatter>` element holding the parent's name.
 */
export function extractParentCompany(html: string): string | null {
  // Match the literal label, then capture the next <field-formatter>'s text.
  const re = /<span\b[^>]*>\s*Acquired by\s*<\/span>\s*<field-formatter\b[^>]*>([\s\S]*?)<\/field-formatter>/i;
  const m = html.match(re);
  if (!m) return null;
  const name = stripHtml(m[1]).trim();
  return name.length > 0 && name.length < 120 ? name : null;
}

/**
 * Hero description lives in `<span class="expanded-only-content">…</span>`
 * — Crunchbase's collapsed-card layout. We try this first; the older "About
 * the Company" block (still present for some vendors) is the fallback.
 */
function extractDescription(html: string, text: string): string | null {
  // Hero `.expanded-only-content` first — appears on every modern profile.
  const heroRe = /<span\b[^>]*class=("[^"]*\bexpanded-only-content\b[^"]*"|'[^']*\bexpanded-only-content\b[^']*')[^>]*>([\s\S]*?)<\/span>/i;
  const heroMatch = html.match(heroRe);
  if (heroMatch?.[2]) {
    const cleaned = cleanProse(stripHtml(heroMatch[2]));
    if (cleaned.length >= 20) return cleaned;
  }

  // Legacy fallback: the "About the Company" block (still present on some
  // older vendor profiles).
  const aboutRe = /About the Company\s+(.+?)\s+Read More\b/is;
  const aboutMatch = text.match(aboutRe);
  if (aboutMatch?.[1]) return cleanProse(aboutMatch[1]);

  return null;
}

function cleanProse(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\.\s*Read More\.?$/i, '')
    .trim();
}

function extractHeadquarters(text: string): string | null {
  // The FAQ block at the bottom is the most reliable source — it answers
  // "Where is X's headquarters?" in plain prose.
  const m = text.match(/Where is\s+[^?]+?\s+headquarters\?\s*[^.]+? is located in\s+([^.]+?)\./i);
  return m?.[1]?.trim() ?? null;
}

/**
 * Legacy fallback: some vendor profiles use "Sub-Organization Of <name>"
 * instead of the "Acquired by" label. Kept as a backstop when the DOM-based
 * `extractParentCompany` returns null.
 */
function extractParentFromText(text: string): string | null {
  const m = text.match(/Sub-?\s*Organization Of\s+([^\n]+?)\s+(?:Industries|Operating Status|Founded|Headquarters)/i);
  return m?.[1]?.trim() ?? null;
}

function extractWebsite(text: string): string | null {
  // The website chip sits between the headcount pill and the industry list.
  const m = text.match(/\b\d+-\d+\s+((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+)/i);
  if (!m) return null;
  const raw = m[1].trim();
  return raw.startsWith('http') ? raw : `https://${raw}`;
}

function cleanPhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  // Must contain at least 7 digits to be a real phone number; otherwise the
  // tile probably grabbed something unexpected.
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 ? trimmed : null;
}

interface ScoreOpts { allowLarge?: boolean }
function extractScore(
  text: string,
  label: string,
  validate: RegExp,
  opts: ScoreOpts = {},
): number | null {
  // Crunchbase emits "Growth Score\n52" pattern in stripped text. We anchor
  // on the label, capture the next non-empty token, and validate against
  // the supplied regex (e.g. 1-3 digits for 0-100 scores).
  const re = new RegExp(`${escapeRegex(label)}\\s+([\\d,]+)`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const raw = m[1];
  if (!validate.test(raw)) return null;
  const n = parseInt(raw.replace(/,/g, ''), 10);
  if (!Number.isFinite(n)) return null;
  if (!opts.allowLarge && (n < 0 || n > 100)) return null;
  return n;
}

function extractMonthlyWebVisits(text: string): number | null {
  const m = text.match(/Monthly Web Visits\s+([\d,]+)/i);
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Extract the "Lists Featuring This Company" block. Each list is rendered
 * as three text segments:
 *   <list name>
 *   <count> Number of Organizations  •  <funding> Total Funding Amount  •  <count> Number of Investors
 *   Track
 *
 * We anchor on "Lists Featuring This Company" (the section heading, which
 * appears later than the navbar reference) and parse rows until we hit
 * "View All" or the next section.
 */
function extractLists(text: string): CrunchbaseList[] {
  // Crunchbase's nav contains "Lists Featuring This Company" as a link, so
  // there are usually two occurrences. The block content always follows the
  // *last* occurrence.
  const lastIdx = text.lastIndexOf('Lists Featuring This Company');
  if (lastIdx < 0) return [];
  const slice = text.slice(lastIdx);
  const stop = slice.search(/\b(?:View All|Sub-Organizations|Frequently Asked Questions)\b/);
  const body = stop >= 0 ? slice.slice(0, stop) : slice;

  const lists: CrunchbaseList[] = [];
  // Each row's data tile is unique and has the three " • " separated stats.
  // We split on "Track" (the per-list CTA at the end of every row).
  const rows = body.split(/\bTrack\b/);
  for (const row of rows) {
    const trimmed = row.replace(/^Lists Featuring This Company\s*/i, '').trim();
    if (!trimmed) continue;
    const orgsM = trimmed.match(/([\d,]+)\s+Number of Organizations/i);
    const fundingM = trimmed.match(/(\$[\d.]+[KMBT]?)\s+Total Funding Amount/i);
    const investorsM = trimmed.match(/([\d,]+)\s+Number of Investors/i);

    // Name is everything before the first numeric tile.
    const firstTileIdx = trimmed.search(/\s[\d,]+\s+Number of Organizations/i);
    const name = (firstTileIdx > 0 ? trimmed.slice(0, firstTileIdx) : trimmed.split(/\n/)[0])
      .trim()
      .replace(/^[•\s]+|[•\s]+$/g, '');
    if (!name || name.length > 200) continue;

    const list: CrunchbaseList = { name };
    if (orgsM) list.countOrgs = parseIntSafe(orgsM[1]);
    if (fundingM) list.totalFunding = fundingM[1];
    if (investorsM) list.countInvestors = parseIntSafe(investorsM[1]);

    // Only keep rows that actually had at least one stat — protects against
    // false positives like the section heading itself.
    if (list.countOrgs !== undefined || list.totalFunding || list.countInvestors !== undefined) {
      lists.push(list);
    }
  }
  return lists;
}

function parseIntSafe(s: string): number | undefined {
  const n = parseInt(s.replace(/,/g, ''), 10);
  return Number.isFinite(n) ? n : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
