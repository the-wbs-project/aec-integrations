/**
 * AECI-1884: run IBM Equal Access and axe on the same page state.
 *
 * THE ENGINE. `accessibility-checker-engine`, pinned to an exact version in
 * `apps/web/package.json`. It is IBM's rule engine as one browser script,
 * `ace.js`, with no dependencies and no install scripts. We read it from
 * `node_modules` and evaluate it in the page, as `@axe-core/playwright` does
 * with axe. Nothing is fetched.
 *
 * Not the `accessibility-checker` wrapper. At run time the wrapper downloads
 * the engine and its rule list from jsDelivr (`ruleServer`, rule archive
 * `latest`), `require`s a downloaded `ace-node.js` in Node, and sends scan
 * metrics to `able.ibm.com`. Its `postinstall` runs IBM's telemetry collector.
 * `docs/TESTING_STRATEGY.md` §8.4.9 has the full vetting.
 *
 * THE GUARD. `watchRequests` records every request the page starts while the
 * engine runs. `ace.js` has no network code, so the list should be empty. The
 * spec fails on any request to another host, because page data could then
 * leave the runner.
 *
 * Results under `EXCLUDED_DOM` (from the axe sweep) are dropped from both
 * engines, so neither judges DOM that is not ours.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import type { Page, Request } from '@playwright/test';
import { GATE_TAGS, REPORT_TAGS } from '../../e2e/axe-summary';
import { EXCLUDED_DOM } from '../../e2e/axe-sweep';
import { levelOf, wcagFromAxeTags, type AxeNode, type IbmFinding } from './ibm-overlap';

/** IBM's default ruleset: its requirements, which cover WCAG 2.2 A and AA and more. */
export const IBM_RULESET = 'IBM_Accessibility';

const ENGINE_DIR = dirname(require.resolve('accessibility-checker-engine/package.json'));

/** The installed engine's version, read from its own `package.json`. */
export const IBM_ENGINE_VERSION: string = (
  JSON.parse(readFileSync(join(ENGINE_DIR, 'package.json'), 'utf8')) as { version: string }
).version;

/**
 * One XPath function for both engines, so their keys compare as strings. Lower
 * case tag names, 1-based index among same-tag siblings: `/html[1]/body[1]/div[2]`.
 */
const XPATH_HELPER = `window.__aeciXPath = function (el) {
  var parts = [];
  for (var e = el; e; e = e.parentElement) {
    var i = 1;
    for (var s = e.previousElementSibling; s; s = s.previousElementSibling) {
      if (s.tagName === e.tagName) i += 1;
    }
    parts.unshift(e.tagName.toLowerCase() + '[' + i + ']');
  }
  return parts.length > 0 ? '/' + parts.join('/') : '';
};`;

let script: string | null = null;

/**
 * `ace.js` and the XPath helper. The engine is wrapped in a function so its
 * `var ace` stays local, and only `window.__aeciIbmAce` is added to the page.
 */
function injectedScript(): string {
  script ??= `(function () {\n${readFileSync(join(ENGINE_DIR, 'ace.js'), 'utf8')}\n;window.__aeciIbmAce = ace;\n})();\n${XPATH_HELPER}`;
  return script;
}

/** Put the engine and the XPath helper in the page. Call once, before both runs. */
export async function injectEngines(page: Page): Promise<void> {
  await page.evaluate(injectedScript());
}

/** Record the URL of every request the page starts until `stop()`. */
export function watchRequests(page: Page): { stop: () => string[] } {
  const seen: string[] = [];
  const onRequest = (req: Request) => seen.push(req.url());
  page.on('request', onRequest);
  return {
    stop: () => {
      page.off('request', onRequest);
      return seen;
    },
  };
}

export interface IbmRun {
  readonly rulesRun: number;
  readonly scanMs: number;
  readonly findings: readonly IbmFinding[];
}

type XPathWindow = Window & { __aeciXPath: (el: Element) => string };

/**
 * Run the ruleset on the whole document and return every result that is not a
 * pass. Throws when the engine is missing or the check fails, so a broken scan
 * is never read as a clean one.
 */
export async function runIbm(page: Page): Promise<IbmRun> {
  const raw = await page.evaluate(
    async ({ ruleset, excluded }) => {
      type Result = {
        ruleId: string;
        reasonId: string | number;
        value: [string, string];
        message: string;
        node?: Node | null;
        path?: { dom?: string };
      };
      type Checker = {
        getGuidelines(): Array<{
          id: string;
          checkpoints: Array<{ num: string; rules?: Array<{ id: string }> }>;
        }>;
        check(doc: Document, ids: string[]): Promise<{ results: Result[] }>;
      };
      const w = window as unknown as XPathWindow & {
        __aeciIbmAce?: { Checker: new () => Checker };
      };
      if (!w.__aeciIbmAce) throw new Error('the IBM engine did not load into the page');
      const checker = new w.__aeciIbmAce.Checker();
      const guideline = checker.getGuidelines().find((g) => g.id === ruleset);
      if (!guideline) throw new Error(`the IBM engine has no ruleset ${ruleset}`);
      // Rule id to its WCAG criteria. `HTML` and `ARIA` are IBM groups, not criteria.
      const wcag: Record<string, string[]> = {};
      for (const cp of guideline.checkpoints) {
        for (const r of cp.rules ?? []) {
          if (/^\d+\.\d+\.\d+$/.test(cp.num)) (wcag[r.id] ??= []).push(cp.num);
        }
      }
      const start = performance.now();
      const report = await checker.check(document, [ruleset]);
      const scanMs = Math.round(performance.now() - start);
      const out = [];
      for (const r of report.results) {
        if (r.value[1] === 'PASS') continue;
        const node = r.node ?? null;
        const el =
          node instanceof Element
            ? node
            : node instanceof Document
              ? node.documentElement
              : (node?.parentElement ?? null);
        if (el && excluded.some((sel) => el.closest(sel))) continue;
        out.push({
          ruleId: r.ruleId,
          reasonId: String(r.reasonId),
          value: r.value,
          message: r.message,
          wcag: [...new Set(wcag[r.ruleId] ?? [])].sort(),
          xpath: el ? w.__aeciXPath(el) : (r.path?.dom ?? ''),
        });
      }
      // Evidence the scan ran: the distinct rules that returned any result, passes
      // included. Zero means the engine judged nothing, and the test fails.
      const rulesRun = new Set(report.results.map((r) => r.ruleId)).size;
      return { rulesRun, scanMs, results: out };
    },
    { ruleset: IBM_RULESET, excluded: EXCLUDED_DOM.map((d) => d.selector) },
  );
  const findings: IbmFinding[] = [];
  for (const r of raw.results) {
    const level = levelOf(r.value);
    if (level === null || level === 'pass') continue;
    findings.push({
      ruleId: r.ruleId,
      reasonId: r.reasonId,
      level,
      message: r.message,
      wcag: r.wcag,
      xpath: r.xpath,
    });
  }
  const key = (f: IbmFinding) => `${f.ruleId}\u0000${f.xpath}\u0000${f.reasonId}`;
  findings.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { rulesRun: raw.rulesRun, scanMs: raw.scanMs, findings };
}

/**
 * axe on the same state, with the e2e sweep's tags and exclusions
 * (`e2e/axe-sweep.ts`), so the comparison is with what the nightly's axe sees.
 * Failures and incompletes both, each node keyed by the injected XPath helper.
 */
export async function runAxe(page: Page): Promise<AxeNode[]> {
  let builder = new AxeBuilder({ page }).withTags([...GATE_TAGS, ...REPORT_TAGS]);
  for (const { selector } of EXCLUDED_DOM) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const raw = [
    ...results.violations.map((v) => ({ v, kind: 'violation' as const })),
    ...results.incomplete.map((v) => ({ v, kind: 'review' as const })),
  ].flatMap(({ v, kind }) =>
    v.nodes.map((n) => ({
      ruleId: v.id,
      kind,
      wcag: wcagFromAxeTags(v.tags),
      // axe's target has one entry per frame or shadow root. The surfaces have
      // neither, so the last entry is the element's selector.
      selector: String(n.target.at(-1) ?? ''),
    })),
  );
  const xpaths = await page.evaluate(
    (selectors) => {
      const w = window as unknown as XPathWindow;
      return selectors.map((sel) => {
        try {
          const el = document.querySelector(sel);
          return el ? w.__aeciXPath(el) : '';
        } catch {
          return '';
        }
      });
    },
    raw.map((r) => r.selector),
  );
  return raw
    .map((r, i) => ({ ruleId: r.ruleId, kind: r.kind, wcag: r.wcag, xpath: xpaths[i] ?? '' }))
    .filter((n) => n.xpath !== '');
}
