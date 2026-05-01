// Shared metadata for the tier hover popover and full-page detail modal.
// Mirrors thresholds and pillar weights in:
//   - server/workflows/vendor/score.ts (vendor / VQS)
//   - server/tasks/computePriorityScore.ts (tool / priority)
// Keep this file aligned if either scoring rule changes.

export type ScoreFamily = 'vendor' | 'tool';

export type TierKey =
  | 'Tier 1'
  | 'Tier 2'
  | 'Tier 3'
  | 'Tier 4'
  | 'Tier 5'
  | 'Unscored';

export type TierVariant =
  | 'success'
  | 'info'
  | 'accent'
  | 'warning'
  | 'danger'
  | 'neutral';

export interface TierMeta {
  range: string;
  label: string;
  blurb: string;
  variant: TierVariant;
}

// Shared 80/60/40/20 ladder. Vendor and tool use the same cutoffs after the
// Phase 4 alignment, but the human-readable copy differs because the pillars
// being scored differ (credibility/momentum/fit vs. integration/demand).
export const TIER_META: Record<TierKey, TierMeta> = {
  'Tier 1': {
    range: '80–100',
    label: 'Top integration partner',
    blurb: 'Established, high-momentum vendor with strong AEC fit.',
    variant: 'success',
  },
  'Tier 2': {
    range: '60–79',
    label: 'Strong candidate',
    blurb: 'Credible vendor with healthy momentum and decent fit.',
    variant: 'info',
  },
  'Tier 3': {
    range: '40–59',
    label: 'Worth evaluating',
    blurb: 'Moderate signals; usually missing one pillar.',
    variant: 'accent',
  },
  'Tier 4': {
    range: '20–39',
    label: 'Limited evidence',
    blurb: 'Thin signals across pillars. Verify manually.',
    variant: 'warning',
  },
  'Tier 5': {
    range: '0–19',
    label: 'Low priority',
    blurb: 'Few credible, momentum, or fit signals available.',
    variant: 'danger',
  },
  Unscored: {
    range: '—',
    label: 'Insufficient data',
    blurb: 'Not enough populated fields to compute a score.',
    variant: 'neutral',
  },
};

export const TOOL_TIER_META: Record<TierKey, TierMeta> = {
  'Tier 1': {
    range: '80–100',
    label: 'Build integration now',
    blurb: 'Strong integration surface and proven demand — clear build target.',
    variant: 'success',
  },
  'Tier 2': {
    range: '60–79',
    label: 'Strong candidate',
    blurb: 'Solid integration hooks and meaningful demand. Worth prioritising.',
    variant: 'info',
  },
  'Tier 3': {
    range: '40–59',
    label: 'Worth evaluating',
    blurb: 'Either integration or demand is light; the other carries the score.',
    variant: 'accent',
  },
  'Tier 4': {
    range: '20–39',
    label: 'Limited evidence',
    blurb: 'Thin integration surface and weak demand signals. Verify manually.',
    variant: 'warning',
  },
  'Tier 5': {
    range: '0–19',
    label: 'Low priority',
    blurb: 'Few integration hooks and little market demand on file.',
    variant: 'danger',
  },
  Unscored: {
    range: '—',
    label: 'Insufficient data',
    blurb: 'Not enough populated fields to compute a score.',
    variant: 'neutral',
  },
};

// Tools store their tier as plain '1'..'5' or 'Unscored' (no "Tier " prefix).
// This normalizes either form back to the keys above.
export function normalizeTierKey(tier: string | undefined | null): TierKey | null {
  if (!tier) return null;
  if (tier in TIER_META) return tier as TierKey;
  if (/^[1-5]$/.test(tier)) return `Tier ${tier}` as TierKey;
  if (tier === 'Unscored') return 'Unscored';
  return null;
}

export const TIER_ORDER: TierKey[] = [
  'Tier 1',
  'Tier 2',
  'Tier 3',
  'Tier 4',
  'Tier 5',
  'Unscored',
];

export function tierMapFor(family: ScoreFamily): Record<TierKey, TierMeta> {
  return family === 'tool' ? TOOL_TIER_META : TIER_META;
}

export function tierMetaFor(
  tier: string | undefined | null,
  family: ScoreFamily = 'vendor',
): TierMeta {
  const map = tierMapFor(family);
  const key = normalizeTierKey(tier);
  return key ? map[key] : map.Unscored;
}

// ---------------------------------------------------------------------------
// Pillar metadata
// ---------------------------------------------------------------------------

export type VendorPillarKey = 'credibility' | 'momentum' | 'fit';
export type ToolPillarKey = 'integration' | 'demand';
export type PillarKey = VendorPillarKey | ToolPillarKey;

export interface PillarMeta {
  key: PillarKey;
  label: string;
  weight: number; // fraction
  blurb: string;
  inputs: string;
}

const VENDOR_PILLAR_META: PillarMeta[] = [
  {
    key: 'credibility',
    label: 'Credibility',
    weight: 0.35,
    blurb: 'Is this a real, established company?',
    inputs:
      'Public/parent status, funding stage, Crunchbase rank, founded year.',
  },
  {
    key: 'momentum',
    label: 'Momentum',
    weight: 0.35,
    blurb: 'Are they actively growing and shipping?',
    inputs:
      'Crunchbase growth & heat, monthly web visits, GitHub commit recency.',
  },
  {
    key: 'fit',
    label: 'Fit',
    weight: 0.3,
    blurb: 'Do they fit our AEC integration thesis?',
    inputs:
      'SDK repo, verified GitHub org, repo count & stars, AEC categories.',
  },
];

const TOOL_PILLAR_META: PillarMeta[] = [
  {
    key: 'integration',
    label: 'Integration',
    weight: 0.55,
    blurb: 'Can we plug into this product?',
    inputs:
      'API docs, AEC marketplace listings, integration count, iPaaS presence, Zapier triggers.',
  },
  {
    key: 'demand',
    label: 'Demand',
    weight: 0.45,
    blurb: 'Is anyone looking for it?',
    inputs:
      'G2 + Capterra reviews and ratings, monthly search volume, Google Trends, Reddit mentions.',
  },
];

/** Backwards-compat: the vendor-side dialog imports this directly. */
export const PILLAR_META = VENDOR_PILLAR_META;

export function pillarsFor(family: ScoreFamily): PillarMeta[] {
  return family === 'vendor' ? VENDOR_PILLAR_META : TOOL_PILLAR_META;
}

// ---------------------------------------------------------------------------
// Flag labels — both families share the lookup map. New tool-specific flags
// added below; missing keys fall back to the raw flag name.
// ---------------------------------------------------------------------------

export const FLAG_LABELS: Record<string, string> = {
  // Vendor / VQS
  public_company_estimated:
    'Public company — momentum partly estimated from defaults',
  missing_crunchbase: 'No Crunchbase data on file',
  missing_github: 'No GitHub organisation found',
  // Tool / priority
  missing_marketplace_check: 'AEC marketplace presence not yet checked',
  missing_api_docs_check: 'API docs not yet checked',
  missing_ipaas_check: 'iPaaS presence not yet checked',
  missing_reviews_check: 'G2 / Capterra reviews not yet checked',
  missing_search_check: 'Search demand not yet checked',
  missing_reddit_check: 'Reddit mentions not yet checked',
  no_vendor_linked: 'No vendor linked — emerging-flag check skipped',
  vendor_unenriched: 'Linked vendor record could not be loaded',
  emerging: 'Emerging — young vendor in an AEC marketplace with API docs',
  // Shared
  unscored: 'Insufficient data to compute a score',
};

export function flagLabel(flag: string): string {
  return FLAG_LABELS[flag] ?? flag;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export function confidenceVariant(
  confidence: string | undefined | null,
): TierVariant {
  switch (confidence) {
    case 'high':
      return 'success';
    case 'medium':
      return 'info';
    case 'low':
      return 'warning';
    default:
      return 'neutral';
  }
}
