// ---------------------------------------------------------------------------
// Integration discovery — shared candidate type plus the materializer that
// resolves candidates to Vendors / Products and creates Integration records.
//
// Each leaf workflow (website, ipaas, marketplaces, g2, github, web) returns
// IntegrationCandidate[] for its source. The orchestrator merges them and
// hands the combined list to resolveAndMaterialize, which:
//   1. Dedupes by normalized name + website host.
//   2. Looks up the Vendor; creates a stub via createVendorAndStartOrchestrator
//      (skipOrchestrator=true) when missing.
//   3. Looks up the Product. Auto-creation is deferred — unmatched products
//      are returned in `unresolved` for the orchestrator to park on the source.
//   4. Creates an Integration record per resolved (source, target) candidate,
//      skipping pairs already wired by the same mechanism_kind.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import {
  asString,
  asStringArray,
  createRecord,
  getRecord,
  listRecords,
  type AirtableRecord,
} from './airtable';
import { createVendorAndStartOrchestrator } from './createVendor';
import { cacheInvalidate } from './cache';
import { tableId } from './airtable';

export type EvidenceSource =
  | 'website'
  | 'ipaas'
  | 'marketplaces'
  | 'g2'
  | 'github'
  | 'web';

export type Confidence = 'high' | 'medium' | 'low';

export interface IntegrationCandidate {
  /** Raw product/vendor name as found. */
  targetName: string;
  /** Optional website (full URL or bare host) for the discovered target. */
  targetWebsite?: string;
  /** Separate vendor name when the leaf can distinguish it from the product. */
  targetVendorName?: string;
  /** 'native'|'iPaaS'|'marketplace-app'|'api'|'webhook'|'partner' */
  mechanismKind?: string;
  /** Free-text label e.g. "Zapier connector", "Procore App". */
  mechanismName?: string;
  direction?: 'one-way' | 'bidirectional';
  /** REQUIRED — the URL we observed evidence on. */
  evidenceUrl: string;
  evidenceSource: EvidenceSource;
  notes?: string;
  confidence: Confidence;
}

export interface ResolveResult {
  createdIntegrations: string[];
  createdVendors: string[];
  unresolved: IntegrationCandidate[];
  /** Existing integrations that were skipped because the (source,target,mechanism) tuple already existed. */
  skippedExistingIntegrations: number;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|gmbh|sa|ag|plc)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

export function hostFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const u = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return undefined;
  }
}

/** Escape a value so it can be embedded in an Airtable filterByFormula string. */
function escapeFormula(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Group candidates by normalized targetName + targetWebsite host. Returns
 * one merged candidate per group, keeping the highest-confidence evidence
 * URL but preserving every source for traceability in `notes`.
 */
export function dedupeCandidates(
  candidates: IntegrationCandidate[],
): IntegrationCandidate[] {
  const groups = new Map<string, IntegrationCandidate[]>();
  for (const c of candidates) {
    const key = `${normalizeName(c.targetName)}|${hostFromUrl(c.targetWebsite) ?? ''}`;
    if (!key.startsWith('|')) {
      const list = groups.get(key) ?? [];
      list.push(c);
      groups.set(key, list);
    }
  }
  const merged: IntegrationCandidate[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]);
    const top = list[0];
    const sources = Array.from(new Set(list.map((c) => c.evidenceSource))).sort();
    const allNotes = list
      .map((c) => c.notes)
      .filter((n): n is string => Boolean(n))
      .join(' | ');
    merged.push({
      ...top,
      notes: [
        `sources=${sources.join(',')}`,
        `evidence=${list.map((c) => c.evidenceUrl).filter(Boolean).join(' ; ')}`,
        allNotes ? `notes=${allNotes}` : undefined,
      ]
        .filter(Boolean)
        .join(' | '),
    });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface ResolutionMaps {
  /** Vendor lookup — one entry per normalized company_name AND per website host. */
  vendorsByKey: Map<string, string>; // key -> vendorId
  /** Product lookup — keyed both by normalized name and by name+vendorId. */
  productsByKey: Map<string, string>; // key -> productId
  /** Vendors→list of productIds linked to that vendor. */
  productsByVendor: Map<string, string[]>;
}

async function buildResolutionMaps(env: Env): Promise<ResolutionMaps> {
  const [vendors, products] = await Promise.all([
    listRecords(env, 'vendors', { fields: ['company_name', 'website'] }),
    listRecords(env, 'products', { fields: ['Name', 'vendors'] }),
  ]);
  const vendorsByKey = new Map<string, string>();
  for (const v of vendors) {
    const name = asString(v.fields['company_name']);
    if (name) vendorsByKey.set(`name:${normalizeName(name)}`, v.id);
    const host = hostFromUrl(asString(v.fields['website']));
    if (host) vendorsByKey.set(`host:${host}`, v.id);
  }
  const productsByKey = new Map<string, string>();
  const productsByVendor = new Map<string, string[]>();
  for (const p of products) {
    const name = asString(p.fields['Name']);
    if (!name) continue;
    const norm = normalizeName(name);
    productsByKey.set(`name:${norm}`, p.id);
    const vIds = asStringArray(p.fields['vendors']);
    for (const vId of vIds) {
      productsByKey.set(`name+vendor:${norm}:${vId}`, p.id);
      const list = productsByVendor.get(vId) ?? [];
      list.push(p.id);
      productsByVendor.set(vId, list);
    }
  }
  return { vendorsByKey, productsByKey, productsByVendor };
}

/**
 * Look up an existing integration linking (source, target) via the source
 * product's `tool_integrations_source` linked records. Returns true when one
 * already exists with matching mechanism_kind.
 */
async function existingIntegrationMatches(
  env: Env,
  sourceProductId: string,
  targetProductId: string,
  mechanismKind: string | undefined,
): Promise<boolean> {
  // The source product holds linked-record IDs in tool_integrations_source.
  // We pull each candidate integration only when needed; in practice the list
  // is small (<50 typical). For correctness over speed, fetch the source
  // record fresh and inspect each link.
  const source = await getRecord(env, 'products', sourceProductId);
  const linkedIds = asStringArray(source.fields['tool_integrations_source']);
  if (linkedIds.length === 0) return false;
  const escaped = linkedIds.map((id) => `RECORD_ID() = "${id}"`).join(',');
  const filter = `OR(${escaped})`;
  const existing = await listRecords(env, 'integrations', {
    filterByFormula: filter,
    fields: ['Source Tool', 'Target Tool', 'mechanism_kind'],
  });
  for (const rec of existing) {
    const sIds = asStringArray(rec.fields['Source Tool']);
    const tIds = asStringArray(rec.fields['Target Tool']);
    if (!sIds.includes(sourceProductId)) continue;
    if (!tIds.includes(targetProductId)) continue;
    const kind = asString(rec.fields['mechanism_kind']);
    if ((kind ?? '') === (mechanismKind ?? '')) return true;
  }
  return false;
}

/**
 * Materialize a deduped list of IntegrationCandidates against a source Product.
 * Creates Vendor stubs (no orchestrator) when needed; never auto-creates
 * Products. Returns the list of candidates whose target product could not be
 * resolved so the caller can park them on the source product.
 */
export async function resolveAndMaterialize(
  env: Env,
  sourceProductId: string,
  candidates: IntegrationCandidate[],
): Promise<ResolveResult> {
  const deduped = dedupeCandidates(candidates);

  let maps = await buildResolutionMaps(env);

  const createdIntegrations: string[] = [];
  const createdVendors: string[] = [];
  const unresolved: IntegrationCandidate[] = [];
  let skippedExistingIntegrations = 0;

  for (const c of deduped) {
    const targetVendorName = c.targetVendorName?.trim() || c.targetName.trim();
    const normName = normalizeName(targetVendorName);
    const host = hostFromUrl(c.targetWebsite);

    // ----- Vendor lookup --------------------------------------------------
    let vendorId =
      (host ? maps.vendorsByKey.get(`host:${host}`) : undefined) ??
      maps.vendorsByKey.get(`name:${normName}`);

    if (!vendorId) {
      try {
        const created = await createVendorAndStartOrchestrator(env, {
          companyName: targetVendorName,
          website: c.targetWebsite,
          skipOrchestrator: true,
          triggeredBy: 'http',
        });
        vendorId = created.recordId;
        createdVendors.push(vendorId);
        // Update the local map so subsequent candidates with the same vendor
        // pick it up.
        maps.vendorsByKey.set(`name:${normName}`, vendorId);
        if (host) maps.vendorsByKey.set(`host:${host}`, vendorId);
      } catch (err) {
        console.error(
          '[integrationCandidates] vendor stub creation failed',
          targetVendorName,
          String(err),
        );
        unresolved.push(c);
        continue;
      }
    }

    // ----- Product lookup -------------------------------------------------
    const productNorm = normalizeName(c.targetName);
    let targetProductId =
      maps.productsByKey.get(`name+vendor:${productNorm}:${vendorId}`) ??
      maps.productsByKey.get(`name:${productNorm}`);

    if (!targetProductId) {
      // Auto-creation deferred — park the candidate.
      unresolved.push(c);
      continue;
    }

    if (targetProductId === sourceProductId) {
      // Self-reference — skip.
      continue;
    }

    // ----- Skip if integration already exists -----------------------------
    const exists = await existingIntegrationMatches(
      env,
      sourceProductId,
      targetProductId,
      c.mechanismKind,
    );
    if (exists) {
      skippedExistingIntegrations++;
      continue;
    }

    // ----- Create the integration record ----------------------------------
    const fields: Record<string, unknown> = {
      Name: `${c.targetName} (${c.evidenceSource})`,
      'Source Tool': [sourceProductId],
      'Target Tool': [targetProductId],
      listing_url: c.evidenceUrl,
    };
    if (c.mechanismKind) fields['mechanism_kind'] = c.mechanismKind;
    if (c.mechanismName) fields['mechanism_name'] = c.mechanismName;
    if (c.direction) fields['direction'] = c.direction;
    if (c.notes) fields['notes'] = c.notes;

    try {
      const created = await createRecord(env, 'integrations', fields);
      createdIntegrations.push(created.id);
    } catch (err) {
      console.error(
        '[integrationCandidates] integration create failed',
        c.targetName,
        String(err),
      );
      unresolved.push(c);
    }
  }

  // Drop the cached integrations + vendors tables so the data API picks up
  // the new rows without waiting on cacheFetch's TTL.
  if (createdIntegrations.length > 0) {
    await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'integrations')}`);
  }
  if (createdVendors.length > 0) {
    await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'vendors')}`);
  }

  return { createdIntegrations, createdVendors, unresolved, skippedExistingIntegrations };
}
