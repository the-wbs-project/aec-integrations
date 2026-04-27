// ---------------------------------------------------------------------------
// GET /api/stats — aggregate counts for the dashboard.
//   • integrations.total
//   • vendors: total, byStatus (vendor_enrichment_status), byReadiness (bucketed
//     vendor_data_completeness, 0–1)
//   • tools: total, byResearchStatus (research_status), byPriority (priority_tier)
//
// Single endpoint so the dashboard can render with one request rather than
// pulling the full lists client-side.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import {
  fetchIntegrations,
  fetchTools,
  fetchVendors,
} from '../services/airtable';
import type { Env } from '../types';

const READINESS_BUCKETS = [
  { key: '0-25', min: 0, max: 0.25 },
  { key: '25-50', min: 0.25, max: 0.5 },
  { key: '50-75', min: 0.5, max: 0.75 },
  { key: '75-100', min: 0.75, max: 1.0001 },
] as const;

export interface StatsResponse {
  integrations: { total: number };
  vendors: {
    total: number;
    byStatus: Record<string, number>;
    byReadiness: Record<string, number>;
    readinessBuckets: { key: string; label: string }[];
  };
  tools: {
    total: number;
    byResearchStatus: Record<string, number>;
    byPriority: Record<string, number>;
  };
}

const stats = new Hono<{ Bindings: Env }>();

stats.get('/', async (c) => {
  const env = c.env;

  const [vendorRecs, toolRecs, integrationRecs] = await Promise.all([
    fetchVendors(env),
    fetchTools(env),
    fetchIntegrations(env),
  ]);

  // Vendors -----------------------------------------------------------------
  const vendorByStatus: Record<string, number> = {};
  const vendorByReadiness: Record<string, number> = {
    ...Object.fromEntries(READINESS_BUCKETS.map((b) => [b.key, 0])),
    unknown: 0,
  };

  for (const r of vendorRecs) {
    const status = r.get('vendor_enrichment_status');
    const key = typeof status === 'string' && status.length > 0 ? status : 'unknown';
    vendorByStatus[key] = (vendorByStatus[key] ?? 0) + 1;

    const completeness = r.get('vendor_data_completeness');
    if (typeof completeness !== 'number' || !Number.isFinite(completeness)) {
      vendorByReadiness['unknown'] += 1;
    } else {
      const bucket = READINESS_BUCKETS.find(
        (b) => completeness >= b.min && completeness < b.max,
      );
      if (bucket) vendorByReadiness[bucket.key] += 1;
      else vendorByReadiness['unknown'] += 1;
    }
  }

  // Tools -------------------------------------------------------------------
  const toolByResearchStatus: Record<string, number> = {};
  const toolByPriority: Record<string, number> = {};

  for (const r of toolRecs) {
    const research = r.get('research_status');
    const rKey = typeof research === 'string' && research.length > 0 ? research : 'unknown';
    toolByResearchStatus[rKey] = (toolByResearchStatus[rKey] ?? 0) + 1;

    const priority = r.get('priority_tier');
    const pKey = typeof priority === 'string' && priority.length > 0 ? priority : 'unknown';
    toolByPriority[pKey] = (toolByPriority[pKey] ?? 0) + 1;
  }

  const body: StatsResponse = {
    integrations: { total: integrationRecs.length },
    vendors: {
      total: vendorRecs.length,
      byStatus: vendorByStatus,
      byReadiness: vendorByReadiness,
      readinessBuckets: [
        ...READINESS_BUCKETS.map((b) => ({ key: b.key, label: `${b.key}%` })),
        { key: 'unknown', label: 'Unknown' },
      ],
    },
    tools: {
      total: toolRecs.length,
      byResearchStatus: toolByResearchStatus,
      byPriority: toolByPriority,
    },
  };

  return c.json(body);
});

export default stats;
