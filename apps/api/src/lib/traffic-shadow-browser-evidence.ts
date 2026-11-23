/**
 * The browser report in the shadow report (AECI-1716, epic AECI-1711,
 * `POST_LAUNCH_MONITORING.md` §3c, `BOT_TRAFFIC_CLASSIFICATION.md` §2.11).
 *
 * Two candidate signals read `page_views.browser_evidence` beside the running
 * classifier, the way the AECI-1584 and AECI-1659 candidates do:
 *
 *   1. `interacted` as a human override ({@link interactedClass}). It outweighs the
 *      hash-level families other than burst and, since the 2026-11-22 ruling, the
 *      network family. It never outweighs an identified row or a stored `is_bot`. It
 *      leaves the request-shape family and, by the 2026-11-23 ruling, burst standing.
 *      `ran` is tabulated and is never human evidence.
 *   2. `no_browser_report` as one automation family ({@link browserEvidenceState},
 *      {@link noBrowserReportClass}). It still needs a second family to reach
 *      Suspected. A privacy-signal row or a held-region row is `not_collected`, never
 *      this family.
 *
 * Report-only. `traffic-classifier.ts` does not import this file, so the classifier
 * version and fingerprint stay put, and nothing writes `is_bot` or a classification
 * row. Every constant here is shadow-only until a ruling and a cut-over make it a rule
 * input (`BOT_TRAFFIC_CLASSIFICATION.md` §2.15).
 */

import { BROWSER_EVIDENCE_VALUES, isHeldRegionCountry, PAGE_VIEW_WRITERS } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import type { AsnNetworkClass } from './asn-registry';
import { candidateClass, familiesOfCodes, type CandidateFamily } from './traffic-shadow-candidates';
import { mainNetworkKind, type MainNetworkKind } from './traffic-shadow-coordinated';
import {
  SUSPECTED_MIN_SIGNAL_FAMILIES,
  type ClassifierRow,
  type PageViewClassification,
  type TrafficClass,
} from './traffic-classifier';

// ─── Shadow-only constants ──────────────────────────────────────────────────

/**
 * How old an `ssr-arrival` row must be, at the time it was read, before a NULL report
 * counts as "no report arrived". The endpoint accepts a report only for a row created
 * in the last 10 minutes (`BROWSER_EVIDENCE_WINDOW_MS`), so a younger row may still be
 * upgraded. Shadow-only.
 */
export const BROWSER_REPORT_SETTLE_MINUTES = 10;

/**
 * The UTC day AECI-1987 and AECI-1988 merged and deployed (2026-11-20). Before it, a
 * click that opened an in-app view, or a link opened in a new tab, left the view at
 * `ran` until a second touch. So the `interacted` share has a seam here, and rows on
 * this day follow either rule. Shadow-only: it labels report rows and decides nothing.
 */
export const INTERACTED_RULE_SEAM_DAY = '2026-11-20';

/**
 * The families `interacted` outweighs with the network drop taken away: the hash-level
 * families read from a user-agent hash or a network's spread of hashes, less `burst`.
 * `burst` is hash-level too, and by the 2026-11-23 ruling it stands. The report keeps this
 * set so the reach of the 2026-11-22 `network` drop stays visible on its own. Shadow-only.
 */
export const INTERACTED_OVERRIDES_WITHOUT_NETWORK = [
  'swarm',
  'rotator',
  'crawl_shape',
  'coordinated_identities',
] as const satisfies readonly CandidateFamily[];

/**
 * The families an `interacted` row outweighs: {@link INTERACTED_OVERRIDES_WITHOUT_NETWORK}
 * and, by the 2026-11-22 ruling, `network` (`asn_datacenter`, `asn_non_eyeball`).
 *
 * Two families stand. `request_shape` is a fact about this one request. `burst` stands by
 * the 2026-11-23 ruling: a reader does not load one page 20 times in 60 seconds, and
 * duplicate-view merging leaves a burst only to a known bot or a blank browser description,
 * so an `interacted` report on one is more likely forged. It stays in the forgery check.
 * The override still never reads a stored `is_bot`, and the ASN rule writes `is_bot` on
 * every `DATACENTER_ASNS` row at ingest. Shadow-only.
 */
export const INTERACTED_OVERRIDES_FAMILIES = [
  ...INTERACTED_OVERRIDES_WITHOUT_NETWORK,
  'network',
] as const satisfies readonly CandidateFamily[];

const OVERRIDABLE: ReadonlySet<CandidateFamily> = new Set(INTERACTED_OVERRIDES_FAMILIES);
const OVERRIDABLE_WITHOUT_NETWORK: ReadonlySet<CandidateFamily> = new Set(
  INTERACTED_OVERRIDES_WITHOUT_NETWORK,
);

/** How many rows a listing section shows. The JSON report has every row. */
const LISTED_ROWS = 50;
/** How many client-days the busiest-interacted list shows. */
const BUSIEST_INTERACTED_SHOWN = 20;

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** An inclusive `page_views.id` range the browser-evidence sections leave out. */
export interface IdRange {
  from: number;
  to: number;
}

/**
 * Parse `--exclude-ids`: comma-separated ids or inclusive ranges, such as
 * `492-537,412937-412951`. Throws on anything else rather than guessing.
 */
export function parseIdRanges(spec: string): IdRange[] {
  return spec
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const m = part.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) throw new Error(`--exclude-ids: not an id or a range: ${part}`);
      const from = Number(m[1]);
      const to = m[2] === undefined ? from : Number(m[2]);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
        throw new Error(`--exclude-ids: bad range: ${part}`);
      }
      return { from, to };
    });
}

function inRanges(id: number, ranges: readonly IdRange[]): boolean {
  return ranges.some((r) => id >= r.from && id <= r.to);
}

/** Where the capture start came from. */
export type CaptureFromSource = 'input' | 'derived' | 'none';

export interface BrowserEvidenceInputs {
  /** When the rows were read, UTC ISO. A row younger than the settle time may still change. */
  readAt: string;
  /**
   * The first instant the tier captured browser reports, UTC ISO, or null when no
   * capture is known. Every NULL before it is "capture off", never "no report".
   */
  captureFrom: string | null;
  captureFromSource: CaptureFromSource;
  /** Rows the browser-evidence sections leave out, such as a live check's test rows. */
  excludeIds: IdRange[];
}

// ─── The detectors ──────────────────────────────────────────────────────────

/** The fields the detectors read from one row. */
export type BrowserEvidenceRow = Pick<
  ClassifierRow,
  'id' | 'createdAt' | 'writerProvenance' | 'clientVerdict' | 'isBot' | 'privacySignal'
> & {
  cfCountry: string | null;
  browserEvidence: string | null;
};

/**
 * What one row says about the browser report, in the order the tests run.
 *
 * - `not_collected_privacy`, `not_collected_held_region`: the report is never
 *   collected for this row (AECI-1711). Its NULL is never evidence.
 * - `interacted`, `ran`: the report arrived.
 * - `not_arrival`: NULL on a row the gateway did not write. A `browser-spa` row is
 *   written with `ran` whenever capture is on, so its NULL is capture off.
 * - `capture_off`: written before the tier captured reports.
 * - `in_flight`: younger than {@link BROWSER_REPORT_SETTLE_MINUTES} when read.
 * - `known_bot`: a stored `is_bot`. Not the signal's target.
 * - `verdict_not_browser`: the request did not look like a browser, so its family
 *   already speaks for it.
 * - `no_browser_report`: the candidate family.
 */
export const BROWSER_EVIDENCE_STATES = [
  'not_collected_privacy',
  'not_collected_held_region',
  'interacted',
  'ran',
  'not_arrival',
  'capture_off',
  'in_flight',
  'known_bot',
  'verdict_not_browser',
  'no_browser_report',
] as const;
export type BrowserEvidenceState = (typeof BROWSER_EVIDENCE_STATES)[number];

const REPORTED: ReadonlySet<string> = new Set(BROWSER_EVIDENCE_VALUES);

/** States of a row that could report: collected, captured and settled. */
const COULD_REPORT: ReadonlySet<BrowserEvidenceState> = new Set([
  'interacted',
  'ran',
  'known_bot',
  'verdict_not_browser',
  'no_browser_report',
]);

/** A privacy-signal row or a held-region row: the report is never collected. */
export function notCollectedReason(
  row: Pick<BrowserEvidenceRow, 'privacySignal' | 'cfCountry'>,
): 'privacy' | 'held_region' | null {
  if (row.privacySignal === true) return 'privacy';
  return isHeldRegionCountry(row.cfCountry) ? 'held_region' : null;
}

/**
 * The browser-report state of one row (AECI-1716 candidate 2).
 *
 * The `no_browser_report` conditions, all required: the row is an `ssr-arrival`; it is
 * not a privacy-signal row and not held (`isHeldRegionCountry`, which holds a NULL
 * country); it was written at or after `captureFromMs`; it is at least
 * {@link BROWSER_REPORT_SETTLE_MINUTES} old at `readAtMs`; `is_bot` is not true;
 * `client_verdict = 'browser'`; and `browser_evidence` is NULL. "Response 200 HTML" is
 * not a column: the gateway writes an `ssr-arrival` only for a GET that returned 200
 * with a `text/html` body (`recordGatewayArrival` in `apps/web/src/server-runtime.ts`),
 * so the writer test carries it. An errored page writes no arrival row at all.
 */
export function browserEvidenceState(
  row: BrowserEvidenceRow,
  opts: { readAtMs: number; captureFromMs: number | null },
): BrowserEvidenceState {
  const notCollected = notCollectedReason(row);
  if (notCollected === 'privacy') return 'not_collected_privacy';
  if (notCollected === 'held_region') return 'not_collected_held_region';
  if (row.browserEvidence === 'interacted') return 'interacted';
  if (row.browserEvidence === 'ran') return 'ran';
  if (row.writerProvenance !== PAGE_VIEW_WRITERS.ssrArrival) return 'not_arrival';
  const at = Date.parse(row.createdAt);
  if (opts.captureFromMs === null || at < opts.captureFromMs) return 'capture_off';
  if (at > opts.readAtMs - BROWSER_REPORT_SETTLE_MINUTES * 60_000) return 'in_flight';
  if (row.isBot === true) return 'known_bot';
  if (row.clientVerdict !== 'browser') return 'verdict_not_browser';
  return 'no_browser_report';
}

/** A not-collected row that carries a report anyway. Neither writer allows it; counted, never read. */
export function isUnexpectedReport(row: BrowserEvidenceRow): boolean {
  return notCollectedReason(row) !== null && row.browserEvidence !== null;
}

/** A value outside `BROWSER_EVIDENCE_VALUES`. The handler writes only the two words. */
export function isUnknownReportValue(row: Pick<BrowserEvidenceRow, 'browserEvidence'>): boolean {
  return row.browserEvidence !== null && !REPORTED.has(row.browserEvidence);
}

/**
 * The class a row reads with `interacted` as a human override (AECI-1716 candidate 1).
 *
 * - Not `interacted`: the running class. `ran` is never human evidence.
 * - Identified automation, a stored `is_bot`, or a not-collected row: the running
 *   class. The override never outweighs a known bot.
 * - Otherwise the families in {@link INTERACTED_OVERRIDES_FAMILIES} are dropped. With no
 *   family left the row reads `browser_with_human_evidence`. One family left
 *   contradicts the evidence, so the row is `unresolved`. Two reach Suspected, as in
 *   the classifier.
 */
export function interactedClass(
  row: Pick<BrowserEvidenceRow, 'browserEvidence' | 'isBot' | 'privacySignal' | 'cfCountry'>,
  result: Pick<PageViewClassification, 'class' | 'reasonCodes'>,
): TrafficClass {
  return overrideClass(row, result, OVERRIDABLE);
}

/**
 * The class {@link interactedClass} gives with `network` left standing: the current rule
 * less the 2026-11-22 drop. `burst` stands in both, so the two differ only by the network
 * family. Report-only, so the network drop's reach stays visible.
 */
export function interactedClassWithoutNetworkDrop(
  row: Pick<BrowserEvidenceRow, 'browserEvidence' | 'isBot' | 'privacySignal' | 'cfCountry'>,
  result: Pick<PageViewClassification, 'class' | 'reasonCodes'>,
): TrafficClass {
  return overrideClass(row, result, OVERRIDABLE_WITHOUT_NETWORK);
}

/** Whether the override declines a row because it is a known bot or identified. */
export function interactedHeldAsKnownBot(
  row: Pick<BrowserEvidenceRow, 'browserEvidence' | 'isBot'>,
  result: Pick<PageViewClassification, 'class'>,
): boolean {
  return (
    row.browserEvidence === 'interacted' &&
    (result.class === 'identified_automation' || row.isBot === true)
  );
}

function overrideClass(
  row: Pick<BrowserEvidenceRow, 'browserEvidence' | 'isBot' | 'privacySignal' | 'cfCountry'>,
  result: Pick<PageViewClassification, 'class' | 'reasonCodes'>,
  dropped: ReadonlySet<CandidateFamily>,
): TrafficClass {
  if (row.browserEvidence !== 'interacted') return result.class;
  if (interactedHeldAsKnownBot(row, result)) return result.class;
  if (notCollectedReason(row) !== null) return result.class;
  const left = familiesOfCodes(result.reasonCodes).filter((f) => !dropped.has(f));
  if (left.length >= SUSPECTED_MIN_SIGNAL_FAMILIES) return 'suspected_automation';
  return left.length === 1 ? 'unresolved' : 'browser_with_human_evidence';
}

/** The class a row reads with `no_browser_report` as one more family, when it carries it. */
export function noBrowserReportClass(
  state: BrowserEvidenceState,
  result: Pick<PageViewClassification, 'class' | 'reasonCodes'>,
): TrafficClass {
  if (state !== 'no_browser_report') return result.class;
  return candidateClass(result.class, familiesOfCodes(result.reasonCodes), ['no_browser_report']);
}

// ─── Collector ──────────────────────────────────────────────────────────────

/** Which side of {@link INTERACTED_RULE_SEAM_DAY} a day is on. */
export type InteractedRule = 'before' | 'seam_day' | 'after';

export function interactedRuleFor(day: string): InteractedRule {
  if (day < INTERACTED_RULE_SEAM_DAY) return 'before';
  return day === INTERACTED_RULE_SEAM_DAY ? 'seam_day' : 'after';
}

type StateCounts = Record<BrowserEvidenceState, number>;

function zeroStates(): StateCounts {
  return Object.fromEntries(BROWSER_EVIDENCE_STATES.map((s) => [s, 0])) as StateCounts;
}

/** Per day and writer, every row by state. */
export interface BrowserEvidenceDay {
  day: string;
  heldOut: boolean;
  rule: InteractedRule;
  arrivals: StateCounts;
  inApp: StateCounts;
  /** Rows the browser-evidence sections left out by `--exclude-ids`. */
  excluded: number;
  /** Not-collected rows that carry a report anyway. Should be 0. */
  unexpectedReports: number;
  /** Values outside `ran` / `interacted`. Should be 0. */
  unknownValues: number;
  /**
   * The blocker loss. Turnstile-pass arrivals that could report (collected, captured,
   * settled): a pass proves our page script ran in that load.
   */
  turnstilePass: number;
  /** Of those, the ones with no report. */
  turnstilePassNoReport: number;
  /**
   * `no_browser_report` rows whose pair also made a browser-verified in-app hop within
   * the follow-up window (`spa_followup`). The app ran for that client, so the missing
   * report was lost, not withheld. A floor on false `no_browser_report`.
   */
  noReportWithHop: number;
}

/** A class change one signal makes, counted by network. */
export interface NetworkMove {
  signal: 'interacted' | 'no_browser_report';
  cfAsn: number | null;
  kind: MainNetworkKind | 'no_asn';
  from: TrafficClass;
  to: TrafficClass;
  rows: number;
  /**
   * Of those, the rows that land here only because `interacted` also drops the network
   * family (2026-11-22). Without that drop they would read another class. Always 0 for
   * `no_browser_report`.
   */
  byNetworkDrop: number;
}

/** Per day: what `no_browser_report` does to AECI-1659 coordinated-identity member rows. */
export interface CoordinatedPairingDay {
  day: string;
  heldOut: boolean;
  memberRows: number;
  /** Member rows carrying `no_browser_report`. */
  withNoReport: number;
  /** Of those, the rows the two families together move into Suspected. */
  toSuspected: number;
  /** Of those, the rows with no classifier family: the non-hash partner is the only one. */
  onlyPartner: number;
  /** Member rows carrying `interacted`, which the override would rescue. */
  interacted: number;
}

/** An `interacted` row that also carries an automation family: the forgery check. */
export interface InteractedWithAutomation {
  cfAsn: number | null;
  kind: MainNetworkKind | 'no_asn';
  /** Families joined with ` + `, sorted. `coordinated_identities` included. */
  families: string;
  rows: number;
  /** Rows the override would move to human evidence. */
  rescued: number;
  /** Of those, the rows rescued only because the network family is dropped (2026-11-22). */
  rescuedByNetworkDrop: number;
  /** Rows the override declines: a stored `is_bot`, the ASN rule's included, or an identified row. */
  heldKnownBot: number;
}

/** One client-day's `interacted` rows. The busiest are where a forger at volume shows. */
export interface InteractedClientDay {
  day: string;
  userAgentHash: string | null;
  cfAsn: number | null;
  interacted: number;
  /** Interacted rows that also carry an automation family. */
  withFamily: number;
}

/** `interacted` share among one group's rows that could report. */
export interface InteractedShare {
  group: string;
  rule: InteractedRule;
  writer: 'arrival' | 'in_app';
  /** Collected, captured and settled rows. */
  rows: number;
  interacted: number;
  ran: number;
  /** No report: `no_browser_report`, `known_bot` or `verdict_not_browser`. */
  none: number;
  notCollected: number;
}

export interface BrowserEvidenceReport {
  inputs: BrowserEvidenceInputs;
  constants: {
    BROWSER_REPORT_SETTLE_MINUTES: number;
    INTERACTED_RULE_SEAM_DAY: string;
    INTERACTED_OVERRIDES_FAMILIES: readonly string[];
  };
  days: BrowserEvidenceDay[];
  moves: NetworkMove[];
  coordinated: CoordinatedPairingDay[];
  interactedWithAutomation: InteractedWithAutomation[];
  busiestInteracted: InteractedClientDay[];
  operatorShare: InteractedShare[];
  /** Null when the labels file names no session: nothing was supplied. */
  labelledShare: InteractedShare[] | null;
}

/** One row handed to the collector. */
export interface BrowserEvidenceRowInput {
  row: ClassifierRow & Pick<BrowserEvidenceRow, 'cfCountry' | 'browserEvidence'>;
  turnstileVerdict: string | null;
  result: PageViewClassification;
  /** The labelled session the row matched, by name, or null. */
  session: string | null;
  coordinatedMember: boolean;
  /** The row is an arrival whose pair made a browser-verified in-app hop (`spaFollowupRowIds`). */
  spaFollowup: boolean;
}

function networkOf(
  cfAsn: number | null,
  networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>,
): MainNetworkKind | 'no_asn' {
  return cfAsn === null ? 'no_asn' : mainNetworkKind(cfAsn, networkClassByAsn);
}

function emptyShare(
  group: string,
  rule: InteractedRule,
  writer: InteractedShare['writer'],
): InteractedShare {
  return { group, rule, writer, rows: 0, interacted: 0, ran: 0, none: 0, notCollected: 0 };
}

export class BrowserEvidenceCollector {
  private readonly readAtMs: number;
  private readonly captureFromMs: number | null;
  private readonly days: BrowserEvidenceDay[] = [];
  private readonly moves = new Map<string, NetworkMove>();
  private readonly coordinated: CoordinatedPairingDay[] = [];
  private readonly withAutomation = new Map<string, InteractedWithAutomation>();
  private readonly clientDays = new Map<string, InteractedClientDay>();
  private readonly operator = new Map<string, InteractedShare>();
  private readonly labelled = new Map<string, InteractedShare>();
  private current: {
    day: BrowserEvidenceDay;
    pairing: CoordinatedPairingDay;
    networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>;
  } | null = null;

  constructor(
    private readonly inputs: BrowserEvidenceInputs,
    private readonly sessionsSupplied: boolean,
  ) {
    this.readAtMs = Date.parse(inputs.readAt);
    if (!Number.isFinite(this.readAtMs))
      throw new Error(`readAt is not an instant: ${inputs.readAt}`);
    this.captureFromMs = inputs.captureFrom === null ? null : Date.parse(inputs.captureFrom);
    if (this.captureFromMs !== null && !Number.isFinite(this.captureFromMs)) {
      throw new Error(`captureFrom is not an instant: ${inputs.captureFrom}`);
    }
  }

  /** Start a day. Call before its rows. */
  addDay(
    day: string,
    heldOut: boolean,
    networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>,
  ): void {
    const record: BrowserEvidenceDay = {
      day,
      heldOut,
      rule: interactedRuleFor(day),
      arrivals: zeroStates(),
      inApp: zeroStates(),
      excluded: 0,
      unexpectedReports: 0,
      unknownValues: 0,
      turnstilePass: 0,
      turnstilePassNoReport: 0,
      noReportWithHop: 0,
    };
    const pairing: CoordinatedPairingDay = {
      day,
      heldOut,
      memberRows: 0,
      withNoReport: 0,
      toSuspected: 0,
      onlyPartner: 0,
      interacted: 0,
    };
    this.days.push(record);
    this.coordinated.push(pairing);
    this.current = { day: record, pairing, networkClassByAsn };
  }

  /**
   * Overlay one row of the current day. Returns the class it reads under each signal.
   * A row left out by `--exclude-ids` reads its running class under both and is counted
   * only as excluded.
   */
  addRow(input: BrowserEvidenceRowInput): {
    excluded: boolean;
    interacted: TrafficClass;
    noBrowserReport: TrafficClass;
  } {
    const cur = this.current;
    if (cur === null) throw new Error('BrowserEvidenceCollector.addRow before addDay');
    const { row, result } = input;
    const { day } = cur;
    if (inRanges(row.id, this.inputs.excludeIds)) {
      day.excluded += 1;
      return { excluded: true, interacted: result.class, noBrowserReport: result.class };
    }
    const state = browserEvidenceState(row, {
      readAtMs: this.readAtMs,
      captureFromMs: this.captureFromMs,
    });
    const arrival = row.writerProvenance === PAGE_VIEW_WRITERS.ssrArrival;
    (arrival ? day.arrivals : day.inApp)[state] += 1;
    if (isUnexpectedReport(row)) day.unexpectedReports += 1;
    if (isUnknownReportValue(row)) day.unknownValues += 1;

    const families = familiesOfCodes(result.reasonCodes);
    const interacted = interactedClass(row, result);
    const networkDropMattered = interacted !== interactedClassWithoutNetworkDrop(row, result);
    const noBrowserReport = noBrowserReportClass(state, result);
    const kind = networkOf(row.cfAsn, cur.networkClassByAsn);

    // The blocker loss: a Turnstile pass proves the script ran in this load.
    if (arrival && COULD_REPORT.has(state) && input.turnstileVerdict === 'pass') {
      day.turnstilePass += 1;
      if (row.browserEvidence === null) day.turnstilePassNoReport += 1;
    }
    if (state === 'no_browser_report' && input.spaFollowup) {
      day.noReportWithHop += 1;
    }

    this.recordMove('interacted', row.cfAsn, kind, result.class, interacted, networkDropMattered);
    this.recordMove('no_browser_report', row.cfAsn, kind, result.class, noBrowserReport, false);

    if (input.coordinatedMember) {
      const p = cur.pairing;
      p.memberRows += 1;
      if (row.browserEvidence === 'interacted') p.interacted += 1;
      if (state === 'no_browser_report') {
        p.withNoReport += 1;
        const both = candidateClass(result.class, families, [
          'coordinated_identities',
          'no_browser_report',
        ]);
        if (both === 'suspected_automation' && result.class !== 'suspected_automation') {
          p.toSuspected += 1;
        }
        if (families.length === 0) p.onlyPartner += 1;
      }
    }

    if (row.browserEvidence === 'interacted') {
      const automation: string[] = [...families];
      if (input.coordinatedMember) automation.push('coordinated_identities');
      const key = JSON.stringify([day.day, row.userAgentHash, row.cfAsn]);
      const client = this.clientDays.get(key) ?? {
        day: day.day,
        userAgentHash: row.userAgentHash,
        cfAsn: row.cfAsn,
        interacted: 0,
        withFamily: 0,
      };
      client.interacted += 1;
      if (automation.length > 0) client.withFamily += 1;
      this.clientDays.set(key, client);
      if (automation.length > 0) {
        const label = automation.sort(compareText).join(' + ');
        const k = `${row.cfAsn}|${label}`;
        const entry = this.withAutomation.get(k) ?? {
          cfAsn: row.cfAsn,
          kind,
          families: label,
          rows: 0,
          rescued: 0,
          rescuedByNetworkDrop: 0,
          heldKnownBot: 0,
        };
        entry.rows += 1;
        if (interacted === 'browser_with_human_evidence' && result.class !== interacted) {
          entry.rescued += 1;
          if (networkDropMattered) entry.rescuedByNetworkDrop += 1;
        }
        if (interactedHeldAsKnownBot(row, result)) entry.heldKnownBot += 1;
        this.withAutomation.set(k, entry);
      }
    }

    if (row.isOperator === true) {
      this.recordShare(this.operator, 'operator rows', day.rule, arrival, state);
    }
    if (input.session !== null) {
      this.recordShare(this.labelled, input.session, day.rule, arrival, state);
    }
    return { excluded: false, interacted, noBrowserReport };
  }

  private recordMove(
    signal: NetworkMove['signal'],
    cfAsn: number | null,
    kind: NetworkMove['kind'],
    from: TrafficClass,
    to: TrafficClass,
    byNetworkDrop: boolean,
  ): void {
    if (from === to) return;
    const key = [signal, cfAsn, from, to].join('|');
    const move = this.moves.get(key) ?? {
      signal,
      cfAsn,
      kind,
      from,
      to,
      rows: 0,
      byNetworkDrop: 0,
    };
    move.rows += 1;
    if (byNetworkDrop) move.byNetworkDrop += 1;
    this.moves.set(key, move);
  }

  private recordShare(
    into: Map<string, InteractedShare>,
    group: string,
    rule: InteractedRule,
    arrival: boolean,
    state: BrowserEvidenceState,
  ): void {
    const writer = arrival ? 'arrival' : 'in_app';
    const key = [group, rule, writer].join('|');
    const share = into.get(key) ?? emptyShare(group, rule, writer);
    into.set(key, share);
    if (state === 'not_collected_privacy' || state === 'not_collected_held_region') {
      share.notCollected += 1;
      return;
    }
    if (!COULD_REPORT.has(state)) return;
    share.rows += 1;
    if (state === 'interacted') share.interacted += 1;
    else if (state === 'ran') share.ran += 1;
    else share.none += 1;
  }

  finish(): BrowserEvidenceReport {
    const byShare = (a: InteractedShare, b: InteractedShare) =>
      compareText(a.group, b.group) ||
      compareText(a.rule, b.rule) ||
      compareText(a.writer, b.writer);
    return {
      inputs: this.inputs,
      constants: {
        BROWSER_REPORT_SETTLE_MINUTES,
        INTERACTED_RULE_SEAM_DAY,
        INTERACTED_OVERRIDES_FAMILIES,
      },
      days: this.days,
      moves: [...this.moves.values()].sort(
        (a, b) =>
          compareText(a.signal, b.signal) ||
          b.rows - a.rows ||
          (a.cfAsn ?? -1) - (b.cfAsn ?? -1) ||
          compareText(`${a.from}|${a.to}`, `${b.from}|${b.to}`),
      ),
      coordinated: this.coordinated,
      interactedWithAutomation: [...this.withAutomation.values()].sort(
        (a, b) =>
          b.rows - a.rows ||
          (a.cfAsn ?? -1) - (b.cfAsn ?? -1) ||
          compareText(a.families, b.families),
      ),
      busiestInteracted: [...this.clientDays.values()].sort(
        (a, b) => b.interacted - a.interacted || compareText(a.day, b.day),
      ),
      operatorShare: [...this.operator.values()].sort(byShare),
      labelledShare: this.sessionsSupplied ? [...this.labelled.values()].sort(byShare) : null,
    };
  }
}

// ─── Markdown ───────────────────────────────────────────────────────────────

function table(head: readonly string[], body: readonly (readonly (string | number)[])[]): string {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function pct(part: number, whole: number): string {
  return whole === 0 ? 'n/a' : `${((part / whole) * 100).toFixed(1)}%`;
}

const RULE_LABEL: Readonly<Record<InteractedRule, string>> = {
  before: 'before AECI-1987/1988',
  seam_day: 'deploy day, mixed',
  after: 'after AECI-1987/1988',
};

function sum(days: readonly BrowserEvidenceDay[], pick: (d: BrowserEvidenceDay) => number): number {
  return days.reduce((n, d) => n + pick(d), 0);
}

function shareTable(rows: readonly InteractedShare[]): string {
  return table(
    [
      'Group',
      'Interaction rule',
      'Writer',
      'Rows that could report',
      'Interacted',
      'Ran',
      'No report',
      'Not collected',
    ],
    rows.map((s) => [
      s.group,
      RULE_LABEL[s.rule],
      s.writer,
      s.rows,
      `${s.interacted} (${pct(s.interacted, s.rows)})`,
      s.ran,
      s.none,
      s.notCollected,
    ]),
  );
}

function hash8(h: string | null): string {
  return h === null ? '(null)' : `\`${h.slice(0, 8)}\``;
}

/** The browser-report sections of the shadow report. Slice metrics are rendered by the caller. */
export function renderBrowserEvidenceMarkdown(report: BrowserEvidenceReport): string[] {
  const out: string[] = [];
  const { inputs } = report;
  out.push('', '## Browser report candidates (AECI-1716)', '');
  out.push(
    'Report-only. Two candidates read `browser_evidence` beside the running classifier. ' +
      '`interacted` overrides the families listed below, never a known bot, and never the ' +
      'request-shape or burst family. The ASN rule writes `is_bot` on every `DATACENTER_ASNS` row, so ' +
      'such a row stays a known bot. `ran` is counted and is ' +
      'never human evidence. `no_browser_report` is one more family on an `ssr-arrival` and still needs ' +
      'a second family to reach Suspected. A privacy-signal row or a held-region row is "not collected", ' +
      'and its NULL is never evidence.',
  );
  out.push('');
  out.push(
    table(
      ['Input or constant', 'Value'],
      [
        ['Rows read at', inputs.readAt],
        [
          'Capture start',
          inputs.captureFrom === null
            ? 'none: no `ssr-arrival` in the pulled rows carries a report, so every NULL reads capture off'
            : `${inputs.captureFrom} (${inputs.captureFromSource === 'input' ? '`--capture-from`' : 'derived: the first `ssr-arrival` that carries a report'})`,
        ],
        [
          'Excluded ids',
          inputs.excludeIds.length === 0
            ? '(none)'
            : inputs.excludeIds
                .map((r) => (r.from === r.to ? `${r.from}` : `${r.from}-${r.to}`))
                .join(', '),
        ],
        ['`BROWSER_REPORT_SETTLE_MINUTES`', report.constants.BROWSER_REPORT_SETTLE_MINUTES],
        ['`INTERACTED_RULE_SEAM_DAY`', report.constants.INTERACTED_RULE_SEAM_DAY],
        [
          '`INTERACTED_OVERRIDES_FAMILIES`',
          report.constants.INTERACTED_OVERRIDES_FAMILIES.map((f) => `\`${f}\``).join(', '),
        ],
      ],
    ),
  );
  out.push('');
  out.push(
    'A derived capture start is the first report seen, so it can only be later than the true start. ' +
      'That moves rows to capture off, never to `no_browser_report`. A tier whose `page_views` was copied ' +
      "from another tier (AECI-1986) reads the source tier's reports on the copied rows.",
  );

  const days = report.days;
  out.push('', '### Arrivals by report state', '');
  out.push(
    table(
      [
        'Day',
        'Interaction rule',
        'Interacted',
        'Ran',
        'No report (candidate)',
        'Not collected: privacy',
        'Not collected: held region',
        'Capture off',
        'In flight',
        'Known bot',
        'Verdict not browser',
        'Excluded ids',
      ],
      days.map((d) => [
        d.day,
        RULE_LABEL[d.rule],
        d.arrivals.interacted,
        d.arrivals.ran,
        d.arrivals.no_browser_report,
        d.arrivals.not_collected_privacy,
        d.arrivals.not_collected_held_region,
        d.arrivals.capture_off,
        d.arrivals.in_flight,
        d.arrivals.known_bot,
        d.arrivals.verdict_not_browser,
        d.excluded,
      ]),
    ),
  );
  out.push('', '### In-app views by report state', '');
  out.push(
    'An in-app row is written with `ran` while capture is on, so a NULL one is capture off. ' +
      'Since AECI-1987 the click that opened it can mark it `interacted`.',
    '',
  );
  out.push(
    table(
      [
        'Day',
        'Interacted',
        'Ran',
        'NULL (capture off)',
        'Not collected: privacy',
        'Not collected: held region',
      ],
      days.map((d) => [
        d.day,
        d.inApp.interacted,
        d.inApp.ran,
        d.inApp.not_arrival,
        d.inApp.not_collected_privacy,
        d.inApp.not_collected_held_region,
      ]),
    ),
  );

  const privacy = sum(
    days,
    (d) => d.arrivals.not_collected_privacy + d.inApp.not_collected_privacy,
  );
  const held = sum(
    days,
    (d) => d.arrivals.not_collected_held_region + d.inApp.not_collected_held_region,
  );
  out.push('', '### Not collected', '');
  out.push(
    `${privacy + held} rows are not collected: ${privacy} privacy-signal rows and ${held} held-region rows ` +
      '(`isHeldRegionCountry`, a NULL country included). Their NULL is never automation evidence. ' +
      `${sum(days, (d) => d.unexpectedReports)} of them carry a report anyway, and ` +
      `${sum(days, (d) => d.unknownValues)} rows carry a value other than \`ran\` or \`interacted\`. Both should be 0.`,
  );

  out.push('', '### Blocker loss: Turnstile-pass arrivals with no report', '');
  out.push(
    'A Turnstile pass proves our page script ran in that load. Only arrivals that could report are counted: ' +
      'collected, captured and settled. A pass with no report is a report that was blocked or lost. Each one ' +
      'that is not a known bot and has a browser verdict would carry `no_browser_report`, so this is a false-exclusion floor. ' +
      '"Lost with a hop" counts `no_browser_report` rows whose client made a browser-verified in-app hop within the follow-up window.',
    '',
  );
  out.push(
    table(
      ['Day', 'Turnstile-pass arrivals', 'With no report', 'Loss', 'No report, lost with a hop'],
      [
        ...days.map((d) => [
          d.day,
          d.turnstilePass,
          d.turnstilePassNoReport,
          pct(d.turnstilePassNoReport, d.turnstilePass),
          d.noReportWithHop,
        ]),
        [
          'Total',
          sum(days, (d) => d.turnstilePass),
          sum(days, (d) => d.turnstilePassNoReport),
          pct(
            sum(days, (d) => d.turnstilePassNoReport),
            sum(days, (d) => d.turnstilePass),
          ),
          sum(days, (d) => d.noReportWithHop),
        ],
      ],
    ),
  );

  for (const signal of ['interacted', 'no_browser_report'] as const) {
    const moves = report.moves.filter((m) => m.signal === signal);
    out.push(
      '',
      `### Moved by \`${signal}\`, by network (top ${LISTED_ROWS} of ${moves.length})`,
      '',
    );
    out.push('Baseline is the running classifier. Only rows whose class changed.', '');
    if (signal === 'interacted') {
      out.push(
        '"By the network drop" counts the rows that read this class only because `interacted` also ' +
          'outweighs the network family (2026-11-22). Without it they would read another class.',
        '',
      );
    }
    const head = ['ASN', 'Network', 'From', 'To', 'Rows'];
    out.push(
      moves.length === 0
        ? 'None.'
        : table(
            signal === 'interacted' ? [...head, 'By the network drop'] : head,
            moves.slice(0, LISTED_ROWS).map((m) => {
              const cells = [m.cfAsn ?? '(none)', m.kind, m.from, m.to, m.rows];
              return signal === 'interacted' ? [...cells, m.byNetworkDrop] : cells;
            }),
          ),
    );
  }

  out.push('', '### AECI-1659 coordinated identities beside `no_browser_report`', '');
  out.push(
    'Member rows of a coordinated group that carry `no_browser_report`. The report is not read from the ' +
      'hash, so under the 2026-11-12 ruling it can be the second family. "Only partner" rows have no ' +
      'classifier family at all.',
    '',
  );
  out.push(
    table(
      [
        'Day',
        'Held out',
        'Member rows',
        'With no report',
        'To Suspected with both',
        'Only partner',
        'Member rows interacted',
      ],
      report.coordinated.map((c) => [
        c.day,
        c.heldOut ? 'yes' : 'no',
        c.memberRows,
        c.withNoReport,
        c.toSuspected,
        c.onlyPartner,
        c.interacted,
      ]),
    ),
  );

  out.push('', '### Interacted share: operator rows and labelled sessions', '');
  out.push(
    'Operator rows are rows with `is_operator = 1`. Only rows that could report are in the share. ' +
      `The share has a seam on ${report.constants.INTERACTED_RULE_SEAM_DAY}, when the click that opens an ` +
      'in-app page and a link opened in a new tab began to count.',
    '',
  );
  out.push(
    report.operatorShare.length === 0
      ? 'No operator rows in the window.'
      : shareTable(report.operatorShare),
  );
  out.push('');
  out.push(
    report.labelledShare === null
      ? 'Labelled sessions: none supplied. Record them in the labels file (§3c) and run again.'
      : report.labelledShare.length === 0
        ? 'Labelled sessions: supplied, and no row matched any of them.'
        : shareTable(report.labelledShare),
  );

  out.push(
    '',
    `### Forgery check: \`interacted\` rows that carry automation families (top ${LISTED_ROWS} of ${report.interactedWithAutomation.length})`,
    '',
  );
  out.push(
    'A client that runs our script can post `interacted` for itself: it can read its own ray, and it can ' +
      'answer its own new-tab question. A real person rarely also carries an automation family, so this ' +
      'lists the overlap by network. It cannot see a forger whose rows carry no family, and it cannot tell ' +
      'a person on a shared or rented network from a forger there. A `network` family is listed like any ' +
      'other. `burst` stands (2026-11-23), so a burst row is never rescued. "Network drop only" is the part of the rescue the 2026-11-22 ruling adds. "Held: known bot" ' +
      'counts rows the override declines, such as a `DATACENTER_ASNS` row the ASN rule marked `is_bot`.',
    '',
  );
  out.push(
    report.interactedWithAutomation.length === 0
      ? 'None.'
      : table(
          [
            'ASN',
            'Network',
            'Families',
            'Interacted rows',
            'Rescued by the override',
            'Network drop only',
            'Held: known bot',
          ],
          report.interactedWithAutomation
            .slice(0, LISTED_ROWS)
            .map((r) => [
              r.cfAsn ?? '(none)',
              r.kind,
              r.families,
              r.rows,
              r.rescued,
              r.rescuedByNetworkDrop,
              r.heldKnownBot,
            ]),
        ),
  );
  out.push(
    '',
    `### Client-days with the most \`interacted\` rows (top ${BUSIEST_INTERACTED_SHOWN} of ${report.busiestInteracted.length})`,
    '',
  );
  out.push(
    'A person interacts with a handful of pages a day. A forger at volume shows here first.',
    '',
  );
  out.push(
    report.busiestInteracted.length === 0
      ? 'None.'
      : table(
          ['Day', 'UA hash', 'ASN', 'Interacted', 'With a family'],
          report.busiestInteracted
            .slice(0, BUSIEST_INTERACTED_SHOWN)
            .map((c) => [
              c.day,
              hash8(c.userAgentHash),
              c.cfAsn ?? '(none)',
              c.interacted,
              c.withFamily,
            ]),
        ),
  );
  return out;
}
