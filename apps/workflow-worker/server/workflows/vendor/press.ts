// ---------------------------------------------------------------------------
// V05 — Vendor press / news mentions over the last 12 months.
// Source: artifacts/n8n-workflows/AECi-V05-Press.json
//
// NO LLM. We're skipping the n8n distinctiveness check for v1 simplicity:
// the prompt always uses `"<company>" construction software` as the Google
// News query. We then filter feed items to those mentioning the company name
// (or the root of its domain) within the last 365 days, count them, and
// record the most recent pubDate.
//
// Inputs (from vendors table): company_name, website
// Outputs: press_count_12mo, press_latest_date, press_checked_at
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import { asString, type AirtableRecord } from '../../services/airtable';
import { fetchFeed, parseRssOrAtom, googleNewsRssUrl } from '../../services/feeds';

function vendorDomain(website: string | undefined): string | undefined {
  if (!website) return undefined;
  const match = website.match(/^(?:https?:\/\/)?([^/?#:]+)/i);
  if (!match || !match[1] || !match[1].includes('.')) return undefined;
  return match[1].replace(/^www\./i, '').toLowerCase();
}

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description: 'Count vendor press mentions in the last 12 months from Google News RSS.',
  table: 'vendors',

  async run(_env, record: AirtableRecord) {
    const checkedAt = new Date().toISOString();
    const companyName = asString(record.fields['company_name']);
    const website = asString(record.fields['website']);
    const domain = vendorDomain(website);

    if (!companyName || !domain) {
      return {
        fields: { press_checked_at: checkedAt },
        fieldsUpdated: ['press_checked_at'],
        status: 'error',
        note: `Missing required fields on vendor record (company_name and/or website). record_id=${record.id}`,
      };
    }

    const query = `"${companyName}" construction software`;
    const feedUrl = googleNewsRssUrl(query);

    let xml = '';
    try {
      xml = await fetchFeed(feedUrl);
    } catch (err) {
      return {
        fields: { press_checked_at: checkedAt },
        fieldsUpdated: ['press_checked_at'],
        status: 'error',
        note: `Google News RSS fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let items: ReturnType<typeof parseRssOrAtom> = [];
    try {
      items = parseRssOrAtom(xml);
    } catch (err) {
      return {
        fields: { press_checked_at: checkedAt },
        fieldsUpdated: ['press_checked_at'],
        status: 'error',
        note: `Google News RSS parse failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

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
      if (!Number.isFinite(ts)) return false;
      return ts >= cutoff;
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

    return {
      fields,
      fieldsUpdated,
      status: 'success',
      note: `Found ${matched.length} press mention(s) in the last 12 months`,
    };
  },
};
