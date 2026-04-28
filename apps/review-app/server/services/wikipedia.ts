// ---------------------------------------------------------------------------
// Wikipedia REST + MediaWiki API client. Used by Tier 2 evidence pre-fetch
// to get a structured first-pass on vendor / tool facts before involving
// the LLM. Both endpoints are public and unauthenticated.
//
// The REST summary returns a 1-paragraph extract; the MediaWiki parse
// endpoint returns wikitext we regex-mine for the infobox (headquarters,
// founded, parent, website, etc).
// ---------------------------------------------------------------------------

const REST_BASE = 'https://en.wikipedia.org/api/rest_v1';
const ACTION_BASE = 'https://en.wikipedia.org/w/api.php';

const WIKI_HEADERS: Record<string, string> = {
  'User-Agent': 'aeci-review (chris@aecintegrations.com)',
  Accept: 'application/json',
};

export interface WikipediaSummary {
  title: string;
  extract: string;
  canonicalUrl: string;
}

export interface WikipediaInfobox {
  /** Raw key/value pairs as scraped from the wikitext. Lowercased keys. */
  fields: Record<string, string>;
  /** Convenience: parsed `headquarters` field, plain text. */
  headquarters?: string;
  /** Convenience: 4-digit `founded` year if present. */
  foundedYear?: number;
  parent?: string;
  website?: string;
  industry?: string;
  /** Most companies have a list of subsidiaries — kept as a single joined string. */
  subsidiaries?: string;
}

/**
 * Look up a Wikipedia page summary by title. Tries the title verbatim, then
 * "<title> (company)" and "<title> (software)" so common AEC vendors and
 * products with disambiguated pages still resolve.
 */
export async function findWikipediaSummary(
  title: string,
  variants: string[] = ['', '_(company)', '_(software)'],
  timeoutMs = 8_000,
): Promise<WikipediaSummary | null> {
  for (const v of variants) {
    const t = encodeURIComponent(title.replace(/\s+/g, '_') + v);
    const url = `${REST_BASE}/page/summary/${t}`;
    const res = await timedFetch(url, timeoutMs);
    if (!res || !res.ok) continue;
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) continue;
    const type = body['type'];
    // Disambiguation pages have type='disambiguation' — skip and try the next variant.
    if (type === 'disambiguation') continue;
    const extract = typeof body['extract'] === 'string' ? (body['extract'] as string) : '';
    const titleStr = typeof body['title'] === 'string' ? (body['title'] as string) : title;
    const contentUrls = body['content_urls'] as Record<string, unknown> | undefined;
    const desktop = contentUrls?.['desktop'] as Record<string, unknown> | undefined;
    const canonicalUrl =
      typeof desktop?.['page'] === 'string' ? (desktop['page'] as string) : `https://en.wikipedia.org/wiki/${t}`;
    if (extract.length === 0) continue;
    return { title: titleStr, extract, canonicalUrl };
  }
  return null;
}

/**
 * Fetch and regex-extract the infobox from a Wikipedia article's wikitext.
 * Bails to null if the page has no infobox or the section-0 wikitext is
 * unreachable.
 */
export async function fetchInfobox(
  title: string,
  timeoutMs = 8_000,
): Promise<WikipediaInfobox | null> {
  const url =
    `${ACTION_BASE}?action=parse&page=${encodeURIComponent(title.replace(/\s+/g, '_'))}` +
    `&prop=wikitext&section=0&format=json&formatversion=2`;
  const res = await timedFetch(url, timeoutMs);
  if (!res || !res.ok) return null;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const parse = body?.['parse'] as Record<string, unknown> | undefined;
  const wikitext = parse?.['wikitext'];
  if (typeof wikitext !== 'string') return null;
  const infoboxRaw = extractInfoboxBlock(wikitext);
  if (!infoboxRaw) return null;
  const fields = parseInfoboxFields(infoboxRaw);
  const founded = fields['founded'] ?? fields['foundation'] ?? '';
  const yearMatch = founded.match(/\b(1[6-9]\d{2}|20\d{2}|21\d{2})\b/);
  return {
    fields,
    headquarters: fields['headquarters'] || fields['hq_location'] || undefined,
    foundedYear: yearMatch ? Number(yearMatch[1]) : undefined,
    parent: fields['parent'] || undefined,
    website: fields['website'] || fields['homepage'] || undefined,
    industry: fields['industry'] || undefined,
    subsidiaries: fields['subsid'] || undefined,
  };
}

function extractInfoboxBlock(wikitext: string): string | null {
  // Find {{Infobox …}} (case-insensitive) and walk braces to its match.
  const start = wikitext.search(/\{\{\s*Infobox/i);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < wikitext.length - 1; i++) {
    if (wikitext[i] === '{' && wikitext[i + 1] === '{') {
      depth++;
      i++;
    } else if (wikitext[i] === '}' && wikitext[i + 1] === '}') {
      depth--;
      i++;
      if (depth === 0) return wikitext.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Walk infobox lines extracting `| key = value` pairs. Strips Wikipedia
 * markup (links, refs, templates) to plain text. Lossy on purpose — this
 * runs in a worker and we just need rough strings to feed the LLM.
 */
function parseInfoboxFields(infobox: string): Record<string, string> {
  const fields: Record<string, string> = {};
  // Split into top-level lines starting with "|".
  const lines = infobox.split(/\n/);
  let currentKey: string | null = null;
  let currentValue = '';
  for (const line of lines) {
    const m = line.match(/^\|\s*([a-zA-Z0-9_\- ]+?)\s*=\s*(.*)$/);
    if (m) {
      if (currentKey !== null) {
        fields[currentKey] = stripMarkup(currentValue);
      }
      currentKey = m[1].trim().toLowerCase();
      currentValue = m[2];
    } else if (currentKey !== null) {
      currentValue += '\n' + line;
    }
  }
  if (currentKey !== null) {
    fields[currentKey] = stripMarkup(currentValue);
  }
  return fields;
}

function stripMarkup(s: string): string {
  let out = s;
  // Drop <ref>…</ref> citations entirely.
  out = out.replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  out = out.replace(/<ref[^/]*\/>/gi, '');
  // Strip comments.
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  // {{URL|https://x}} → https://x
  out = out.replace(/\{\{\s*URL\s*\|\s*([^}|]+)[^}]*\}\}/gi, '$1');
  // Other templates: drop them (lossy — fine for a hint).
  out = out.replace(/\{\{[^{}]*\}\}/g, '');
  // Pipe-link [[A|B]] → B; plain link [[A]] → A.
  out = out.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
  out = out.replace(/\[\[([^\]]+)\]\]/g, '$1');
  // External-link [https://x label] → label
  out = out.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, '$2');
  // Bold/italic markers.
  out = out.replace(/'''/g, '').replace(/''/g, '');
  // <br> → space; remaining HTML tags dropped.
  out = out.replace(/<br\s*\/?>/gi, ', ');
  out = out.replace(/<[^>]+>/g, '');
  return out.trim();
}

async function timedFetch(url: string, timeoutMs: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { headers: WIKI_HEADERS, signal: ctrl.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
