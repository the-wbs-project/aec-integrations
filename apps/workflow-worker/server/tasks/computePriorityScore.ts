// ---------------------------------------------------------------------------
// Pure scoring math for T08. Lifted from the n8n Code node — same constants,
// same weighting, same tier thresholds.
// ---------------------------------------------------------------------------

export interface ToolFields {
  marketplace_count?: number;
  has_api_docs?: boolean;
  integration_count?: number;
  ipaas_count?: number;
  zapier_trigger_count?: number;
  g2_review_count?: number;
  capterra_review_count?: number;
  g2_rating?: number;
  capterra_rating?: number;
  search_volume_monthly?: number;
  google_trends_index?: number;
  reddit_mentions_24mo?: number;
}

export interface VendorFields {
  company_name?: string;
  company_size?: string;
  has_partner_program?: boolean;
  funding_stage?: string;
  press_count_12mo?: number;
  blog_last_post_days_ago?: number;
  founded_year?: number;
}

export interface PriorityScore {
  integration_score: number;
  demand_score: number;
  outreach_score: number;
  priority_score: number;
  priority_tier: '1' | '2' | '3' | '4';
  emerging_flag: boolean;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const bool = (v: unknown): boolean => v === true;

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

function employeeSweetSpot(size?: string): number {
  const map: Record<string, number> = {
    '1-10': 20,
    '11-50': 50,
    '51-200': 100,
    '201-1000': 90,
    '1001-5000': 60,
    '5000+': 30,
  };
  return size && map[size] !== undefined ? map[size] : 50;
}

function fundingScore(stage?: string): number {
  const map: Record<string, number> = {
    Bootstrapped: 40,
    'Pre-seed': 30,
    Seed: 50,
    'Series A': 80,
    'Series B': 90,
    'Series C': 100,
    'Series D+': 85,
    Public: 50,
    Acquired: 40,
    Unknown: 30,
  };
  return stage && map[stage] !== undefined ? map[stage] : 30;
}

function blogRecencyScore(daysAgo: number | null | undefined): number {
  if (daysAgo == null) return 30;
  if (daysAgo <= 7) return 100;
  if (daysAgo <= 30) return 80;
  if (daysAgo <= 90) return 60;
  if (daysAgo <= 180) return 40;
  if (daysAgo <= 365) return 20;
  return 10;
}

export function computePriorityScore(tool: ToolFields, vendor: VendorFields | null): PriorityScore {
  const v = vendor ?? {};

  const integrationScore =
    0.30 * logNorm(tool.marketplace_count, 4) +
    0.25 * (bool(tool.has_api_docs) ? 100 : 0) +
    0.20 * logNorm(tool.integration_count, 100) +
    0.15 * logNorm(tool.ipaas_count, 3) +
    0.10 * logNorm(tool.zapier_trigger_count, 50);

  const totalReviews = num(tool.g2_review_count) + num(tool.capterra_review_count);
  const bestRating = num(tool.g2_rating) || num(tool.capterra_rating) || null;
  const demandScore =
    0.30 * logNorm(totalReviews, 5000) +
    0.25 * bayesianRating(bestRating, totalReviews) +
    0.20 * logNorm(tool.search_volume_monthly, 100_000) +
    0.15 * norm(tool.google_trends_index, 0, 100) +
    0.10 * logNorm(tool.reddit_mentions_24mo, 500);

  const outreachScore =
    0.30 * employeeSweetSpot(v.company_size) +
    0.25 * (bool(v.has_partner_program) ? 100 : 0) +
    0.20 * fundingScore(v.funding_stage) +
    0.15 * logNorm(v.press_count_12mo, 50) +
    0.10 * blogRecencyScore(v.blog_last_post_days_ago ?? null);

  const priorityScore = 0.40 * integrationScore + 0.35 * demandScore + 0.25 * outreachScore;

  const currentYear = new Date().getFullYear();
  const isYoung = num(v.founded_year) > currentYear - 4;
  const emergingFlag = !!(isYoung && bool(tool.has_api_docs) && num(tool.marketplace_count) >= 1);

  let priorityTier: '1' | '2' | '3' | '4';
  if (priorityScore >= 80) priorityTier = '1';
  else if (priorityScore >= 55) priorityTier = '2';
  else if (priorityScore >= 30) priorityTier = '3';
  else priorityTier = '4';
  if (emergingFlag && priorityTier > '2') priorityTier = '2';

  const round1 = (n: number) => Math.round(n * 10) / 10;
  return {
    integration_score: round1(integrationScore),
    demand_score: round1(demandScore),
    outreach_score: round1(outreachScore),
    priority_score: round1(priorityScore),
    priority_tier: priorityTier,
    emerging_flag: emergingFlag,
  };
}
