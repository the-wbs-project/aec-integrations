/**
 * `docs/BOT_TRAFFIC_CLASSIFICATION.md` is hand-written and is the record of truth for how
 * traffic is classified (AECI-1577). This pins its version, vocabularies, list counts and
 * thresholds to the code, so a value changed on one side only fails CI. Each table is compared
 * in both directions. What this cannot pin, such as the `client_verdict` conditions in §2.3,
 * is covered by `classification-doc-check.yml` and review.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAGE_VIEW_DEDUPE_WINDOW_MS,
  PAGE_VIEWS_RETENTION_DAYS,
  UNTRACKED_ROUTE_PREFIXES,
} from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  CLASSIFICATION_UNRESOLVED_SHARE_MAX,
  TOP_UNRESOLVED_CLIENTS_LIMIT,
  UNRESOLVED_CLIENT_ALERT_SHARE,
} from './admin-classification';
import { ARRIVAL_CF_COVERAGE_MIN } from './arrival-coverage';
import { networkClassEntries } from './asn-registry';
import { datacenterAsnEntries, genericBotRule, namedBotEntries } from './bot-classification';
import { OPERATOR_PAIR_LOOKBACK_DAYS } from './page-view-predicates';
import {
  ASN_ROTATOR_MIN_UA_RATIO,
  ASN_ROTATOR_MIN_VIEWS,
  NON_BROWSER_VERDICTS,
  SWARM_MAX_CANDIDATES,
  SWARM_MIN_ASN_RATIO,
  SWARM_MIN_VIEWS,
  SWARM_PRIOR_LOOKBACK_DAYS,
  SWARM_PRIOR_MIN_FLAGGED_DAYS,
  SWARM_RECURRING_ASN_RATIO,
  SWARM_RECURRING_MIN_VIEWS,
} from './swarm-detection';
import { BACKFILL_MAX_AGE_DAYS } from './traffic-classification-writer';
import {
  BURST_MIN_VIEWS,
  BURST_WINDOW_SECONDS,
  CLASS_PRECEDENCE,
  CRAWL_SHAPE_LOOKBACK_DAYS,
  CRAWL_SHAPE_MIN_DISTINCT_PATH_RATIO,
  CRAWL_SHAPE_MIN_VIEWS,
  REASON_CODES,
  SIGNAL_FAMILIES,
  SPA_FOLLOWUP_WINDOW_MINUTES,
  SUSPECTED_MIN_SIGNAL_FAMILIES,
  TRAFFIC_CLASSES,
  TRAFFIC_CLASSIFIER_VERSION,
} from './traffic-classifier';
import { SHARED_PROXY_MIN_UA_HASHES } from './traffic-shadow';
import {
  HASH_MIN_ASNS,
  HASH_PATH_RATIOS,
  HASH_VIEW_FLOORS,
  RELAXED_SWARM_RATIOS,
} from './traffic-shadow-candidates';

const DOC = readFileSync(
  join(process.cwd(), '..', '..', 'docs', 'BOT_TRAFFIC_CLASSIFICATION.md'),
  'utf8',
);

/** One `### ` section of the doc, heading included. */
function section(heading: string): string {
  const start = DOC.indexOf(`\n### ${heading}`);
  expect(start, `heading "${heading}"`).toBeGreaterThan(-1);
  const end = DOC.indexOf('\n### ', start + 1);
  return DOC.slice(start, end === -1 ? undefined : end);
}

/** The cells of each row of the first table after `from`. */
function tableRows(text: string, from = ''): string[][] {
  const start = text.indexOf(from);
  expect(start, `table after "${from}"`).toBeGreaterThan(-1);
  const lines = text.slice(start).split('\n');
  const first = lines.findIndex((l) => l.startsWith('|'));
  const rows: string[][] = [];
  for (const line of lines.slice(first)) {
    if (!line.startsWith('|')) break;
    rows.push(
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  }
  return rows.slice(2);
}

/** Every backticked token in a cell. */
function codes(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

const percent = (share: number) => Math.round(share * 100);

/** Spelled the way the doc spells a small count in a sentence. */
const SMALL_NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
];

/** Every row of the §2.15 table. A new row needs an entry here, and the reverse. */
const TUNABLES: Record<string, number> = {
  SWARM_MIN_VIEWS,
  SWARM_MIN_ASN_RATIO,
  ASN_ROTATOR_MIN_VIEWS,
  ASN_ROTATOR_MIN_UA_RATIO,
  SWARM_MAX_CANDIDATES,
  SWARM_PRIOR_LOOKBACK_DAYS,
  SWARM_PRIOR_MIN_FLAGGED_DAYS,
  SWARM_RECURRING_ASN_RATIO,
  SWARM_RECURRING_MIN_VIEWS,
  CLASSIFICATION_UNRESOLVED_SHARE_MAX,
  UNRESOLVED_CLIENT_ALERT_SHARE,
  TOP_UNRESOLVED_CLIENTS_LIMIT,
  OPERATOR_PAIR_LOOKBACK_DAYS,
  SUSPECTED_MIN_SIGNAL_FAMILIES,
  SPA_FOLLOWUP_WINDOW_MINUTES,
  CRAWL_SHAPE_LOOKBACK_DAYS,
  CRAWL_SHAPE_MIN_VIEWS,
  CRAWL_SHAPE_MIN_DISTINCT_PATH_RATIO,
  BURST_MIN_VIEWS,
  BURST_WINDOW_SECONDS,
  SHARED_PROXY_MIN_UA_HASHES,
};

describe('docs/BOT_TRAFFIC_CLASSIFICATION.md matches the code', () => {
  it('names the current classifier version', () => {
    expect(DOC.match(/It describes classifier `([^`]+)`/)?.[1]).toBe(TRAFFIC_CLASSIFIER_VERSION);
  });

  it('lists the four classes in precedence order (§2.7)', () => {
    const classes = tableRows(section('2.7 '), '| Order | Class |').map((r) => codes(r[1]!)[0]);
    expect(classes).toEqual([...TRAFFIC_CLASSES]);
    expect(classes).toEqual(CLASS_PRECEDENCE.map(([name]) => name));
  });

  it('lists every signal family and its codes (§2.7, and the count in Part 1)', () => {
    const rows = tableRows(section('2.7 '), '| Family | Codes |');
    const fromDoc = Object.fromEntries(rows.map((r) => [codes(r[0]!)[0], codes(r[1]!)]));
    expect(fromDoc).toEqual(SIGNAL_FAMILIES);
    const count = Object.keys(SIGNAL_FAMILIES).length;
    expect(DOC).toContain(`There are ${SMALL_NUMBER_WORDS[count]} kinds:`);
  });

  it('lists exactly the reason codes, and counts them (§2.7)', () => {
    const rows = tableRows(section('2.7 '), '**Reason codes.**');
    const fromDoc = rows.flatMap((r) => codes(r[1]!));
    expect([...fromDoc].sort()).toEqual([...REASON_CODES].sort());
    expect(section('2.7 ')).toContain(`There are ${REASON_CODES.length}, listed in`);
  });

  it('states the crawler and network list sizes (§2.2 and Part 1)', () => {
    const named = namedBotEntries().length;
    const asns = datacenterAsnEntries().length;
    expect(section('2.2 ')).toContain(`\`NAMED_BOTS\`: ${named} regexes`);
    expect(section('2.2 ')).toContain(`\`DATACENTER_ASNS\`: ${asns} entries`);
    expect(DOC).toContain(`We keep a list of ${named} named crawlers.`);
    expect(DOC).toContain(`on our list of ${asns} networks`);
  });

  it('lists every generic bot token (§2.2)', () => {
    const row = tableRows(section('2.2 '), '| Order | Test |').find((r) =>
      r[1]!.startsWith('`GENERIC_BOT_RE`'),
    );
    const fromDoc = codes(row![1]!).slice(1);
    const fromCode = genericBotRule()[0].replaceAll('\\/', '/').split('|');
    expect(fromDoc).toEqual(fromCode);
  });

  it('maps every PeeringDB info_type to its network class (§2.4)', () => {
    const rows = tableRows(section('2.4 '), '| Class |');
    const fromDoc = rows.flatMap((r) => codes(r[1]!).map((info) => [info, codes(r[0]!)[0]]));
    const byName = ([a]: readonly unknown[], [b]: readonly unknown[]) =>
      String(a) < String(b) ? -1 : 1;
    expect([...fromDoc].sort(byName)).toEqual(
      networkClassEntries()
        .map(([info, cls]) => [info, cls])
        .sort(byName),
    );
  });

  it('names the non-browser verdicts (§2.5)', () => {
    const line = section('2.5 ').match(/`NON_BROWSER_VERDICTS` is ([^.]+)\./)?.[1];
    expect(codes(line ?? '')).toEqual([...NON_BROWSER_VERDICTS]);
  });

  it('names the internal paths (§2.6)', () => {
    const path = tableRows(section('2.6 '), '| Half |').find((r) => r[0] === 'Path');
    expect(codes(path![1]!)).toEqual([...UNTRACKED_ROUTE_PREFIXES]);
  });

  it('carries every tunable constant at its value (§2.15)', () => {
    const rows = tableRows(section('2.15 '), '| Constant |').filter((r) =>
      /^`[A-Z_]+`$/.test(r[0]!),
    );
    const fromDoc = Object.fromEntries(rows.map((r) => [codes(r[0]!)[0], Number(codes(r[1]!)[0])]));
    expect(fromDoc).toEqual(TUNABLES);
  });

  it.each([
    // §2.15, the shadow-only candidate grid (AECI-1584).
    `\`HASH_VIEW_FLOORS\` (${HASH_VIEW_FLOORS.join(', ')})`,
    `\`HASH_PATH_RATIOS\` (${HASH_PATH_RATIOS.join(', ')})`,
    `\`HASH_MIN_ASNS\` (${HASH_MIN_ASNS.join(', ')})`,
    `\`RELAXED_SWARM_RATIOS\` (${RELAXED_SWARM_RATIOS.join(', ')})`,
    // §2.5, the rules beside the §2.15 values.
    `views ≥ ${SWARM_MIN_VIEWS}, and distinct ASNs ÷ views ≥ ${SWARM_MIN_ASN_RATIO}`,
    `Full-strength flag on ≥ ${SWARM_PRIOR_MIN_FLAGGED_DAYS} of the prior ${SWARM_PRIOR_LOOKBACK_DAYS} days: views ≥ ${SWARM_RECURRING_MIN_VIEWS}, and ratio ≥ ${SWARM_RECURRING_ASN_RATIO}`,
    `views ≥ ${ASN_ROTATOR_MIN_VIEWS}, distinct UA hashes ÷ views ≥ ${ASN_ROTATOR_MIN_UA_RATIO}`,
    `views ≥ ${CRAWL_SHAPE_MIN_VIEWS} and true distinct \`concrete_path\` ÷ views ≥ ${CRAWL_SHAPE_MIN_DISTINCT_PATH_RATIO}`,
    `views ≥ ${BURST_MIN_VIEWS} within ${BURST_WINDOW_SECONDS} seconds`,
    // §2.6, §2.7.
    `within ±${OPERATOR_PAIR_LOOKBACK_DAYS} days`,
    `Signals from ≥ ${SUSPECTED_MIN_SIGNAL_FAMILIES} families (\`SUSPECTED_MIN_SIGNAL_FAMILIES\`)`,
    `within ${SPA_FOLLOWUP_WINDOW_MINUTES} minutes (\`SPA_FOLLOWUP_WINDOW_MINUTES\`)`,
    `with a ${PAGE_VIEW_DEDUPE_WINDOW_MS / 1000}-second bucket`,
    // §2.8, §2.9.
    `The backfill cap is ${BACKFILL_MAX_AGE_DAYS} days (\`BACKFILL_MAX_AGE_DAYS\`)`,
    `the ${PAGE_VIEWS_RETENTION_DAYS}-day \`page_views\` retention`,
    `strictly above ${percent(CLASSIFICATION_UNRESOLVED_SHARE_MAX)}% of classified`,
    `strictly above ${percent(UNRESOLVED_CLIENT_ALERT_SHARE)}% of classified`,
    `Under ${percent(ARRIVAL_CF_COVERAGE_MIN)}% of arrivals carry \`cf_asn\` (\`ARRIVAL_CF_COVERAGE_MIN\`)`,
    // Part 1, which restates them in plain language.
    `load at least ${CRAWL_SHAPE_MIN_VIEWS} pages, at least ${percent(CRAWL_SHAPE_MIN_DISTINCT_PATH_RATIO)}% of them different, on this day alone or over this day and the ${CRAWL_SHAPE_LOOKBACK_DAYS} before it`,
    `load the same page at least ${BURST_MIN_VIEWS} times within any ${BURST_WINDOW_SECONDS} seconds`,
    `We also accept a click within ${SPA_FOLLOWUP_WINDOW_MINUTES} minutes of arriving.`,
    `within ${OPERATOR_PAIR_LOOKBACK_DAYS} days of a login`,
    `about ${PAGE_VIEW_DEDUPE_WINDOW_MS / 1000} to ${(2 * PAGE_VIEW_DEDUPE_WINDOW_MS) / 1000} seconds`,
    `passes ${percent(CLASSIFICATION_UNRESOLVED_SHARE_MAX)}% of a day's non-internal views`,
    `The daily email lists the ${SMALL_NUMBER_WORDS[TOP_UNRESOLVED_CLIENTS_LIMIT]} largest and warns when one passes ${percent(UNRESOLVED_CLIENT_ALERT_SHARE)}%`,
    `If more than ${100 - percent(ARRIVAL_CF_COVERAGE_MIN)}% of arrivals lost their network details`,
  ])('states "%s"', (phrase) => {
    expect(DOC).toContain(phrase);
  });
});
