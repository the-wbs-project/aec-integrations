#!/usr/bin/env node
/**
 * Merge the accessibility nightly's run summaries into one (AECI-1876).
 *
 * The nightly runs two Playwright lanes: the `e2e-a11y/` suite, and the e2e suite with the
 * axe sweep on, in shards. Each run writes a summary with `apps/web/e2e-a11y/summary-reporter.ts`.
 * The `report` job in `.github/workflows/a11y-nightly.yml` merges them into the one
 * `a11y-nightly-summary.json` the alert reads (`scripts/a11y-nightly-alert.mjs`), and writes the
 * axe findings to the job summary, grouped by rule.
 *
 *   node scripts/a11y-nightly-merge-summary.mjs --out=<file> [--markdown=<file>] <part.json>...
 *
 * A part that is missing or unreadable is named in `parts` and makes the merged `status`
 * `failed`, so a lane that died before its reporter ran is never read as green.
 *
 * The rule grouping matches `summarizeAxe()` in `apps/web/e2e/axe-summary.ts`. Keep the two in
 * step. The `voice` block (AECI-1883) matches `summarizeVoice()` in
 * `apps/web/e2e-a11y/support/voice-summary.ts`, and the job summary gets its effort table, its
 * target size report and its input purpose count. The `ibm` block (AECI-1884) matches `summarizeIbm()` in
 * `apps/web/e2e-a11y/support/ibm-overlap.ts`, and the job summary gets its unique violations (axe
 * did not fail them, review-only ones labelled), every violation, and the "needs review" and
 * recommendation lists collapsed. AECI-1885 added the Firefox and WebKit lane: each test row
 * names its `browser`, and `browsers` counts the outcomes per browser for the "By browser"
 * table. No dependencies, so the job needs no
 * `pnpm install`.
 *
 * Exit codes: 0 merged, 2 a flag is wrong or no part was given.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const IMPACTS = ['critical', 'serious', 'moderate', 'minor'];
export const PATHS_KEPT = 10;
/** Rows per table in the job summary. The JSON has them all. */
const MARKDOWN_ROWS = 40;
/** Worst first. */
const STATUS_ORDER = ['failed', 'timedout', 'interrupted', 'passed'];

function impactRank(impact) {
  const i = IMPACTS.indexOf(impact ?? '');
  return i === -1 ? IMPACTS.length : i;
}

/** Most severe first, then most tests, then rule id. Same order as `compareRules()`. */
export function compareRules(a, b) {
  return (
    impactRank(a.impact) - impactRank(b.impact) ||
    b.tests - a.tests ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Merge rule lists from several runs by rule id. */
export function mergeRules(lists) {
  const byId = new Map();
  for (const rule of lists.flat()) {
    const prev = byId.get(rule.id);
    if (!prev) {
      byId.set(rule.id, { ...rule, paths: [...new Set(rule.paths ?? [])].slice(0, PATHS_KEPT) });
      continue;
    }
    const paths = new Set(prev.paths);
    for (const p of rule.paths ?? []) if (paths.size < PATHS_KEPT) paths.add(p);
    byId.set(rule.id, {
      ...prev,
      impact: impactRank(prev.impact) <= impactRank(rule.impact) ? prev.impact : rule.impact,
      tests: prev.tests + rule.tests,
      nodes: prev.nodes + rule.nodes,
      paths: [...paths],
    });
  }
  return [...byId.values()].map((r) => ({ ...r, paths: [...r.paths].sort() })).sort(compareRules);
}

/** Merge known-failure lists by issue and rule. */
export function mergeKnown(lists) {
  const byKey = new Map();
  for (const k of lists.flat()) {
    const key = `${k.issue} ${k.rule}`;
    const prev = byKey.get(key);
    byKey.set(key, {
      issue: k.issue,
      rule: k.rule,
      tests: (prev?.tests ?? 0) + (Number(k.tests) || 0),
    });
  }
  return [...byKey.values()].sort((a, b) =>
    a.issue < b.issue ? -1 : a.issue > b.issue ? 1 : a.rule < b.rule ? -1 : 1,
  );
}

/** Merge the `axe` blocks. Always an object: all zeros when no part had one. */
export function mergeAxe(blocks) {
  const present = blocks.filter((b) => b && typeof b === 'object');
  const sum = (pick) => present.reduce((n, b) => n + (Number(pick(b)) || 0), 0);
  return {
    violationsByImpact: Object.fromEntries(
      IMPACTS.map((i) => [i, sum((b) => b.violationsByImpact?.[i])]),
    ),
    scans: {
      scanned: sum((b) => b.scans?.scanned),
      optedOut: sum((b) => b.scans?.optedOut),
      notScanned: sum((b) => b.scans?.notScanned),
    },
    optOuts: present.flatMap((b) => b.optOuts ?? []),
    gate: {
      tags: present[0]?.gate?.tags ?? [],
      rules: mergeRules(present.map((b) => b.gate?.rules ?? [])),
    },
    knownFailures: mergeKnown(present.map((b) => b.knownFailures ?? [])),
    reportOnly: {
      tags: present[0]?.reportOnly?.tags ?? [],
      rules: mergeRules(present.map((b) => b.reportOnly?.rules ?? [])),
    },
  };
}

const bySurfaceId = (a, b) => (a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : 0);

/**
 * Merge the `voice` blocks (AECI-1883). A surface's `controls` and `effort`
 * tests can land on different shards. Each writes a different list, `controls`
 * the target size row and `effort` the effort row, and each test runs once, so
 * every row comes from exactly one shard and the lists join. Always an object:
 * empty lists when no part had one. Matches
 * `summarizeVoice()` in `apps/web/e2e-a11y/support/voice-summary.ts`.
 */
export function mergeVoice(blocks) {
  const present = blocks.filter((b) => b && typeof b === 'object');
  const effort = present.flatMap((b) => b.effort ?? []).sort(bySurfaceId);
  const bySurface = present.flatMap((b) => b.targetSize?.bySurface ?? []).sort(bySurfaceId);
  // A part written before the input purpose record existed has no `inputPurpose`.
  const purposes = present.flatMap((b) => b.inputPurpose?.bySurface ?? []).sort(bySurfaceId);
  const fields = purposes.flatMap((p) => p.fields ?? []);
  return {
    effort,
    targetSize: {
      surfaces: bySurface.length,
      targets: bySurface.reduce((n, s) => n + (s.targets?.length ?? 0), 0),
      bySurface,
    },
    inputPurpose: {
      surfaces: purposes.length,
      fields: fields.length,
      judged: fields.filter((f) => f.purpose !== null).length,
      bySurface: purposes,
    },
  };
}

/** Examples kept per rule. Matches `EXAMPLES_KEPT` in `ibm-overlap.ts`. */
export const IBM_EXAMPLES_KEPT = 3;
const IBM_BUCKETS = ['violation', 'needsReview', 'recommendation'];
const IBM_LISTS = {
  violation: 'violations',
  needsReview: 'needsReview',
  recommendation: 'recommendations',
};
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Merge IBM rule rows from several shards by rule id. Most nodes first, then rule id. */
export function mergeIbmRows(lists) {
  const byId = new Map();
  for (const row of lists.flat()) {
    const prev = byId.get(row.ruleId);
    if (!prev) {
      byId.set(row.ruleId, {
        ...row,
        examples: (row.examples ?? []).slice(0, IBM_EXAMPLES_KEPT),
      });
      continue;
    }
    byId.set(row.ruleId, {
      ...prev,
      wcag: [...new Set([...prev.wcag, ...(row.wcag ?? [])])].sort(byText),
      nodes: prev.nodes + (Number(row.nodes) || 0),
      alsoAxe: prev.alsoAxe + (Number(row.alsoAxe) || 0),
      alsoFailedInAxe: (prev.alsoFailedInAxe ?? 0) + (Number(row.alsoFailedInAxe) || 0),
      axeReviewOnly: (prev.axeReviewOnly ?? 0) + (Number(row.axeReviewOnly) || 0),
      axeRules: [...new Set([...prev.axeRules, ...(row.axeRules ?? [])])].sort(byText),
      surfaces: [...new Set([...prev.surfaces, ...(row.surfaces ?? [])])].sort(byText),
      examples: [...prev.examples, ...(row.examples ?? [])].slice(0, IBM_EXAMPLES_KEPT),
    });
  }
  return [...byId.values()].sort((a, b) => b.nodes - a.nodes || byText(a.ruleId, b.ruleId));
}

/**
 * Merge the `ibm` blocks (AECI-1884). Each surface is one test, so its surface
 * row comes from exactly one shard and the rows join. The rule rows merge by id. Always an object: zero
 * counts and empty lists when no part had one. Matches `summarizeIbm()` in
 * `apps/web/e2e-a11y/support/ibm-overlap.ts`.
 */
export function mergeIbm(blocks) {
  const present = blocks.filter((b) => b && typeof b === 'object');
  const sum = (key) =>
    Object.fromEntries(
      IBM_BUCKETS.map((k) => [k, present.reduce((n, b) => n + (Number(b[key]?.[k]) || 0), 0)]),
    );
  const bySurface = present.flatMap((b) => b.bySurface ?? []).sort(bySurfaceId);
  return {
    engine: present.map((b) => b.engine).find((e) => e) ?? null,
    surfaces: bySurface.length,
    counts: sum('counts'),
    alsoAxe: sum('alsoAxe'),
    alsoFailedInAxe: sum('alsoFailedInAxe'),
    axeReviewOnly: sum('axeReviewOnly'),
    ...Object.fromEntries(
      IBM_BUCKETS.map((k) => [
        IBM_LISTS[k],
        mergeIbmRows(present.map((b) => b[IBM_LISTS[k]] ?? [])),
      ]),
    ),
    bySurface,
  };
}

/** Read one part. Never throws. */
export function readPart(path) {
  if (!existsSync(path)) return { path, found: false, error: 'missing' };
  try {
    const summary = JSON.parse(readFileSync(path, 'utf8'));
    if (!summary || typeof summary !== 'object' || !Array.isArray(summary.tests)) {
      throw new Error('expected an object with a tests array');
    }
    return { path, found: true, summary };
  } catch (err) {
    return { path, found: false, error: `unreadable: ${err?.message ?? err}` };
  }
}

/** The browsers in the order the job summary lists them. Any other name sorts after, by name. */
export const BROWSER_ORDER = ['chromium', 'firefox', 'webkit'];

function browserRank(name) {
  const i = BROWSER_ORDER.indexOf(name);
  return i === -1 ? BROWSER_ORDER.length : i;
}

/**
 * Per-browser test counts (AECI-1885), from each test row's `browser`. A row
 * from a part written before the field existed counts under `unknown`. The
 * counts use the same buckets as `totals`, plus `flaky`, which `totals` counts
 * as passed.
 */
export function browserTotals(tests) {
  const by = new Map();
  for (const t of tests) {
    const name = typeof t?.browser === 'string' && t.browser ? t.browser : 'unknown';
    const row = by.get(name) ?? {
      browser: name,
      passed: 0,
      failed: 0,
      skipped: 0,
      expectedFailures: 0,
      flaky: 0,
    };
    switch (t?.outcome) {
      case 'flaky':
        row.flaky++;
        row.passed++;
        break;
      case 'failed':
        row.failed++;
        break;
      case 'skipped':
        row.skipped++;
        break;
      case 'expected-failure':
        row.expectedFailures++;
        break;
      case 'passed':
        row.passed++;
        break;
      // An outcome this script does not know is counted nowhere.
    }
    by.set(name, row);
  }
  return [...by.values()].sort(
    (a, b) => browserRank(a.browser) - browserRank(b.browser) || byText(a.browser, b.browser),
  );
}

/** Merge parts read with `readPart()`. `now` is for tests. */
export function mergeSummaries(parts, now = new Date()) {
  const found = parts.filter((p) => p.found).map((p) => p.summary);
  const first = (key) => found.map((s) => s[key]).find((v) => v !== null && v !== undefined);
  const total = (key) => found.reduce((n, s) => n + (Number(s.totals?.[key]) || 0), 0);
  let status = found
    .map((s) => s.status)
    .sort((a, b) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))[0];
  if (!status || parts.some((p) => !p.found)) status = 'failed';
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    commitSha: first('commitSha') ?? null,
    trigger: first('trigger') ?? 'manual',
    runUrl: first('runUrl') ?? null,
    status,
    totals: {
      passed: total('passed'),
      failed: total('failed'),
      skipped: total('skipped'),
      expectedFailures: total('expectedFailures'),
    },
    parts: parts.map((p) => ({ file: p.path, found: p.found, error: p.error ?? null })),
    tests: found.flatMap((s) => s.tests),
    // AECI-1885: the same counts per browser, from each test row's `browser`.
    // Merged files only. Adding it kept `schemaVersion` 1.
    browsers: browserTotals(found.flatMap((s) => s.tests)),
    // AECI-1874: every known-failure ID once, with its test count, from every
    // test's `knownFailures` list. Merged files only; a lane file has the rows.
    knownFailures: knownFailureCounts(found.flatMap((s) => s.tests)),
    axe: mergeAxe(found.map((s) => s.axe)),
    voice: mergeVoice(found.map((s) => s.voice)),
    ibm: mergeIbm(found.map((s) => s.ibm)),
  };
}

/** The voice-control section of the job summary (AECI-1883). Empty when no part ran the checks. */
function voiceMarkdown(voice) {
  if (!voice || (voice.effort.length === 0 && voice.targetSize.surfaces === 0)) return [];
  const lines = ['', '### Voice control and switch (AECI-1883)', ''];
  if (voice.effort.length > 0) {
    const signed = (n) => (n === null ? 'not reached' : n > 0 ? `+${n}` : String(n));
    lines.push(
      "Tab presses from load to each surface's primary action. A change above the margin fails the run.",
      '',
      '| Surface | Primary action | Presses | Baseline | Change | Margin |',
      '|---|---|---|---|---|---|',
      ...voice.effort
        .slice(0, MARKDOWN_ROWS)
        .map(
          (e) =>
            `| \`${cell(e.surfaceId)}\` | ${cell(e.action)} | ${e.presses ?? '-'} | ${e.baseline} | ${signed(
              e.change,
            )} | ${e.margin} |`,
        ),
      '',
    );
  }
  const t = voice.targetSize;
  const all = t.bySurface.flatMap((s) => s.targets);
  const fails = all.filter((x) => x.verdict !== 'review').length;
  lines.push(
    `Target size (WCAG 2.5.8), report only: ${fails} targets fail and ${all.length - fails} need review, on ${
      t.bySurface.filter((s) => s.targets.length > 0).length
    } of ${t.surfaces} surfaces. A target fails below 24 by 24px without the spacing the rule allows.`,
  );
  const hit = t.bySurface.filter((s) => s.targets.length > 0).slice(0, MARKDOWN_ROWS);
  if (hit.length > 0) {
    lines.push(
      '',
      '| Surface | Fail | Review | First three |',
      '|---|---|---|---|',
      ...hit.map((s) => {
        const sFails = s.targets.filter((x) => x.verdict !== 'review').length;
        return `| \`${cell(s.surfaceId)}\` | ${sFails} | ${s.targets.length - sFails} | ${cell(
          s.targets
            .slice(0, 3)
            .map((x) => `\`${x.target}\``)
            .join(', '),
        )} |`;
      }),
    );
  }
  const p = voice.inputPurpose;
  if (p && p.surfaces > 0) {
    const judgedOn = p.bySurface.filter((s) =>
      (s.fields ?? []).some((f) => f.purpose !== null),
    ).length;
    lines.push(
      '',
      `Input purpose (WCAG 1.3.5): ${p.judged} of ${p.fields} text fields held to a purpose, on ${judgedOn} of ${p.surfaces} surfaces. The rest have no purpose to check, such as a search box.`,
    );
  }
  return lines;
}

function ibmRuleTable(rows) {
  if (rows.length === 0) return ['None.'];
  const shown = rows.slice(0, MARKDOWN_ROWS);
  const lines = [
    '| Rule | WCAG | Nodes | Failed in axe | axe review only | axe rules | Surfaces |',
    '|---|---|---|---|---|---|---|',
    ...shown.map(
      (r) =>
        `| \`${cell(r.ruleId)}\` | ${cell(r.wcag.join(', ') || '-')} | ${r.nodes} | ${
          r.alsoFailedInAxe ?? 0
        } | ${r.axeReviewOnly ?? 0} | ${cell(r.axeRules.map((a) => `\`${a}\``).join(', ') || '-')} | ${cell(
          r.surfaces.map((x) => `\`${x}\``).join(', '),
        )} |`,
    ),
  ];
  if (rows.length > shown.length) {
    lines.push('', `${rows.length - shown.length} more rules. The summary artifact has them.`);
  }
  return lines;
}

/**
 * The unique violations: nodes axe did not fail. A node axe only marked for
 * review stays here, counted in its own column.
 */
function ibmUniqueTable(rows) {
  const unique = rows
    .map((r) => ({ ...r, notFailed: r.nodes - (r.alsoFailedInAxe ?? 0) }))
    .filter((r) => r.notFailed > 0)
    .sort((a, b) => b.notFailed - a.notFailed || byText(a.ruleId, b.ruleId));
  if (unique.length === 0) return ['None.'];
  const shown = unique.slice(0, MARKDOWN_ROWS);
  const lines = [
    '| Rule | WCAG | Not failed in axe | Of them, axe review only | Not in axe at all | Surfaces |',
    '|---|---|---|---|---|---|',
    ...shown.map(
      (r) =>
        `| \`${cell(r.ruleId)}\` | ${cell(r.wcag.join(', ') || '-')} | ${r.notFailed} | ${
          r.axeReviewOnly ?? 0
        } | ${r.notFailed - (r.axeReviewOnly ?? 0)} | ${cell(r.surfaces.map((x) => `\`${x}\``).join(', '))} |`,
    ),
  ];
  if (unique.length > shown.length) {
    lines.push('', `${unique.length - shown.length} more rules. The summary artifact has them.`);
  }
  return lines;
}

/** The IBM Equal Access section of the job summary (AECI-1884). Empty when no part ran it. */
function ibmMarkdown(ibm) {
  if (!ibm || ibm.surfaces === 0) return [];
  const c = ibm.counts;
  const failed = ibm.alsoFailedInAxe ?? { violation: 0, needsReview: 0, recommendation: 0 };
  const review = ibm.axeReviewOnly ?? { violation: 0, needsReview: 0, recommendation: 0 };
  const engine = ibm.engine
    ? ` \`accessibility-checker-engine\` ${ibm.engine.version}, ruleset \`${ibm.engine.ruleset}\`.`
    : '';
  const notFailed = c.violation - failed.violation;
  return [
    '',
    '### IBM Equal Access, report only (AECI-1884)',
    '',
    `A second rule engine on ${ibm.surfaces} surfaces.${engine} These never fail the run. axe is the gate.`,
    '',
    `Violations: ${c.violation} nodes. axe also failed ${failed.violation}. ` +
      `axe only marked ${review.violation} for review. ${notFailed - review.violation} are not in axe at all.`,
    '',
    `#### Unique to IBM: ${notFailed} nodes axe did not fail`,
    '',
    ...ibmUniqueTable(ibm.violations),
    '',
    '#### Every violation',
    '',
    ...ibmRuleTable(ibm.violations),
    '',
    '<details>',
    `<summary>Needs review: ${c.needsReview} nodes (${failed.needsReview} failed in axe, ${review.needsReview} axe review only). Recommendations: ${c.recommendation} nodes (${failed.recommendation} failed in axe, ${review.recommendation} axe review only).</summary>`,
    '',
    '#### Needs review',
    '',
    ...ibmRuleTable(ibm.needsReview),
    '',
    '#### Recommendations',
    '',
    ...ibmRuleTable(ibm.recommendations),
    '',
    '</details>',
  ];
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function ruleTable(rules) {
  if (rules.length === 0) return ['None.'];
  const shown = rules.slice(0, MARKDOWN_ROWS);
  const lines = [
    '| Rule | Impact | Tests | Nodes | Pages |',
    '|---|---|---|---|---|',
    ...shown.map(
      (r) =>
        `| [\`${cell(r.id)}\`](${r.helpUrl}) | ${cell(r.impact ?? '-')} | ${r.tests} | ${r.nodes} | ${cell(
          r.paths.map((p) => `\`${p}\``).join(', '),
        )} |`,
    ),
  ];
  if (rules.length > shown.length) {
    lines.push('', `${rules.length - shown.length} more rules. The summary artifact has them.`);
  }
  return lines;
}

/** A test's known-failure IDs. A summary from before AECI-1874's list has only `knownFailure`. */
export function knownFailuresOf(test) {
  if (Array.isArray(test?.knownFailures)) return test.knownFailures.map(String);
  return test?.knownFailure ? [String(test.knownFailure)] : [];
}

function issueNumber(id) {
  return Number(String(id).match(/\d+$/)?.[0] ?? Number.MAX_SAFE_INTEGER);
}

/**
 * Every known-failure ID in the run, once, with the number of tests that carry it.
 * In issue number order. A test with three marks counts once for each of the three.
 * `tests` is the total over every browser, as before. `byBrowser` splits it by each
 * test row's `browser` (AECI-1885): a check marked in three browsers is three tests.
 * A row from before the field counts under `unknown`.
 */
export function knownFailureCounts(tests) {
  const byIssue = new Map();
  for (const t of tests) {
    const browser = typeof t?.browser === 'string' && t.browser ? t.browser : 'unknown';
    for (const id of new Set(knownFailuresOf(t))) {
      const entry = byIssue.get(id) ?? { tests: 0, byBrowser: {} };
      entry.tests++;
      entry.byBrowser[browser] = (entry.byBrowser[browser] ?? 0) + 1;
      byIssue.set(id, entry);
    }
  }
  return [...byIssue.entries()]
    .map(([issue, e]) => ({ issue, tests: e.tests, byBrowser: sortedByBrowser(e.byBrowser) }))
    .sort((a, b) => issueNumber(a.issue) - issueNumber(b.issue) || (a.issue < b.issue ? -1 : 1));
}

function sortedByBrowser(counts) {
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => browserRank(a) - browserRank(b) || byText(a, b)),
  );
}

/** The per-browser table (AECI-1885). Empty when the run has no test rows. */
function browserMarkdown(rows) {
  if (rows.length === 0) return [];
  return [
    '',
    '### By browser',
    '',
    '| Browser | Passed | Failed | Skipped | Known failures | Flaky |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${cell(r.browser)} | ${r.passed} | ${r.failed} | ${r.skipped} | ${r.expectedFailures} | ${r.flaky} |`,
    ),
  ];
}

function knownFailureMarkdown(counts) {
  if (counts.length === 0) return [];
  const browsers = [...new Set(counts.flatMap((k) => Object.keys(k.byBrowser ?? {})))].sort(
    (a, b) => browserRank(a) - browserRank(b) || byText(a, b),
  );
  return [
    '',
    `### Known failures (${counts.length} issues)`,
    '',
    `| Issue | Tests |${browsers.map((b) => ` ${cell(b)} |`).join('')}`,
    `|---|---|${browsers.map(() => '---|').join('')}`,
    ...counts.map(
      (k) =>
        `| ${cell(k.issue)} | ${k.tests} |${browsers
          .map((b) => ` ${k.byBrowser?.[b] ?? 0} |`)
          .join('')}`,
    ),
  ];
}

/** The job summary. */
export function summaryMarkdown(merged) {
  const t = merged.totals;
  const lines = [
    '## Accessibility nightly',
    '',
    `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped, ${t.expectedFailures} known failures. Status: ${merged.status}.`,
  ];
  const missing = merged.parts.filter((p) => !p.found);
  if (missing.length > 0) {
    lines.push('', `Missing summaries: ${missing.map((p) => `\`${p.file}\``).join(', ')}.`);
  }
  lines.push(...browserMarkdown(merged.browsers ?? browserTotals(merged.tests ?? [])));
  lines.push(
    ...knownFailureMarkdown(merged.knownFailures ?? knownFailureCounts(merged.tests ?? [])),
  );
  const axe = merged.axe;
  const reached = axe.scans.scanned + axe.scans.optedOut + axe.scans.notScanned;
  if (reached === 0) {
    lines.push(
      '',
      'No test reached the e2e axe sweep.',
      ...voiceMarkdown(merged.voice),
      ...ibmMarkdown(merged.ibm),
    );
    return `${lines.join('\n')}\n`;
  }
  const v = axe.violationsByImpact;
  lines.push(
    '',
    '### The e2e axe sweep',
    '',
    `${axe.scans.scanned} scanned, ${axe.scans.optedOut} opted out, ${axe.scans.notScanned} not scanned.`,
    '',
    `Gate violations (${axe.gate.tags.join(', ')}): ${v.critical} critical, ${v.serious} serious, ${v.moderate} moderate, ${v.minor} minor.`,
    '',
    ...ruleTable(axe.gate.rules),
    '',
    `Known failures: ${
      axe.knownFailures.length === 0
        ? 'none'
        : axe.knownFailures.map((k) => `${k.issue} (\`${k.rule}\`, tests: ${k.tests})`).join(', ')
    }.`,
    '',
    `### Report only (${axe.reportOnly.tags.join(', ')})`,
    '',
    'These never fail the run.',
    '',
    ...ruleTable(axe.reportOnly.rules),
    ...voiceMarkdown(merged.voice),
    ...ibmMarkdown(merged.ibm),
  );
  return `${lines.join('\n')}\n`;
}

export function main(argv, { log = console.log, error = console.error } = {}) {
  const flags = {};
  const files = [];
  for (const arg of argv) {
    const m = arg.match(/^--([a-z-]+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
    else if (arg.startsWith('--')) {
      error(`unknown flag ${arg}`);
      return 2;
    } else files.push(arg);
  }
  if (!flags.out) {
    error('--out=<file> is required');
    return 2;
  }
  if (files.length === 0) {
    error('give at least one summary file');
    return 2;
  }
  const merged = mergeSummaries(files.map(readPart));
  writeFileSync(flags.out, `${JSON.stringify(merged, null, 2)}\n`);
  if (flags.markdown) appendFileSync(flags.markdown, summaryMarkdown(merged));
  const t = merged.totals;
  log(
    `Merged ${files.length} summaries into ${flags.out}: ${t.passed} passed, ${t.failed} failed, ` +
      `${t.skipped} skipped, ${t.expectedFailures} known failures. Status: ${merged.status}.`,
  );
  for (const p of merged.parts.filter((x) => !x.found)) log(`Missing: ${p.file} (${p.error}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
