// ---------------------------------------------------------------------------
// V05 — Vendor press / news mentions over the last 12 months.
// Source: artifacts/n8n-workflows/AECi-V05-Press.json
//
// NO LLM. Fetches a Google News RSS feed for `"<company>" construction
// software`, filters items mentioning the company name (or domain root) within
// the last 365 days, counts them, and records the most recent pubDate.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord, asString } from '../../services/airtable';
import { fetchFeed, parseRssOrAtom, googleNewsRssUrl, FeedUnavailableError } from '../../services/feeds';

export const meta: WorkflowMeta = {
  slug: 'vendor-press',
  description: 'Count vendor press mentions in the last 12 months from Google News RSS.',
  table: 'vendors',
  options: {
    primaryField: 'press_count_12mo',
    stalenessField: 'press_checked_at',
    labelField: 'company_name',
  },
};

function vendorDomain(website: string | undefined): string | undefined {
  if (!website) return undefined;
  const match = website.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
  if (!match || !match[1] || !match[1].includes('.')) return undefined;
  return match[1].replace(/^www\./i, '').toLowerCase();
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export class VendorPressWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;
    const checkedAt = new Date().toISOString();

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );

    const companyName = asString(record.fields['company_name']);
    const website = asString(record.fields['website']);
    const domain = vendorDomain(website);

    if (!companyName || !domain) {
      const fields = { press_checked_at: checkedAt };
      await checkpoint(step, 'write-checked-at', () =>
        updateRecord(this.env, 'vendors', recordId, fields),
      );
      return {
        fields,
        fieldsUpdated: ['press_checked_at'],
        status: 'error' as const,
        note: `Missing required fields on vendor record (company_name and/or website). record_id=${recordId}`,
      };
    }

    let xml: string | null = null;
    let feedError: { status: number; url: string } | null = null;
    try {
      xml = await checkpoint(step, 'fetch-feed', () =>
        fetchFeed(googleNewsRssUrl(`"${companyName}" construction software`)),
      );
    } catch (err) {
      if (err instanceof FeedUnavailableError) {
        feedError = { status: err.status, url: err.url };
      } else {
        throw err;
      }
    }

    if (feedError) {
      const fields: Record<string, unknown> = {
        press_count_12mo: 0,
        press_checked_at: checkedAt,
      };
      await checkpoint(step, 'write-fields', () =>
        updateRecord(this.env, 'vendors', recordId, fields),
      );
      return {
        fields,
        fieldsUpdated: ['press_count_12mo', 'press_checked_at'],
        status: 'error' as const,
        note: `Google News RSS unavailable (HTTP ${feedError.status}); recorded 0 mentions`,
      };
    }

    const items = parseRssOrAtom(xml as string);
    const nameLower = companyName.toLowerCase();
    const domainRoot = domain.split('.')[0];
    const cutoff = Date.now() - ONE_YEAR_MS;

    const matched = items.filter((it) => {
      const title = (it.title ?? '').toLowerCase();
      const description = (it.description ?? '').toLowerCase();
      const mentions =
        title.includes(nameLower) ||
        description.includes(nameLower) ||
        title.includes(domainRoot) ||
        description.includes(domainRoot);
      if (!mentions) return false;
      if (!it.pubDate) return false;
      const ts = new Date(it.pubDate).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const dateMs = matched
      .map((m) => (m.pubDate ? new Date(m.pubDate).getTime() : 0))
      .filter((t) => t > 0);
    const latestTs = dateMs.length ? Math.max(...dateMs) : null;
    const latestDateStr = latestTs ? new Date(latestTs).toISOString().substring(0, 10) : null;

    const fields: Record<string, unknown> = {
      press_count_12mo: matched.length,
      press_checked_at: checkedAt,
    };
    const fieldsUpdated = ['press_count_12mo', 'press_checked_at'];
    if (latestDateStr) {
      fields['press_latest_date'] = latestDateStr;
      fieldsUpdated.push('press_latest_date');
    }

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'vendors', recordId, fields),
    );

    return {
      fields,
      fieldsUpdated,
      status: 'success' as const,
      note: `Found ${matched.length} press mention(s) in the last 12 months`,
    };
  }
}
