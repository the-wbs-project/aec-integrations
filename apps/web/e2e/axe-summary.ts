/**
 * AECI-1876: the pure half of the axe sweep. No Playwright runtime here, so the
 * summary reporter and the Vitest unit spec (`axe-summary.unit.spec.ts`) can load it.
 *
 * `axe-sweep.ts` runs axe and splits the result with `partitionViolations()`.
 * It records one `axe-scan` annotation per test. `e2e-a11y/summary-reporter.ts`
 * folds those into the summary's `axe` block with `summarizeAxe()`.
 * `scripts/a11y-nightly-merge-summary.mjs` merges the blocks of several runs
 * with the same rules. Keep the two in step.
 */

/** The env flag. Only the exact value `1` turns the sweep on. */
export const E2E_AXE_FLAG = 'AECI_E2E_AXE';

export function axeSweepEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[E2E_AXE_FLAG] === '1';
}

/** The gate: the same tags as every PR axe scan (TESTING_STRATEGY §8.3). */
export const GATE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;
/** Report only. Never fails a run. */
export const REPORT_TAGS = ['wcag22aa', 'best-practice', 'experimental'] as const;

/** The annotation the summary reporter reads. One per test that reached the sweep. */
export const AXE_SCAN_ANNOTATION = 'axe-scan';
/** The annotation `axeOptOut()` writes. */
export const AXE_OPT_OUT_ANNOTATION = 'axe-opt-out';

/** One rule's violation on one test. */
export interface AxeFinding {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly helpUrl: string;
  readonly nodes: number;
  readonly targets: readonly string[];
  /** axe's explanation for the first node, cut short. */
  readonly summary?: string;
}

export type AxeScanStatus = 'scanned' | 'opted-out' | 'not-scanned';

/** What the `axe-scan` annotation carries, as JSON. */
export interface AxeScanRecord {
  readonly status: AxeScanStatus;
  /** Why the test was opted out or not scanned. */
  readonly reason?: string;
  readonly url?: string;
  /** Gate violations that fail the test. */
  readonly gate: readonly AxeFinding[];
  readonly report: readonly AxeFinding[];
  /** Gate violations listed in `axe-known-failures.ts`. They do not fail the test. */
  readonly known?: ReadonlyArray<{ readonly issue: string; readonly finding: AxeFinding }>;
}

/** The shape of an `axe-known-failures.ts` entry. */
export interface KnownFailureLike {
  readonly issue: string;
  readonly rule: string;
  readonly path: string;
  readonly targets?: readonly string[];
}

/**
 * Split the gate list by the known-failure list, for a page at `path`.
 * `stale` holds the entries for this page whose rule no longer fails.
 */
export function applyKnownFailures(
  path: string,
  gate: readonly AxeFinding[],
  entries: readonly KnownFailureLike[],
): {
  failing: AxeFinding[];
  known: Array<{ issue: string; finding: AxeFinding }>;
  stale: KnownFailureLike[];
} {
  const here = entries.filter((e) => e.path === path);
  const failing: AxeFinding[] = [];
  const known: Array<{ issue: string; finding: AxeFinding }> = [];
  for (const f of gate) {
    // With `targets`, every node must be a known one. Only the first few
    // selectors are kept, so a finding with more nodes than that never matches.
    const entry = here.find(
      (e) =>
        e.rule === f.id &&
        (!e.targets ||
          (f.nodes <= f.targets.length && f.targets.every((t) => e.targets!.includes(t)))),
    );
    if (entry) known.push({ issue: entry.issue, finding: f });
    else failing.push(f);
  }
  const stale = here.filter((e) => !gate.some((f) => f.id === e.rule));
  return { failing, known, stale };
}

export interface AxeViolationLike {
  readonly id: string;
  readonly impact?: string | null;
  readonly tags: readonly string[];
  readonly help: string;
  readonly helpUrl: string;
  readonly nodes: ReadonlyArray<{
    readonly target: ReadonlyArray<unknown>;
    readonly failureSummary?: string;
  }>;
}

const TARGETS_KEPT = 5;
const SUMMARY_KEPT = 300;

function targetText(target: ReadonlyArray<unknown>): string {
  return target.map((t) => (Array.isArray(t) ? t.join(' >>> ') : String(t))).join(' ');
}

function toFinding(v: AxeViolationLike): AxeFinding {
  return {
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.length,
    targets: v.nodes.slice(0, TARGETS_KEPT).map((n) => targetText(n.target)),
    summary: v.nodes[0]?.failureSummary?.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_KEPT),
  };
}

/** True when a rule belongs to the gate: a gate tag, and not experimental. */
export function isGateRule(tags: readonly string[]): boolean {
  if (tags.includes('experimental')) return false;
  return tags.some((t) => (GATE_TAGS as readonly string[]).includes(t));
}

/** Split one axe run into the gate list and the report list. */
export function partitionViolations(violations: readonly AxeViolationLike[]): {
  gate: AxeFinding[];
  report: AxeFinding[];
} {
  const gate: AxeFinding[] = [];
  const report: AxeFinding[] = [];
  for (const v of violations) {
    if (v.nodes.length === 0) continue;
    (isGateRule(v.tags) ? gate : report).push(toFinding(v));
  }
  return { gate, report };
}

/** NG0500 (hydration mismatch) and NG0602 (a disallowed call during hydration). */
export function isHydrationError(text: string): boolean {
  return /\bNG0(?:500|602)\b/.test(text);
}

/** Read an `axe-scan` annotation. A malformed one reads as `null`. */
export function parseScanRecord(description: string | undefined): AxeScanRecord | null {
  if (!description) return null;
  try {
    const parsed = JSON.parse(description) as AxeScanRecord;
    if (!parsed || typeof parsed.status !== 'string') return null;
    return {
      ...parsed,
      gate: Array.isArray(parsed.gate) ? parsed.gate : [],
      report: Array.isArray(parsed.report) ? parsed.report : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The summary's `axe` block
// ---------------------------------------------------------------------------

export const IMPACTS = ['critical', 'serious', 'moderate', 'minor'] as const;
export type Impact = (typeof IMPACTS)[number];

/** Distinct page paths kept per rule. */
export const PATHS_KEPT = 10;

/** One rule, across every test of the run. */
export interface AxeRuleSummary {
  readonly id: string;
  readonly impact: string | null;
  readonly help: string;
  readonly helpUrl: string;
  /** Tests whose end state broke the rule. */
  readonly tests: number;
  /** Nodes, summed over those tests. */
  readonly nodes: number;
  /** Distinct page paths, at most `PATHS_KEPT`. */
  readonly paths: readonly string[];
}

export interface AxeSummary {
  /** Gate-tag violations, one per test and rule, counted by impact. Known failures count. */
  readonly violationsByImpact: Record<Impact, number>;
  readonly scans: {
    readonly scanned: number;
    readonly optedOut: number;
    readonly notScanned: number;
  };
  readonly optOuts: ReadonlyArray<{ readonly title: string; readonly reason: string }>;
  /** Gate violations that failed their test, by rule. */
  readonly gate: { readonly tags: readonly string[]; readonly rules: readonly AxeRuleSummary[] };
  /** Gate violations listed in `axe-known-failures.ts`, by issue and rule. */
  readonly knownFailures: ReadonlyArray<{
    readonly issue: string;
    readonly rule: string;
    readonly tests: number;
  }>;
  readonly reportOnly: {
    readonly tags: readonly string[];
    readonly rules: readonly AxeRuleSummary[];
  };
}

function pathOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function impactRank(impact: string | null): number {
  const i = (IMPACTS as readonly string[]).indexOf(impact ?? '');
  return i === -1 ? IMPACTS.length : i;
}

/** Most severe first, then most tests, then rule id. */
export function compareRules(a: AxeRuleSummary, b: AxeRuleSummary): number {
  return (
    impactRank(a.impact) - impactRank(b.impact) ||
    b.tests - a.tests ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function groupByRule(
  rows: ReadonlyArray<{ readonly url?: string; readonly findings: readonly AxeFinding[] }>,
): AxeRuleSummary[] {
  const byId = new Map<string, { rule: AxeRuleSummary; paths: Set<string> }>();
  for (const row of rows) {
    const path = pathOf(row.url);
    for (const f of row.findings) {
      const prev = byId.get(f.id);
      const paths = prev?.paths ?? new Set<string>();
      if (path && paths.size < PATHS_KEPT) paths.add(path);
      const impact =
        prev && impactRank(prev.rule.impact) <= impactRank(f.impact) ? prev.rule.impact : f.impact;
      byId.set(f.id, {
        paths,
        rule: {
          id: f.id,
          impact,
          help: f.help,
          helpUrl: f.helpUrl,
          tests: (prev?.rule.tests ?? 0) + 1,
          nodes: (prev?.rule.nodes ?? 0) + f.nodes,
          paths: [],
        },
      });
    }
  }
  return [...byId.values()]
    .map(({ rule, paths }) => ({ ...rule, paths: [...paths].sort() }))
    .sort(compareRules);
}

/**
 * Fold every test's scan record into the summary's `axe` block. `null` when no
 * test reached the sweep, which is a run with the flag off.
 */
export function summarizeAxe(
  tests: ReadonlyArray<{ readonly title: string; readonly scan: AxeScanRecord | null }>,
): AxeSummary | null {
  const scans = tests.filter((t) => t.scan !== null) as Array<{
    title: string;
    scan: AxeScanRecord;
  }>;
  if (scans.length === 0) return null;
  const violationsByImpact: Record<Impact, number> = {
    critical: 0,
    serious: 0,
    moderate: 0,
    minor: 0,
  };
  for (const { scan } of scans) {
    for (const f of [...scan.gate, ...(scan.known ?? []).map((k) => k.finding)]) {
      const impact = (IMPACTS as readonly string[]).includes(f.impact ?? '')
        ? (f.impact as Impact)
        : 'minor';
      violationsByImpact[impact] += 1;
    }
  }
  const count = (status: AxeScanStatus): number =>
    scans.filter((t) => t.scan.status === status).length;
  const known = new Map<string, { issue: string; rule: string; tests: number }>();
  for (const { scan } of scans) {
    for (const k of scan.known ?? []) {
      const key = `${k.issue} ${k.finding.id}`;
      const prev = known.get(key);
      known.set(key, { issue: k.issue, rule: k.finding.id, tests: (prev?.tests ?? 0) + 1 });
    }
  }
  return {
    violationsByImpact,
    scans: {
      scanned: count('scanned'),
      optedOut: count('opted-out'),
      notScanned: count('not-scanned'),
    },
    optOuts: scans
      .filter((t) => t.scan.status === 'opted-out')
      .map((t) => ({ title: t.title, reason: t.scan.reason ?? '' })),
    gate: {
      tags: [...GATE_TAGS],
      rules: groupByRule(scans.map((t) => ({ url: t.scan.url, findings: t.scan.gate }))),
    },
    knownFailures: [...known.values()].sort((a, b) =>
      a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : a.rule < b.rule ? -1 : 1,
    ),
    reportOnly: {
      tags: [...REPORT_TAGS],
      rules: groupByRule(scans.map((t) => ({ url: t.scan.url, findings: t.scan.report }))),
    },
  };
}
