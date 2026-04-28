// ---------------------------------------------------------------------------
// Vendor evidence pre-fetch. Runs deterministically before the LLM loop
// when a vendor's wiki page is missing or stale. Hits Wikipedia, the
// vendor's own About pages, and a couple of targeted SearchAPI queries —
// in parallel — and produces a markdown dossier the LLM reads as primary
// evidence. With this in place most repeat runs need 0 LLM searches.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { fetchHtml } from '../web/fetch';
import { extractJsonLd, pickOrganization, type OrganizationLd } from '../web/jsonld';
import { findWikipediaSummary, fetchInfobox } from '../wikipedia';
import { runSerpSearch, pickOrganicResults, type OrganicResult } from '../search';
import type { SerpAttribution } from '../search';

const ABOUT_PATHS = ['/', '/about', '/about-us', '/company'];

export interface VendorEvidence {
  /** Markdown block injected into the LLM user prompt as primary evidence. */
  dossier: string;
  /** Source URLs we successfully fetched/cited — used to seed citations[]. */
  citations: string[];
  /**
   * Verified candidate URL (if any) for the vendor's website. Used by Tier 4
   * URL verification to overwrite stale website fields. Null when no
   * verifiable candidate was found.
   */
  websiteCandidate?: string;
}

export async function gatherVendorEvidence(
  env: Env,
  attribution: SerpAttribution,
  input: { name: string; website?: string },
): Promise<VendorEvidence> {
  const tasks: Promise<unknown>[] = [];

  // 1. Wikipedia summary + infobox.
  const wikiPromise = (async () => {
    const summary = await findWikipediaSummary(input.name);
    if (!summary) return null;
    const infoboxTitle = summary.title;
    const infobox = await fetchInfobox(infoboxTitle);
    return { summary, infobox };
  })();
  tasks.push(wikiPromise);

  // 2. About-page fan-out (only if a website hint is known).
  const aboutPromise = (async () => {
    if (!input.website) return [] as OrganizationLd[];
    let origin: string;
    try {
      origin = new URL(input.website).origin;
    } catch {
      return [] as OrganizationLd[];
    }
    const fetched = await Promise.all(
      ABOUT_PATHS.map((p) => fetchHtml(origin + p)),
    );
    const orgs: OrganizationLd[] = [];
    for (const page of fetched) {
      if (!page) continue;
      const items = extractJsonLd(page.body);
      const org = pickOrganization(items);
      if (org) orgs.push(org);
    }
    return orgs;
  })();
  tasks.push(aboutPromise);

  // 3. Targeted SearchAPI queries (parallel).
  const searchPromise = Promise.all(
    [
      `"${input.name}" site:wikipedia.org`,
      `"${input.name}" site:crunchbase.com`,
      `"${input.name}" "headquartered" OR "founded"`,
    ].map((q) =>
      runSerpSearch(env, { q }, attribution).then((res) =>
        res.status === 200 ? { query: q, results: pickOrganicResults(res.body, 5) } : null,
      ),
    ),
  );
  tasks.push(searchPromise);

  const [wiki, abouts, searchResults] = (await Promise.all(tasks)) as [
    { summary: { title: string; extract: string; canonicalUrl: string }; infobox: Awaited<ReturnType<typeof fetchInfobox>> } | null,
    OrganizationLd[],
    Array<{ query: string; results: OrganicResult[] } | null>,
  ];

  return formatDossier(input, wiki, abouts, searchResults);
}

function formatDossier(
  input: { name: string; website?: string },
  wiki: { summary: { title: string; extract: string; canonicalUrl: string }; infobox: Awaited<ReturnType<typeof fetchInfobox>> } | null,
  abouts: OrganizationLd[],
  searchResults: Array<{ query: string; results: OrganicResult[] } | null>,
): VendorEvidence {
  const lines: string[] = [];
  const citations: string[] = [];
  let websiteCandidate: string | undefined;

  lines.push('## Pre-fetched evidence dossier');
  lines.push('');
  lines.push('The following sources were retrieved deterministically before this turn. Trust them as primary evidence; use web_search ONLY if a fact you need is missing or you suspect it is stale.');
  lines.push('');

  if (wiki) {
    lines.push('### Wikipedia');
    lines.push(`- Title: ${wiki.summary.title}`);
    lines.push(`- URL: ${wiki.summary.canonicalUrl}`);
    citations.push(wiki.summary.canonicalUrl);
    lines.push('');
    lines.push('Extract:');
    lines.push(`> ${wiki.summary.extract.replace(/\n/g, ' ')}`);
    lines.push('');
    if (wiki.infobox) {
      lines.push('Infobox fields:');
      const ib = wiki.infobox;
      if (ib.headquarters) lines.push(`- headquarters: ${ib.headquarters}`);
      if (ib.foundedYear) lines.push(`- founded: ${ib.foundedYear}`);
      if (ib.parent) lines.push(`- parent: ${ib.parent}`);
      if (ib.industry) lines.push(`- industry: ${ib.industry}`);
      if (ib.subsidiaries) lines.push(`- subsidiaries: ${ib.subsidiaries}`);
      if (ib.website) {
        lines.push(`- website: ${ib.website}`);
        if (!websiteCandidate) websiteCandidate = normalizeWebsite(ib.website);
      }
      lines.push('');
    }
  } else {
    lines.push('### Wikipedia');
    lines.push('- No Wikipedia page found for this vendor.');
    lines.push('');
  }

  if (abouts.length > 0) {
    lines.push('### Vendor website (JSON-LD Organization)');
    abouts.forEach((org, idx) => {
      lines.push(`Source ${idx + 1}:`);
      if (org.name) lines.push(`- name: ${org.name}`);
      if (org.url) {
        lines.push(`- url: ${org.url}`);
        if (!websiteCandidate) websiteCandidate = normalizeWebsite(org.url);
      }
      if (org.description) lines.push(`- description: ${org.description}`);
      if (org.foundingDate) lines.push(`- foundingDate: ${org.foundingDate}`);
      if (org.address) lines.push(`- address: ${org.address}`);
      if (org.parentOrganization) lines.push(`- parentOrganization: ${org.parentOrganization}`);
      if (org.sameAs && org.sameAs.length > 0) {
        lines.push(`- sameAs: ${org.sameAs.join(', ')}`);
        for (const link of org.sameAs) citations.push(link);
      }
      lines.push('');
    });
    if (input.website) citations.push(input.website);
  }

  const nonNullSearches = searchResults.filter((r): r is { query: string; results: OrganicResult[] } => r !== null);
  if (nonNullSearches.length > 0) {
    lines.push('### Targeted search results (top 5 organic per query)');
    for (const { query, results } of nonNullSearches) {
      lines.push(`Query: \`${query}\``);
      if (results.length === 0) {
        lines.push('- (no results)');
      } else {
        for (const r of results) {
          if (r.link) citations.push(r.link);
          lines.push(`- ${r.title ?? '(no title)'} — ${r.link ?? ''}`);
          if (r.snippet) lines.push(`  ${r.snippet}`);
        }
      }
      lines.push('');
    }
  }

  return {
    dossier: lines.join('\n'),
    citations: dedup(citations),
    websiteCandidate,
  };
}

function normalizeWebsite(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9.-]+\.[a-z]{2,}/i.test(trimmed)) return `https://${trimmed}`;
  return undefined;
}

function dedup(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.length > 0))];
}
