// ---------------------------------------------------------------------------
// T0R — Tool overview (G2 / Capterra scrape-first).
//
// Fronts T04-Reviews. For one tool record:
//   1. Discover g2_url and capterra_url via single SERP per site (skipped
//      when curator already filled the field).
//   2. Scrape both via Scrapfly (asp + render_js, KV-cached 30d).
//   3. Parse JSON-LD / microdata / visible text for ratingValue + reviewCount.
//   4. Write whatever landed and mark `reviews_checked_at` so the orchestrator
//      skips T04-Reviews on the same run.
//   5. On any per-site failure, leave that site's fields untouched. If BOTH
//      sites failed, do not mark `reviews_checked_at` — let T04 LLM fallback
//      run.
//
// Curator-edited values are never overwritten for `g2_url`, `capterra_url`.
// Counts and ratings are always overwritten on a successful scrape (we want
// the freshest numbers).
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord, asString } from '../../services/airtable';
import { runSerpSearch, pickOrganicResults } from '../../services/search';
import { scrapeUrl } from '../../services/scrapfly';
import { parseG2ProductPage, type G2Snapshot } from '../../services/g2-parse';
import {
  parseCapterraProductPage,
  type CapterraSnapshot,
} from '../../services/capterra-parse';

export const meta: WorkflowMeta = {
  slug: 'tool-overview',
  description:
    'Scrape G2 + Capterra for review counts and ratings; falls back to LLM (T04) when both sites miss.',
  table: 'tools',
};

const G2_PRODUCT_URL = /^https?:\/\/(?:www\.)?g2\.com\/products\/([a-z0-9-]+)\/?/i;
const CAPTERRA_PRODUCT_URL =
  /^https?:\/\/(?:www\.)?capterra\.com\/p\/(\d+)\/([a-z0-9-]+)\/?/i;

interface SiteOutcome {
  url: string | null;
  snapshot: G2Snapshot | CapterraSnapshot | null;
  /** Did we get any usable signal from this site? */
  ok: boolean;
  error: string | null;
}

export class ToolOverviewWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;
    const ctx = { runId: event.instanceId, workflow: meta.slug };

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'tools', recordId),
    );

    const name =
      asString(record.fields['Name']) ?? asString(record.fields['name']) ?? '';
    if (!name) {
      return {
        status: 'success' as const,
        fieldsUpdated: [],
        note: 'Tool has no name; skipped',
      };
    }

    const existingG2Url = asString(record.fields['g2_url']);
    const existingCapterraUrl = asString(record.fields['capterra_url']);

    // ----- G2 ---------------------------------------------------------------
    const g2 = await runSite<G2Snapshot>({
      label: 'g2',
      curatorUrl: existingG2Url,
      step,
      discover: () => discoverG2Url(this.env, ctx, name),
      scrape: (url) =>
        scrapeUrl(this.env, url, {
          cacheKey: g2CacheKey(url),
        }),
      parse: parseG2ProductPage,
    });

    // ----- Capterra ---------------------------------------------------------
    const capterra = await runSite<CapterraSnapshot>({
      label: 'capterra',
      curatorUrl: existingCapterraUrl,
      step,
      discover: () => discoverCapterraUrl(this.env, ctx, name),
      scrape: (url) =>
        scrapeUrl(this.env, url, {
          cacheKey: capterraCacheKey(url),
        }),
      parse: parseCapterraProductPage,
    });

    // ----- Build update payload --------------------------------------------
    const fields: Record<string, unknown> = {};
    const fieldsUpdated: string[] = [];

    if (g2.ok && g2.snapshot) {
      if (g2.url && !existingG2Url) {
        fields['g2_url'] = g2.url;
        fieldsUpdated.push('g2_url');
      }
      if (g2.snapshot.ratingValue !== null) {
        fields['g2_rating'] = g2.snapshot.ratingValue;
        fieldsUpdated.push('g2_rating');
      }
      if (g2.snapshot.reviewCount !== null) {
        fields['g2_review_count'] = g2.snapshot.reviewCount;
        fieldsUpdated.push('g2_review_count');
      }
    }
    if (capterra.ok && capterra.snapshot) {
      if (capterra.url && !existingCapterraUrl) {
        fields['capterra_url'] = capterra.url;
        fieldsUpdated.push('capterra_url');
      }
      if (capterra.snapshot.ratingValue !== null) {
        fields['capterra_rating'] = capterra.snapshot.ratingValue;
        fieldsUpdated.push('capterra_rating');
      }
      if (capterra.snapshot.reviewCount !== null) {
        fields['capterra_review_count'] = capterra.snapshot.reviewCount;
        fieldsUpdated.push('capterra_review_count');
      }
    }

    // Only mark `reviews_checked_at` when at least one site succeeded — that
    // way the orchestrator's `justSatisfied` guard keeps T04 LLM fallback
    // running when both scrapes miss.
    const anySiteOk = g2.ok || capterra.ok;
    if (anySiteOk) {
      fields['reviews_checked_at'] = new Date().toISOString();
      fieldsUpdated.push('reviews_checked_at');
    }

    if (fieldsUpdated.length > 0) {
      await checkpoint(step, 'write-fields', () =>
        updateRecord(this.env, 'tools', recordId, fields),
      );
    }

    const noteParts: string[] = [];
    if (g2.ok) {
      noteParts.push(
        `G2 ${g2.snapshot?.reviewCount ?? '?'} reviews / ${g2.snapshot?.ratingValue ?? '?'}`,
      );
    } else {
      noteParts.push(`G2 miss${g2.error ? ` (${g2.error})` : ''}`);
    }
    if (capterra.ok) {
      noteParts.push(
        `Capterra ${capterra.snapshot?.reviewCount ?? '?'} / ${capterra.snapshot?.ratingValue ?? '?'}`,
      );
    } else {
      noteParts.push(`Capterra miss${capterra.error ? ` (${capterra.error})` : ''}`);
    }

    return {
      fields,
      fieldsUpdated,
      status: 'success' as const,
      note: noteParts.join(' · '),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function g2CacheKey(url: string): string {
  const m = url.match(G2_PRODUCT_URL);
  return m ? `g2:${m[1].toLowerCase()}` : `g2:url:${url}`;
}

function capterraCacheKey(url: string): string {
  const m = url.match(CAPTERRA_PRODUCT_URL);
  return m ? `capterra:${m[1]}` : `capterra:url:${url}`;
}

async function discoverG2Url(
  env: import('../../env').Env,
  attribution: { runId: string; workflow: string },
  name: string,
): Promise<string | null> {
  const res = await runSerpSearch(
    env,
    { q: `"${name}" site:g2.com/products` },
    attribution,
  );
  if (res.status !== 200) return null;
  for (const r of pickOrganicResults(res.body, 5)) {
    if (typeof r.link === 'string' && G2_PRODUCT_URL.test(r.link)) {
      return r.link.split(/[?#]/)[0];
    }
  }
  return null;
}

async function discoverCapterraUrl(
  env: import('../../env').Env,
  attribution: { runId: string; workflow: string },
  name: string,
): Promise<string | null> {
  const res = await runSerpSearch(
    env,
    { q: `"${name}" site:capterra.com/p` },
    attribution,
  );
  if (res.status !== 200) return null;
  for (const r of pickOrganicResults(res.body, 5)) {
    if (typeof r.link === 'string' && CAPTERRA_PRODUCT_URL.test(r.link)) {
      return r.link.split(/[?#]/)[0];
    }
  }
  return null;
}

interface SiteRunner<T> {
  label: string;
  curatorUrl: string | undefined;
  step: WorkflowStep;
  discover: () => Promise<string | null>;
  scrape: (url: string) => Promise<{ successful: boolean; html: string | null; error: string | null }>;
  parse: (html: string) => T;
}

/**
 * Discover (if needed) → scrape → parse a single review-site page. Each
 * action is its own checkpoint so resumed runs don't repeat work. Returns
 * the URL we used and the parsed snapshot. `ok` is true only when we have
 * at least one usable signal in the snapshot.
 */
async function runSite<T extends G2Snapshot | CapterraSnapshot>(
  runner: SiteRunner<T>,
): Promise<{ url: string | null; snapshot: T | null; ok: boolean; error: string | null }> {
  const { label, curatorUrl, step, discover, scrape, parse } = runner;

  const url = curatorUrl
    ? curatorUrl
    : await checkpoint(step, `discover-${label}-url`, () => discover());

  if (!url) {
    return { url: null, snapshot: null, ok: false, error: `no ${label} url found` };
  }

  const result = await checkpoint(step, `scrape-${label}`, async () => {
    const res = await scrape(url);
    if (!res.successful || !res.html) {
      return { ok: false, snapshot: null as T | null, error: res.error };
    }
    const parsed = parse(res.html) as T;
    const useful = parsed.ratingValue !== null || parsed.reviewCount !== null;
    return {
      ok: useful,
      snapshot: parsed,
      error: useful ? null : 'parsed snapshot is empty',
    };
  });

  return { url, ...result };
}
