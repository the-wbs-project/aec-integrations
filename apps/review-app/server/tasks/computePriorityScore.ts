// ---------------------------------------------------------------------------
// Pure scoring math for T08 — tool priority.
//
// Two pillars:
//   - Integration score (tool-intrinsic API/marketplace/iPaaS signals)
//   - Demand score (reviews, search volume, Google Trends, Reddit)
//
// `priority_score = 0.55 * integration + 0.45 * demand`
//
// Outreach quality is a vendor concern — it lives in the vendor's VQS, not in
// per-tool priority. We accept the linked vendor's `founded_year` only for the
// emerging-flag check (young AEC-marketplace-listed tools with API docs get a
// minimum tier of 2).
//
// Returns the four scores along with per-pillar `populated` counters so the
// score workflow can compute completeness, confidence, and flags.
// ---------------------------------------------------------------------------

export interface ToolFields {
  marketplace_count?: number;
  has_api_docs?: boolean;
  tool_integrations_count?: number;
  ipaas_count?: number;
  g2_review_count?: number;
  capterra_review_count?: number;
  g2_rating?: number;
  capterra_rating?: number;
  search_volume_monthly?: number;
  google_trends_index?: number;
  reddit_mentions_24mo?: number;
}

export interface VendorFields {
  founded_year?: number;
}

export type PriorityTier = '1' | '2' | '3' | '4' | '5' | 'Unscored';

export interface PriorityScore {
  integration_score: number | null;
  demand_score: number | null;
  priority_score: number | null;
  priority_tier: PriorityTier;
  emerging_flag: boolean;
  /** Number of populated input signals per pillar — used for completeness/confidence. */
  integration_populated: number;
  demand_populated: number;
}

/** All input field names checked for completeness — 4 integration + 5 demand. */
export const PRIORITY_INPUT_FIELDS = [
  'marketplace_count',
  'has_api_docs',
  'tool_integrations_count',
  'ipaas_count',
  'g2_review_count',
  'capterra_review_count',
  'search_volume_monthly',
  'google_trends_index',
  'reddit_mentions_24mo',
] as const;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;

function isPopulatedNumber(v: unknown): boolean {
  return typeof v === 'number' && Number.isFinite(v);
}

function isPopulatedBoolean(v: unknown): boolean {
  return typeof v === 'boolean';
}

function logNorm(value: unknown, cap: number): number {
  const v = Math.log(num(value) + 1);
  const max = Math.log(cap + 1);
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (v / max) * 100));
}

function norm(value: unknown, min: number, max: number): number {
  if (max <= min) return 50;
  const v = num(value);
  return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
}

function bayesianRating(rating: number | null, count: number): number {
  const m = 15;
  const C = 4.1;
  const v = count || 0;
  const R = rating ?? C;
  const wr = (v / (v + m)) * R + (m / (v + m)) * C;
  return (wr / 5) * 100;
}

export function computePriorityScore(
  tool: ToolFields,
  vendor: VendorFields | null,
): PriorityScore {
  // ----- Integration pillar -----------------------------------------------
  const integrationInputs = [
    tool.marketplace_count,
    tool.has_api_docs,
    tool.tool_integrations_count,
    tool.ipaas_count,
  ];
  const integrationPopulated = integrationInputs.reduce<number>(
    (n, v) => n + (isPopulatedNumber(v) || isPopulatedBoolean(v) ? 1 : 0),
    0,
  );

  const integrationRaw =
    0.30 * logNorm(tool.marketplace_count, 4) +
    0.25 * (bool(tool.has_api_docs) ? 100 : 0) +
    0.20 * logNorm(tool.tool_integrations_count, 100) +
    0.25 * logNorm(tool.ipaas_count, 3);

  const integrationScore = integrationPopulated > 0 ? round1(integrationRaw) : null;

  // ----- Demand pillar ----------------------------------------------------
  const demandInputs = [
    tool.g2_review_count,
    tool.capterra_review_count,
    tool.search_volume_monthly,
    tool.google_trends_index,
    tool.reddit_mentions_24mo,
  ];
  const demandPopulated = demandInputs.reduce<number>(
    (n, v) => n + (isPopulatedNumber(v) ? 1 : 0),
    0,
  );

  const totalReviews = num(tool.g2_review_count) + num(tool.capterra_review_count);
  const bestRating = num(tool.g2_rating) || num(tool.capterra_rating) || null;
  const demandRaw =
    0.30 * logNorm(totalReviews, 5000) +
    0.25 * bayesianRating(bestRating, totalReviews) +
    0.20 * logNorm(tool.search_volume_monthly, 100_000) +
    0.15 * norm(tool.google_trends_index, 0, 100) +
    0.10 * logNorm(tool.reddit_mentions_24mo, 500);

  const demandScore = demandPopulated > 0 ? round1(demandRaw) : null;

  // ----- Composite + tier --------------------------------------------------
  let priorityScore: number | null = null;
  if (integrationScore !== null && demandScore !== null) {
    priorityScore = round1(0.55 * integrationScore + 0.45 * demandScore);
  } else if (integrationScore !== null) {
    priorityScore = round1(integrationScore);
  } else if (demandScore !== null) {
    priorityScore = round1(demandScore);
  }

  // ----- Emerging flag -----------------------------------------------------
  const v = vendor ?? {};
  const currentYear = new Date().getFullYear();
  const isYoung = num(v.founded_year) > currentYear - 4;
  const emergingFlag = !!(isYoung && bool(tool.has_api_docs) && num(tool.marketplace_count) >= 1);

  // ----- Tier (5 tiers + Unscored, aligned with VQS) ----------------------
  let priorityTier: PriorityTier;
  if (priorityScore === null) {
    priorityTier = 'Unscored';
  } else if (priorityScore >= 80) priorityTier = '1';
  else if (priorityScore >= 60) priorityTier = '2';
  else if (priorityScore >= 40) priorityTier = '3';
  else if (priorityScore >= 20) priorityTier = '4';
  else priorityTier = '5';

  // Emerging flag still forces a minimum of Tier 2 (only meaningful when scored).
  if (emergingFlag && priorityTier !== 'Unscored' && tierRank(priorityTier) > tierRank('2')) {
    priorityTier = '2';
  }

  return {
    integration_score: integrationScore,
    demand_score: demandScore,
    priority_score: priorityScore,
    priority_tier: priorityTier,
    emerging_flag: emergingFlag,
    integration_populated: integrationPopulated,
    demand_populated: demandPopulated,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Numeric rank for tier comparison (lower = better). */
function tierRank(t: PriorityTier): number {
  if (t === 'Unscored') return 99;
  return Number(t);
}
