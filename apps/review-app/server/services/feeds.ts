// ---------------------------------------------------------------------------
// RSS / Atom feed parsing for V05 Press (Google News RSS) and V06 Blog Recency.
// ---------------------------------------------------------------------------
import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  title?: string;
  link?: string;
  pubDate?: string; // ISO string after parse
  description?: string;
  source?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export async function fetchFeed(url: string, timeoutMs = 10_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'aeci-review' },
    });
    if (!res.ok) throw new Error(`Feed fetch ${url} failed: ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

export function parseRssOrAtom(xml: string): FeedItem[] {
  const data = parser.parse(xml) as Record<string, unknown>;
  // RSS 2.0
  const rss = (data['rss'] as Record<string, unknown> | undefined)?.['channel'] as
    | Record<string, unknown>
    | undefined;
  if (rss) {
    const items = ([] as unknown[]).concat(rss['item'] ?? []);
    return items.map((item) => itemFromRss(item as Record<string, unknown>));
  }
  // Atom
  const feed = data['feed'] as Record<string, unknown> | undefined;
  if (feed) {
    const entries = ([] as unknown[]).concat(feed['entry'] ?? []);
    return entries.map((entry) => itemFromAtom(entry as Record<string, unknown>));
  }
  return [];
}

function itemFromRss(item: Record<string, unknown>): FeedItem {
  const date = item['pubDate'] as string | undefined;
  const isoDate = date ? safeIso(date) : undefined;
  const source = item['source'];
  return {
    title: typeof item['title'] === 'string' ? (item['title'] as string) : undefined,
    link: typeof item['link'] === 'string' ? (item['link'] as string) : undefined,
    pubDate: isoDate,
    description: typeof item['description'] === 'string' ? (item['description'] as string) : undefined,
    source:
      typeof source === 'string'
        ? source
        : typeof (source as Record<string, unknown>)?.['#text'] === 'string'
          ? ((source as Record<string, unknown>)['#text'] as string)
          : undefined,
  };
}

function itemFromAtom(entry: Record<string, unknown>): FeedItem {
  const link = entry['link'];
  let href: string | undefined;
  if (Array.isArray(link)) {
    const first = link[0] as Record<string, unknown> | undefined;
    href = (first?.['@_href'] as string) ?? undefined;
  } else if (typeof link === 'object' && link) {
    href = (link as Record<string, unknown>)['@_href'] as string | undefined;
  }
  const updated = entry['updated'] as string | undefined;
  const published = entry['published'] as string | undefined;
  const date = published ?? updated;
  return {
    title: typeof entry['title'] === 'string' ? (entry['title'] as string) : undefined,
    link: href,
    pubDate: date ? safeIso(date) : undefined,
  };
}

function safeIso(input: string): string | undefined {
  const d = new Date(input);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

export function googleNewsRssUrl(query: string): string {
  const params = new URLSearchParams({ q: query, hl: 'en-US', gl: 'US', ceid: 'US:en' });
  return `https://news.google.com/rss/search?${params.toString()}`;
}

export function daysAgo(iso: string): number | undefined {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return undefined;
  return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}
