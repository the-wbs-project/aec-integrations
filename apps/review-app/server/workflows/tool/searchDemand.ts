// ---------------------------------------------------------------------------
// T05 — Tool search demand (Google Trends + Google total-results).
// Source: artifacts/n8n-workflows/AECi-T05-SearchDemand.json
//
// NO LLM. Two SearchAPI.io calls via the search service:
//   1. engine=google_trends, q="<tool> software", date='today 12-m'
//   2. engine=google,         q="<tool> software"
// From (1) we average the timeline_data values to a 0-100 trends index.
// From (2) we apply log10(total_results + 1) * 100 to estimate monthly volume.
// ---------------------------------------------------------------------------
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../../env';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import { getRecord, updateRecord, asString } from '../../services/airtable';
import { runSerpSearch } from '../../services/search';

export const meta: WorkflowMeta = {
  slug: 'tool-search-demand',
  description: 'Compute google_trends_index + search_volume_monthly via SearchAPI.io.',
  table: 'tools',
};

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
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function extractSearchVolume(body: Record<string, unknown>): number | null {
  const info = body['search_information'] as Record<string, unknown> | undefined;
  const totalResults = info?.['total_results'];
  if (typeof totalResults !== 'number' || totalResults <= 0) return null;
  return Math.round(Math.log10(totalResults + 1) * 100);
}

export class ToolSearchDemandWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;
    const checkedAt = new Date().toISOString();
    const attribution = { runId: event.instanceId, workflow: meta.slug };

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'tools', recordId),
    );

    const toolName = asString(record.fields['Name']) ?? asString(record.fields['name']);
    if (!toolName) {
      const fields = { search_checked_at: checkedAt };
      await checkpoint(step, 'write-checked-at', () =>
        updateRecord(this.env, 'tools', recordId, fields),
      );
      return {
        fields,
        fieldsUpdated: ['search_checked_at'],
        status: 'error' as const,
        note: `Missing required fields. record_id=${recordId}`,
      };
    }

    const q = `${toolName} software`;

    const trendsIndex = await checkpoint(step, 'google-trends', async () => {
      try {
        const trends = await runSerpSearch(
          this.env,
          { engine: 'google_trends', q, date: 'today 12-m' },
          attribution,
        );
        return trends.status === 200 ? extractTrendsIndex(trends.body) : null;
      } catch (err) {
        console.error('searchDemand: trends call failed:', err);
        return null;
      }
    });

    const searchVolume = await checkpoint(step, 'google-search', async () => {
      try {
        const google = await runSerpSearch(this.env, { engine: 'google', q }, attribution);
        return google.status === 200 ? extractSearchVolume(google.body) : null;
      } catch (err) {
        console.error('searchDemand: google call failed:', err);
        return null;
      }
    });

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

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'tools', recordId, fields),
    );

    const haveAny = trendsIndex !== null || searchVolume !== null;
    return {
      fields,
      fieldsUpdated,
      status: haveAny ? ('success' as const) : ('partial' as const),
      note: haveAny ? undefined : 'No search demand data available',
    };
  }
}
