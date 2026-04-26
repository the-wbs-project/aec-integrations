// ---------------------------------------------------------------------------
// T05 — Tool search demand (Google Trends + Google total-results).
// Source: artifacts/n8n-workflows/AECi-T05-SearchDemand.json
//
// NO LLM. Two SerpAPI-style calls via the search service:
//   1. engine=google_trends, q="<tool> software", date='today 12-m'
//   2. engine=google,         q="<tool> software"
// From (1) we average the timeline_data values to a 0-100 trends index.
// From (2) we apply log10(total_results + 1) * 100 to estimate monthly volume.
//
// Inputs (from tools table): name (or Name)
// Outputs: search_volume_monthly, google_trends_index, search_checked_at
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import { asString, type AirtableRecord } from '../../services/airtable';
import { runSerpSearch } from '../../services/search';

interface TrendsTimelinePoint {
  values?: Array<{ extracted_value?: number }>;
}

function extractTrendsIndex(body: Record<string, unknown>): number | null {
  const interest = body['interest_over_time'] as Record<string, unknown> | undefined;
  const timelines = interest?.['timeline_data'] as TrendsTimelinePoint[] | undefined;
  if (!Array.isArray(timelines) || timelines.length === 0) return null;
  const values = timelines.map((t) => {
    const v = t.values?.[0]?.extracted_value;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  if (values.length === 0) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.round(avg);
}

function extractSearchVolume(body: Record<string, unknown>): number | null {
  const info = body['search_information'] as Record<string, unknown> | undefined;
  const totalResults = info?.['total_results'];
  if (typeof totalResults !== 'number' || totalResults <= 0) return null;
  return Math.round(Math.log10(totalResults + 1) * 100);
}

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description: 'Compute google_trends_index + search_volume_monthly via SerpAPI.',
  table: 'tools',

  async run(env, record: AirtableRecord) {
    const checkedAt = new Date().toISOString();
    const toolName =
      asString(record.fields['Name']) ?? asString(record.fields['name']);
    if (!toolName) {
      return {
        fields: { search_checked_at: checkedAt },
        fieldsUpdated: ['search_checked_at'],
        status: 'error',
        note: `Missing required fields. record_id=${record.id}`,
      };
    }

    const q = `${toolName} software`;

    let trendsIndex: number | null = null;
    try {
      const trends = await runSerpSearch(env, {
        engine: 'google_trends',
        q,
        date: 'today 12-m',
      });
      if (trends.status === 200) trendsIndex = extractTrendsIndex(trends.body);
    } catch (err) {
      console.error('searchDemand: trends call failed:', err);
    }

    let searchVolume: number | null = null;
    try {
      const google = await runSerpSearch(env, { engine: 'google', q });
      if (google.status === 200) searchVolume = extractSearchVolume(google.body);
    } catch (err) {
      console.error('searchDemand: google call failed:', err);
    }

    const fields: Record<string, unknown> = { search_checked_at: checkedAt };
    const fieldsUpdated = ['search_checked_at'];
    if (searchVolume !== null) {
      fields['search_volume_monthly'] = searchVolume;
      fieldsUpdated.push('search_volume_monthly');
    }
    if (trendsIndex !== null) {
      fields['google_trends_index'] = trendsIndex;
      fieldsUpdated.push('google_trends_index');
    }

    const haveAny = trendsIndex !== null || searchVolume !== null;
    return {
      fields,
      fieldsUpdated,
      status: haveAny ? 'success' : 'partial',
      note: haveAny ? undefined : 'No search demand data available',
    };
  },
};
