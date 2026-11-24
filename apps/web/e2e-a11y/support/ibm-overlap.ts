/**
 * AECI-1884: IBM Equal Access as a second rule engine, report only. The pure half.
 *
 * `ibm-equal-access.spec.ts` runs the IBM engine and axe on the same page state,
 * then calls `matchAxe` on each IBM finding. That marks which findings axe also
 * reported, so the unique ones stand out. Whether a unique finding is real is a
 * judgement the two-week note makes, not this file.
 *
 * THE MATCHING RULE. An IBM finding is "also reported by axe" when one axe node
 * passes both tests:
 *
 *   1. Same element. The two XPaths are equal, or one element holds the other
 *      at most `MAX_DEPTH_GAP` levels down. Both engines often report one
 *      problem on a field and its wrapper, or on a link and the image inside it.
 *      Both XPaths come from one in-page function, so they compare as strings.
 *   2. Same problem. The two rules share a WCAG success criterion, or the pair
 *      is listed in `RULE_PAIRS`. IBM's criteria come from its ruleset's
 *      checkpoints. axe's come from its `wcagNNN` tags. axe's best-practice
 *      rules have no criterion, so they match only through `RULE_PAIRS`.
 *
 * Two kinds of match, counted apart. axe FAILED the node (`violations`), or axe
 * only marked it for review (`incomplete`, shown with ` (review)` after the rule).
 * An IBM finding axe only marked for review is not overlap: axe did not call it
 * a failure, so it stays in the unique list, labelled "axe review only". Only a
 * finding axe failed leaves the unique list. A finding with no match at all is
 * "not in axe".
 *
 * THE RULE ERRS BOTH WAYS. Each direction has a cost:
 *
 *   - Overlap overstated, so the unique list is too short. This hides a finding
 *     only IBM makes, which is the failure the second engine exists to catch.
 *     Causes: a broad criterion such as 1.3.1 on a high element matches an
 *     unrelated axe node up to two levels below it, and two different problems
 *     on one element under one criterion count as one.
 *   - Overlap understated, so the unique list is too long. This costs triage
 *     time, and makes IBM look more useful than it is. Causes: an axe node
 *     whose selector no longer resolves in the page is dropped before matching
 *     (`runAxe` in `ibm-engine.ts`), an element and its holder more than
 *     `MAX_DEPTH_GAP` levels apart never match, and two rules for one problem
 *     that map to different criteria miss unless `RULE_PAIRS` lists them.
 *
 * The two-week note should sample both lists by hand: unique findings that axe
 * did report, and matched findings that are different problems.
 *
 * Pure. Pinned by `ibm-overlap.unit.spec.ts`. The merge across shards is
 * `mergeIbm()` in `scripts/a11y-nightly-merge-summary.mjs`. Keep the two in step.
 * `docs/TESTING_STRATEGY.md` §8.4.9.
 */

export const IBM_ANNOTATION = 'ibm-equal-access';

/** The suffix `matchAxe` puts after an axe rule that only marked the node for review. */
export const REVIEW_SUFFIX = ' (review)';

/** How far apart two nested elements may be and still be "the same element". */
export const MAX_DEPTH_GAP = 2;

/** Examples kept per rule in the summary. The test's annotation has every node. */
export const EXAMPLES_KEPT = 3;

/** IBM's result levels, as its own `valueToLevel` names them. */
export type IbmLevel =
  | 'violation'
  | 'potentialviolation'
  | 'recommendation'
  | 'potentialrecommendation'
  | 'manual';

/** The three lists of the summary, as IBM's own reports group the levels. */
export type IbmBucket = 'violation' | 'needsReview' | 'recommendation';

/**
 * IBM's `[policy, outcome]` pair to a level, the same mapping the
 * `accessibility-checker` wrapper uses. `pass` is dropped by the caller.
 */
export function levelOf(value: readonly [string, string]): IbmLevel | 'pass' | null {
  const [policy, outcome] = value;
  if (outcome === 'PASS') return 'pass';
  if ((policy === 'VIOLATION' || policy === 'RECOMMENDATION') && outcome === 'MANUAL') {
    return 'manual';
  }
  if (policy === 'VIOLATION') {
    if (outcome === 'FAIL') return 'violation';
    if (outcome === 'POTENTIAL') return 'potentialviolation';
  }
  if (policy === 'RECOMMENDATION') {
    if (outcome === 'FAIL') return 'recommendation';
    if (outcome === 'POTENTIAL') return 'potentialrecommendation';
  }
  return null;
}

/**
 * IBM's reports show "Violations", "Needs review" (potential violations and
 * manual checks) and "Recommendations" (both recommendation levels).
 */
export function bucketOf(level: IbmLevel): IbmBucket {
  if (level === 'violation') return 'violation';
  if (level === 'potentialviolation' || level === 'manual') return 'needsReview';
  return 'recommendation';
}

/** `wcag111` to `1.1.1`, `wcag1410` to `1.4.10`. Other tags are dropped. */
export function wcagFromAxeTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const tag of tags) {
    const m = tag.match(/^wcag(\d)(\d)(\d{1,2})$/);
    if (m) out.add(`${m[1]}.${m[2]}.${m[3]}`);
  }
  return [...out].sort();
}

/**
 * Rule pairs that check the same thing but share no WCAG criterion, usually
 * because the axe rule is best-practice. Each says why. Add a pair only when
 * both rules name the same problem in their own help text.
 */
export const RULE_PAIRS: ReadonlyArray<{
  readonly ibm: string;
  readonly axe: string;
  readonly why: string;
}> = [
  {
    ibm: 'aria_landmark_name_unique',
    axe: 'landmark-unique',
    why: 'Both: two landmarks of one role need different names.',
  },
  {
    ibm: 'aria_content_in_landmark',
    axe: 'region',
    why: 'Both: all content sits inside a landmark.',
  },
];

export interface IbmFinding {
  readonly ruleId: string;
  readonly reasonId: string;
  readonly level: IbmLevel;
  readonly message: string;
  /** WCAG criteria the rule maps to in the ruleset, as `1.4.3`. */
  readonly wcag: readonly string[];
  readonly xpath: string;
}

export interface AxeNode {
  readonly ruleId: string;
  /** `violation` when axe failed the node, `review` when it marked it incomplete. */
  readonly kind: 'violation' | 'review';
  readonly wcag: readonly string[];
  readonly xpath: string;
}

function depth(xpath: string): number {
  return xpath.split('/').filter(Boolean).length;
}

/** Test 1: the same element, or one holds the other within `MAX_DEPTH_GAP` levels. */
export function sameElement(a: string, b: string): boolean {
  if (a === b) return true;
  const [outer, inner] = a.length < b.length ? [a, b] : [b, a];
  return inner.startsWith(`${outer}/`) && depth(inner) - depth(outer) <= MAX_DEPTH_GAP;
}

/** Test 2: a shared criterion, or a listed pair. */
export function sameProblem(f: Pick<IbmFinding, 'ruleId' | 'wcag'>, n: AxeNode): boolean {
  if (f.wcag.some((c) => n.wcag.includes(c))) return true;
  return RULE_PAIRS.some((p) => p.ibm === f.ruleId && p.axe === n.ruleId);
}

/**
 * The axe nodes that match this finding, as `rule` for a failure and
 * `rule (review)` for an incomplete. Sorted and unique. Empty means unique to IBM.
 */
export function matchAxe(f: IbmFinding, axe: readonly AxeNode[]): string[] {
  const hits = new Set<string>();
  for (const n of axe) {
    if (sameElement(f.xpath, n.xpath) && sameProblem(f, n)) {
      hits.add(n.kind === 'violation' ? n.ruleId : `${n.ruleId}${REVIEW_SUFFIX}`);
    }
  }
  return [...hits].sort();
}

/** How axe saw an IBM finding: it failed the node, only marked it for review, or neither. */
export type AxeVerdict = 'failed' | 'review-only' | 'none';

/** Read a finding's `axe` list. A failure anywhere wins over a review. */
export function axeVerdict(matches: readonly string[]): AxeVerdict {
  if (matches.some((m) => !m.endsWith(REVIEW_SUFFIX))) return 'failed';
  return matches.length > 0 ? 'review-only' : 'none';
}

/** What the spec writes per surface, as the `IBM_ANNOTATION` annotation. */
export interface IbmSurfaceRecord {
  readonly surfaceId: string;
  readonly route: string;
  readonly engine: { readonly version: string; readonly ruleset: string };
  /**
   * Distinct rules that returned a result, passes included. A run with none is a
   * broken scan, and the test fails.
   */
  readonly rulesRun: number;
  readonly scanMs: number;
  /** How long axe took on the same state, for the cost comparison. */
  readonly axeMs: number;
  /** axe nodes on the same state, failures and incompletes. */
  readonly axeNodes: number;
  readonly findings: ReadonlyArray<IbmFinding & { readonly axe: readonly string[] }>;
}

export interface IbmRuleRow {
  readonly ruleId: string;
  /** The first message seen. Messages differ by node, so this is one example. */
  readonly message: string;
  readonly wcag: readonly string[];
  readonly nodes: number;
  /** Nodes axe also reported on the same surface, failed or marked for review. */
  readonly alsoAxe: number;
  /** Of `alsoAxe`, nodes axe failed. Only these leave the unique list. */
  readonly alsoFailedInAxe: number;
  /** Of `alsoAxe`, nodes axe only marked for review. They stay in the unique list. */
  readonly axeReviewOnly: number;
  /** The axe rules that matched, across all nodes. */
  readonly axeRules: readonly string[];
  readonly surfaces: readonly string[];
  readonly examples: ReadonlyArray<{ readonly surfaceId: string; readonly xpath: string }>;
}

type BucketCounts = { readonly [K in IbmBucket]: number };

export interface IbmSummary {
  /** The engine of the first record, or `null` for a run with none. */
  readonly engine: { readonly version: string; readonly ruleset: string } | null;
  readonly surfaces: number;
  readonly counts: BucketCounts;
  /** Of `counts`, how many nodes axe also reported, failed or marked for review. */
  readonly alsoAxe: BucketCounts;
  /** Of `alsoAxe`, nodes axe failed. */
  readonly alsoFailedInAxe: BucketCounts;
  /** Of `alsoAxe`, nodes axe only marked for review. */
  readonly axeReviewOnly: BucketCounts;
  readonly violations: readonly IbmRuleRow[];
  readonly needsReview: readonly IbmRuleRow[];
  readonly recommendations: readonly IbmRuleRow[];
  readonly bySurface: ReadonlyArray<{
    readonly surfaceId: string;
    readonly route: string;
    readonly violation: number;
    readonly needsReview: number;
    readonly recommendation: number;
    /** Violations axe did not report at all, neither failed nor marked for review. */
    readonly uniqueViolations: number;
    /** Violations axe only marked for review. They are in the unique list, labelled. */
    readonly violationsAxeReviewOnly: number;
    /** The unique list: violations axe did not fail. `uniqueViolations` plus the review-only ones. */
    readonly violationsNotFailedInAxe: number;
    /** IBM's scan time, and axe's on the same state. */
    readonly scanMs: number;
    readonly axeMs: number;
  }>;
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Most nodes first, then rule id. Rule ids are identifiers, so binary order. */
export function compareRows(a: IbmRuleRow, b: IbmRuleRow): number {
  return b.nodes - a.nodes || byId(a.ruleId, b.ruleId);
}

function parse(description: string | undefined): IbmSurfaceRecord | null {
  if (!description) return null;
  try {
    const r = JSON.parse(description) as IbmSurfaceRecord;
    return r && typeof r.surfaceId === 'string' && Array.isArray(r.findings) ? r : null;
  } catch {
    return null;
  }
}

/** Fold the annotations of every test into the summary's `ibm` block. Always an object. */
export function summarizeIbm(
  annotations: ReadonlyArray<{ readonly type: string; readonly description?: string }>,
): IbmSummary {
  const records = annotations
    .filter((a) => a.type === IBM_ANNOTATION)
    .map((a) => parse(a.description))
    .filter((r): r is IbmSurfaceRecord => r !== null)
    .sort((a, b) => byId(a.surfaceId, b.surfaceId));

  const rows: Record<IbmBucket, Map<string, IbmRuleRow>> = {
    violation: new Map(),
    needsReview: new Map(),
    recommendation: new Map(),
  };
  const zero = () => ({ violation: 0, needsReview: 0, recommendation: 0 });
  const counts = zero();
  const alsoAxe = zero();
  const alsoFailedInAxe = zero();
  const axeReviewOnly = zero();

  const bySurface = records.map((r) => {
    const per = zero();
    let uniqueViolations = 0;
    let violationsAxeReviewOnly = 0;
    for (const f of r.findings) {
      const bucket = bucketOf(f.level);
      const verdict = axeVerdict(f.axe);
      const failed = verdict === 'failed' ? 1 : 0;
      const review = verdict === 'review-only' ? 1 : 0;
      per[bucket] += 1;
      counts[bucket] += 1;
      alsoAxe[bucket] += failed + review;
      alsoFailedInAxe[bucket] += failed;
      axeReviewOnly[bucket] += review;
      if (bucket === 'violation' && verdict === 'none') uniqueViolations += 1;
      if (bucket === 'violation' && verdict === 'review-only') violationsAxeReviewOnly += 1;
      const prev = rows[bucket].get(f.ruleId);
      const examples = prev?.examples ?? [];
      rows[bucket].set(f.ruleId, {
        ruleId: f.ruleId,
        message: prev?.message ?? f.message,
        wcag: [...new Set([...(prev?.wcag ?? []), ...f.wcag])].sort(),
        nodes: (prev?.nodes ?? 0) + 1,
        alsoAxe: (prev?.alsoAxe ?? 0) + failed + review,
        alsoFailedInAxe: (prev?.alsoFailedInAxe ?? 0) + failed,
        axeReviewOnly: (prev?.axeReviewOnly ?? 0) + review,
        axeRules: [...new Set([...(prev?.axeRules ?? []), ...f.axe])].sort(),
        surfaces: [...new Set([...(prev?.surfaces ?? []), r.surfaceId])].sort(),
        examples:
          examples.length < EXAMPLES_KEPT
            ? [...examples, { surfaceId: r.surfaceId, xpath: f.xpath }]
            : examples,
      });
    }
    return {
      surfaceId: r.surfaceId,
      route: r.route,
      ...per,
      uniqueViolations,
      violationsAxeReviewOnly,
      violationsNotFailedInAxe: uniqueViolations + violationsAxeReviewOnly,
      scanMs: r.scanMs,
      axeMs: r.axeMs,
    };
  });

  const list = (bucket: IbmBucket) => [...rows[bucket].values()].sort(compareRows);
  return {
    engine: records[0]?.engine ?? null,
    surfaces: records.length,
    counts,
    alsoAxe,
    alsoFailedInAxe,
    axeReviewOnly,
    violations: list('violation'),
    needsReview: list('needsReview'),
    recommendations: list('recommendation'),
    bySurface,
  };
}
