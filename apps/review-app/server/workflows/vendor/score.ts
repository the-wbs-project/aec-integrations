// ---------------------------------------------------------------------------
// V07 — Vendor Quality Score (VQS).
//
// Pure function — no LLM, no external APIs. Reads enriched fields off the
// Airtable record and computes a 0–100 vendor score with three pillars
// (Credibility, Momentum, Fit) plus tier / confidence / flags.
//
// Spec: docs/vendor-quality-score.md
//
// Also keeps `vendor_data_completeness` and `vendor_enrichment_status`
// populated for backwards compatibility — but the completeness ratio now
// counts the VQS input signals, not the old set of six.
// ---------------------------------------------------------------------------
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { ErrorCapturingWorkflow } from '../../lib/error-capturing-workflow';
import { checkpoint } from '../../lib/checkpoint';
import type { RunParams, WorkflowMeta } from '../../lib/workflow-meta';
import {
  getRecord,
  updateRecord,
  asString,
  asNumber,
  asBoolean,
  type AirtableRecord,
} from '../../services/airtable';

export const meta: WorkflowMeta = {
  slug: 'vendor-score',
  description:
    'Compute the Vendor Quality Score (Credibility / Momentum / Fit) plus tier, confidence, and flags.',
  table: 'vendors',
};

// ---------------------------------------------------------------------------
// AEC category mapping. See docs/vendor-quality-score.md for rationale.
// Match is case-insensitive against `crunchbase_categories`.
// ---------------------------------------------------------------------------
const AEC_CATEGORIES: ReadonlyArray<string> = [
  'Construction',
  'Building Maintenance',
  'Building Material',
  'Architecture',
  'Engineering',
  'Civil Engineering',
  'Mechanical Engineering',
  'Structural Engineering',
  'Industrial Engineering',
  'Real Estate',
  'Property Management',
  'Commercial Real Estate',
  'Real Estate Investment',
  'Facility Management',
  'Infrastructure',
  'Smart Building',
  'Smart Cities',
  'Building Information Modeling',
  'BIM',
  '3D Technology',
  'CAD',
  'GIS',
  'Surveying',
  'Project Management',
  'Construction Management',
  'Field Service',
  'Heavy Industry',
  'Manufacturing',
  'Industrial Automation',
  'Supply Chain Management',
  'Procurement',
  'Contractors',
];

const AEC_CATEGORY_SET = new Set(AEC_CATEGORIES.map((c) => c.toLowerCase()));

// ---------------------------------------------------------------------------
// Funding stage ladder
// ---------------------------------------------------------------------------
const FUNDING_STAGE_POINTS: Record<string, number> = {
  Public: 35,
  'Series D+': 35,
  Acquired: 30,
  'Series C': 30,
  'Series B': 25,
  'Series A': 18,
  Seed: 10,
  'Pre-seed': 5,
  Bootstrapped: 5,
  Unknown: 0,
};

// ---------------------------------------------------------------------------
// Pillar weights — must sum to 1.0
// ---------------------------------------------------------------------------
const WEIGHT_CREDIBILITY = 0.35;
const WEIGHT_MOMENTUM = 0.35;
const WEIGHT_FIT = 0.3;

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Saturating log10 transform: maps `value` in [1, ceiling] onto [0, max],
 * with anything ≤ 1 → 0 and anything ≥ ceiling → max. Used to dampen
 * outliers (Microsoft's stars, billion-visit traffic) so they don't
 * dominate.
 */
function logSat(value: number, ceiling: number, max: number): number {
  if (!Number.isFinite(value) || value <= 1) return 0;
  if (value >= ceiling) return max;
  return (max * Math.log10(value)) / Math.log10(ceiling);
}

/**
 * Linear interpolation across breakpoints. `breaks` is an ordered list of
 * `[x, y]` pairs from low x to high x. Values below the first break get
 * the first y; above the last break get the last y.
 */
function piecewise(value: number, breaks: ReadonlyArray<[number, number]>): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= breaks[0][0]) return breaks[0][1];
  for (let i = 1; i < breaks.length; i++) {
    const [x0, y0] = breaks[i - 1];
    const [x1, y1] = breaks[i];
    if (value <= x1) {
      const t = (value - x0) / (x1 - x0);
      return y0 + t * (y1 - y0);
    }
  }
  return breaks[breaks.length - 1][1];
}

// ---------------------------------------------------------------------------
// Pillar input extraction
// ---------------------------------------------------------------------------
interface PillarInputs {
  // Credibility
  publicPrivate: string | undefined;
  parentCompany: string | undefined;
  fundingStage: string | undefined;
  crunchbaseRank: number | undefined;
  foundedYear: number | undefined;
  // Momentum
  growthScore: number | undefined;
  heatScore: number | undefined;
  monthlyWebVisits: number | undefined;
  githubLastCommitDaysAgo: number | undefined;
  // Fit
  hasSdkRepo: boolean | undefined;
  githubOrgVerified: boolean | undefined;
  githubRepoCount: number | undefined;
  githubStarsTotal: number | undefined;
  crunchbaseCategories: string[] | undefined;
  // Bookkeeping for flags
  crunchbaseCheckedAt: string | undefined;
  githubOrg: string | undefined;
}

function extractInputs(record: AirtableRecord): PillarInputs {
  const f = record.fields;
  const cats = f['crunchbase_categories'];
  return {
    publicPrivate: asString(f['public_private']),
    parentCompany: asString(f['parent_company']),
    fundingStage: asString(f['funding_stage']),
    crunchbaseRank: asNumber(f['crunchbase_rank']),
    foundedYear: asNumber(f['founded_year']),
    growthScore: asNumber(f['crunchbase_growth_score']),
    heatScore: asNumber(f['crunchbase_heat_score']),
    monthlyWebVisits: asNumber(f['monthly_web_visits']),
    githubLastCommitDaysAgo: asNumber(f['github_last_commit_days_ago']),
    hasSdkRepo: asBoolean(f['has_sdk_repo']),
    githubOrgVerified: asBoolean(f['github_org_verified']),
    githubRepoCount: asNumber(f['github_repo_count']),
    githubStarsTotal: asNumber(f['github_stars_total']),
    crunchbaseCategories: Array.isArray(cats)
      ? cats.filter((x): x is string => typeof x === 'string')
      : undefined,
    crunchbaseCheckedAt: asString(f['crunchbase_checked_at']),
    githubOrg: asString(f['github_org']),
  };
}

// ---------------------------------------------------------------------------
// Credibility pillar
// ---------------------------------------------------------------------------
function scoreCredibility(i: PillarInputs): { score: number | null; populated: number } {
  let populated = 0;
  let total = 0;

  if (i.publicPrivate !== undefined) {
    populated++;
    if (i.publicPrivate === 'Public') total += 35;
  }
  if (i.parentCompany !== undefined && i.parentCompany.length > 0) {
    populated++;
    total += 25;
  }
  if (i.fundingStage !== undefined) {
    populated++;
    total += FUNDING_STAGE_POINTS[i.fundingStage] ?? 0;
  }
  if (i.crunchbaseRank !== undefined && i.crunchbaseRank > 0) {
    populated++;
    // rank 1 → 20, rank 500_000 → 0
    const ratio = Math.log10(i.crunchbaseRank) / Math.log10(500_000);
    total += clamp(20 * (1 - ratio), 0, 20);
  }
  if (i.foundedYear !== undefined && i.foundedYear > 0) {
    populated++;
    const age = new Date().getFullYear() - i.foundedYear;
    total += clamp(age * 1.5, 0, 20);
  }

  if (populated < 2) return { score: null, populated };
  return { score: Math.round(clamp(total, 0, 100)), populated };
}

// ---------------------------------------------------------------------------
// Momentum pillar
// ---------------------------------------------------------------------------
function scoreMomentum(
  i: PillarInputs,
): { score: number | null; populated: number; estimated: boolean } {
  const isPublic = i.publicPrivate === 'Public';
  let populated = 0;
  let total = 0;
  let estimated = false;

  // Growth score (0–100 → 0–35)
  if (i.growthScore !== undefined) {
    populated++;
    total += clamp(i.growthScore, 0, 100) * 0.35;
  } else if (isPublic) {
    populated++;
    total += 50 * 0.35;
    estimated = true;
  }

  // Heat score (0–100 → 0–20)
  if (i.heatScore !== undefined) {
    populated++;
    total += clamp(i.heatScore, 0, 100) * 0.2;
  } else if (isPublic) {
    populated++;
    total += 50 * 0.2;
    estimated = true;
  }

  // Monthly web visits → 0–20, saturates at 10M/mo
  if (i.monthlyWebVisits !== undefined && i.monthlyWebVisits > 0) {
    populated++;
    total += logSat(i.monthlyWebVisits, 10_000_000, 20);
  }

  // GitHub commit recency → 0–25
  if (i.githubLastCommitDaysAgo !== undefined && i.githubLastCommitDaysAgo >= 0) {
    populated++;
    total += piecewise(i.githubLastCommitDaysAgo, [
      [0, 25],
      [30, 20],
      [90, 13],
      [180, 7],
      [365, 0],
    ]);
  }

  if (populated < 2) return { score: null, populated, estimated };
  return { score: Math.round(clamp(total, 0, 100)), populated, estimated };
}

// ---------------------------------------------------------------------------
// Fit pillar
// ---------------------------------------------------------------------------
function scoreFit(i: PillarInputs): { score: number | null; populated: number } {
  let populated = 0;
  let total = 0;

  if (i.hasSdkRepo !== undefined) {
    populated++;
    if (i.hasSdkRepo) total += 30;
  }
  if (i.githubOrgVerified !== undefined) {
    populated++;
    if (i.githubOrgVerified) total += 15;
  }
  if (i.githubRepoCount !== undefined && i.githubRepoCount >= 0) {
    populated++;
    total += logSat(i.githubRepoCount, 50, 15);
  }
  if (i.githubStarsTotal !== undefined && i.githubStarsTotal >= 0) {
    populated++;
    total += logSat(i.githubStarsTotal, 10_000, 15);
  }
  if (i.crunchbaseCategories !== undefined && i.crunchbaseCategories.length > 0) {
    populated++;
    const matches = i.crunchbaseCategories.filter((c) =>
      AEC_CATEGORY_SET.has(c.toLowerCase()),
    ).length;
    if (matches >= 2) total += 25;
    else if (matches === 1) total += 15;
  }

  if (populated === 0) return { score: null, populated };
  return { score: Math.round(clamp(total, 0, 100)), populated };
}

// ---------------------------------------------------------------------------
// Composite + tier + confidence
// ---------------------------------------------------------------------------
function tierForScore(score: number | null): string {
  if (score === null) return 'Unscored';
  if (score >= 80) return 'Tier 1';
  if (score >= 60) return 'Tier 2';
  if (score >= 40) return 'Tier 3';
  if (score >= 20) return 'Tier 4';
  return 'Tier 5';
}

function confidenceFor(
  pillarsPresent: number,
  totalPopulated: number,
): 'high' | 'medium' | 'low' {
  if (pillarsPresent === 3 && totalPopulated >= 7) return 'high';
  if (pillarsPresent >= 2 && totalPopulated >= 4) return 'medium';
  return 'low';
}

interface ScoreOutput {
  vqs_score: number | null;
  vqs_credibility: number | null;
  vqs_momentum: number | null;
  vqs_fit: number | null;
  vqs_tier: string;
  vqs_confidence: 'high' | 'medium' | 'low';
  vqs_flags: string;
  vendor_data_completeness: number;
  vendor_enrichment_status: 'enriched' | 'partial' | 'error';
  last_enriched_at: string;
  [key: string]: unknown;
}

const ALL_VQS_INPUTS = [
  'public_private',
  'parent_company',
  'funding_stage',
  'crunchbase_rank',
  'founded_year',
  'crunchbase_growth_score',
  'crunchbase_heat_score',
  'monthly_web_visits',
  'github_last_commit_days_ago',
  'has_sdk_repo',
  'github_org_verified',
  'github_repo_count',
  'github_stars_total',
] as const;

export function computeVqs(record: AirtableRecord): ScoreOutput {
  const inputs = extractInputs(record);
  const cred = scoreCredibility(inputs);
  const mom = scoreMomentum(inputs);
  const fit = scoreFit(inputs);

  const pillars: Array<{ score: number | null; weight: number }> = [
    { score: cred.score, weight: WEIGHT_CREDIBILITY },
    { score: mom.score, weight: WEIGHT_MOMENTUM },
    { score: fit.score, weight: WEIGHT_FIT },
  ];
  const present = pillars.filter((p) => p.score !== null);

  let vqs: number | null = null;
  if (present.length > 0) {
    const denom = present.reduce((s, p) => s + p.weight, 0);
    const numer = present.reduce((s, p) => s + (p.score as number) * p.weight, 0);
    vqs = Math.round(numer / denom);
  }

  const totalPopulated = cred.populated + mom.populated + fit.populated;
  const flags: string[] = [];
  if (mom.estimated) flags.push('public_company_estimated');
  if (!inputs.crunchbaseCheckedAt) flags.push('missing_crunchbase');
  if (!inputs.githubOrg) flags.push('missing_github');
  if (vqs === null) flags.push('unscored');

  // Backwards-compat: completeness over the 13 VQS-relevant Airtable fields.
  const populatedFields = ALL_VQS_INPUTS.filter((f) => {
    const v = record.fields[f];
    if (v === null || v === undefined || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    return true;
  }).length;
  const completeness = populatedFields / ALL_VQS_INPUTS.length;
  const enrichmentStatus: 'enriched' | 'partial' | 'error' =
    completeness >= 0.75 ? 'enriched' : completeness >= 0.4 ? 'partial' : 'error';

  return {
    vqs_score: vqs,
    vqs_credibility: cred.score,
    vqs_momentum: mom.score,
    vqs_fit: fit.score,
    vqs_tier: tierForScore(vqs),
    vqs_confidence: confidenceFor(present.length, totalPopulated),
    vqs_flags: JSON.stringify(flags),
    vendor_data_completeness: completeness,
    vendor_enrichment_status: enrichmentStatus,
    last_enriched_at: new Date().toISOString(),
  };
}

export class VendorScoreWorkflow extends ErrorCapturingWorkflow {
  override async runImpl(event: WorkflowEvent<RunParams>, step: WorkflowStep) {
    const { recordId } = event.payload;

    const record = await checkpoint(step, 'fetch-record', () =>
      getRecord(this.env, 'vendors', recordId),
    );

    const fields = computeVqs(record);

    await checkpoint(step, 'write-fields', () =>
      updateRecord(this.env, 'vendors', recordId, fields),
    );

    return {
      fields,
      fieldsUpdated: Object.keys(fields),
      status: 'success' as const,
      note:
        fields.vqs_score === null
          ? `Unscored — ${fields.vqs_flags}`
          : `VQS=${fields.vqs_score} (${fields.vqs_tier}, ${fields.vqs_confidence})`,
    };
  }
}
