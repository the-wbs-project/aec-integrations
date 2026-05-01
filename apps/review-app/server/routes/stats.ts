// ---------------------------------------------------------------------------
// GET /api/stats — aggregate counts for the dashboard.
//   • integrations.total
//   • vendors: total, byStatus (vendor_enrichment_status), byTier (vqs_tier)
//   • tools: total, byResearchStatus (research_status), byPriority (priority_tier)
//
// Single endpoint so the dashboard can render with one request rather than
// pulling the full lists client-side.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import {
  fetchIntegrations,
  fetchProducts,
  fetchVendors,
} from '../services/airtable';
import type { Env } from '../types';

const VQS_TIER_ORDER = ['Tier 1', 'Tier 2', 'Tier 3', 'Tier 4', 'Tier 5', 'Unscored'] as const;

export interface StatsResponse {
  integrations: { total: number };
  vendors: {
    total: number;
    byStatus: Record<string, number>;
    byTier: Record<string, number>;
    tierBuckets: { key: string; label: string }[];
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
    fetchProducts(env),
    fetchIntegrations(env),
  ]);

  // Vendors -----------------------------------------------------------------
  const vendorByStatus: Record<string, number> = {};
  const vendorByTier: Record<string, number> = Object.fromEntries(
    VQS_TIER_ORDER.map((k) => [k, 0]),
  );

  for (const r of vendorRecs) {
    const status = r.get('vendor_enrichment_status');
    const key = typeof status === 'string' && status.length > 0 ? status : 'unknown';
    vendorByStatus[key] = (vendorByStatus[key] ?? 0) + 1;

    const tier = r.get('vqs_tier');
    const tierKey =
      typeof tier === 'string' && tier.length > 0 ? tier : 'Unscored';
    vendorByTier[tierKey] = (vendorByTier[tierKey] ?? 0) + 1;
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
      byTier: vendorByTier,
      tierBuckets: VQS_TIER_ORDER.map((k) => ({ key: k, label: k })),
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
