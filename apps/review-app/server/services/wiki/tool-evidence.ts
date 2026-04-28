// ---------------------------------------------------------------------------
// Tool evidence pre-fetch. Mirrors vendor-evidence.ts but targets the
// SoftwareApplication / G2 / Capterra signals that matter for tool research.
// ---------------------------------------------------------------------------
import type { Env } from '../../env';
import { fetchHtml } from '../web/fetch';
import {
  extractJsonLd,
  pickSoftwareApplication,
  type SoftwareApplicationLd,
} from '../web/jsonld';
import { findWikipediaSummary, fetchInfobox } from '../wikipedia';
import { runSerpSearch, pickOrganicResults, type OrganicResult } from '../search';
import type { SerpAttribution } from '../search';

const PRODUCT_PATHS = ['/', '/about', '/product', '/features'];

export interface ToolEvidence {
  dossier: string;
  citations: string[];
  websiteCandidate?: string;
}

export async function gatherToolEvidence(
  env: Env,
  attribution: SerpAttribution,
  input: { name: string; website?: string; vendor?: string },
): Promise<ToolEvidence> {
  const tasks: Promise<unknown>[] = [];

  // Wikipedia for the tool itself (likely uncommon, but cheap).
  const wikiPromise = (async () => {
    const summary = await findWikipediaSummary(input.name, ['', '_(software)']);
    if (!summary) return null;
    const infobox = await fetchInfobox(summary.title);
    return { summary, infobox };
  })();
  tasks.push(wikiPromise);

  // Vendor's product/about pages.
  const productPromise = (async () => {
    if (!input.website) return [] as SoftwareApplicationLd[];
    let origin: string;
    try {
      origin = new URL(input.website).origin;
    } catch {
      return [] as SoftwareApplicationLd[];
    }
    const fetched = await Promise.all(PRODUCT_PATHS.map((p) => fetchHtml(origin + p)));
    const apps: SoftwareApplicationLd[] = [];
    for (const page of fetched) {
      if (!page) continue;
      const items = extractJsonLd(page.body);
      const app = pickSoftwareApplication(items);
      if (app) apps.push(app);
    }
    return apps;
  })();
  tasks.push(productPromise);

  // Targeted SearchAPI queries — bias towards AEC qualifiers and review sites.
  const vendorQualifier = input.vendor ? `"${input.vendor}"` : '';
  const searchPromise = Promise.all(
    [
      `"${input.name}" ${vendorQualifier} site:g2.com`,
      `"${input.name}" ${vendorQualifier} site:capterra.com`,
      `"${input.name}" ${vendorQualifier} "AEC" OR "BIM" OR "construction"`,
    ]
      .map((q) => q.trim().replace(/\s+/g, ' '))
      .map((q) =>
        runSerpSearch(env, { q }, attribution).then((res) =>
          res.status === 200 ? { query: q, results: pickOrganicResults(res.body, 5) } : null,
        ),
      ),
  );
  tasks.push(searchPromise);

  const [wiki, products, searchResults] = (await Promise.all(tasks)) as [
    { summary: { title: string; extract: string; canonicalUrl: string }; infobox: Awaited<ReturnType<typeof fetchInfobox>> } | null,
    SoftwareApplicationLd[],
    Array<{ query: string; results: OrganicResult[] } | null>,
  ];

  return formatDossier(input, wiki, products, searchResults);
}

function formatDossier(
  input: { name: string; website?: string; vendor?: string },
  wiki: { summary: { title: string; extract: string; canonicalUrl: string }; infobox: Awaited<ReturnType<typeof fetchInfobox>> } | null,
  products: SoftwareApplicationLd[],
  searchResults: Array<{ query: string; results: OrganicResult[] } | null>,
): ToolEvidence {
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
  } else {
    lines.push('### Wikipedia');
    lines.push('- No Wikipedia page found for this tool.');
    lines.push('');
  }

  if (products.length > 0) {
    lines.push('### Tool website (JSON-LD SoftwareApplication)');
    products.forEach((app, idx) => {
      lines.push(`Source ${idx + 1}:`);
      if (app.name) lines.push(`- name: ${app.name}`);
      if (app.url) {
        lines.push(`- url: ${app.url}`);
        if (!websiteCandidate) websiteCandidate = app.url;
      }
      if (app.description) lines.push(`- description: ${app.description}`);
      if (app.applicationCategory) lines.push(`- applicationCategory: ${app.applicationCategory}`);
      if (app.applicationSubCategory) lines.push(`- applicationSubCategory: ${app.applicationSubCategory}`);
      if (app.publisher) lines.push(`- publisher: ${app.publisher}`);
      if (app.operatingSystem) lines.push(`- operatingSystem: ${app.operatingSystem}`);
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

function dedup(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.length > 0))];
}
