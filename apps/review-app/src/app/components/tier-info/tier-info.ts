// Shared metadata for the tier hover popover and full-page detail modal.
// Mirrors thresholds and pillar weights in server/workflows/vendor/score.ts —
// keep this file aligned if the scoring rules change.

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

// Ordered Tier 1 → Unscored for the reference table in the modal.
export const TIER_ORDER: TierKey[] = [
  'Tier 1',
  'Tier 2',
  'Tier 3',
  'Tier 4',
  'Tier 5',
  'Unscored',
];

export function tierMetaFor(tier: string | undefined | null): TierMeta {
  if (tier && tier in TIER_META) return TIER_META[tier as TierKey];
  return TIER_META.Unscored;
}

export interface PillarMeta {
  key: 'credibility' | 'momentum' | 'fit';
  label: string;
  weight: number; // fraction (0.35, 0.35, 0.30)
  blurb: string;
  inputs: string;
}

export const PILLAR_META: PillarMeta[] = [
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

export const FLAG_LABELS: Record<string, string> = {
  public_company_estimated:
    'Public company — momentum partly estimated from defaults',
  missing_crunchbase: 'No Crunchbase data on file',
  missing_github: 'No GitHub organisation found',
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
