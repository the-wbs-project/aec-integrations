/**
 * The coordinated-identities candidate in the shadow report (AECI-1659,
 * `POST_LAUNCH_MONITORING.md` §3c).
 *
 * Overlays {@link findCoordinatedGroups} on the running classifier's result for
 * every row, the way the AECI-1584 hash-level candidates do. The overlay reads the
 * families off `classifyPageView`'s reason codes through `candidateClass`, so it
 * cannot drift from the running rules on anything but the family it adds. A member
 * row still needs a second family to reach Suspected.
 *
 * Report-only. `traffic-classifier.ts` does not import this file, so the version
 * and fingerprint stay put, and nothing writes `is_bot` or a classification row.
 */

import { compareText } from '@aeci/shared/text-sort';

import type { AsnNetworkClass } from './asn-registry';
import { datacenterAsnEntries } from './bot-classification';
import {
  COORDINATED_CONSTANTS,
  type CoordinatedDay,
  type CoordinatedGroup,
} from './coordinated-identities';
import { candidateClass, familiesOfCodes } from './traffic-shadow-candidates';
import {
  type ClassifierRow,
  type PageViewClassification,
  type TrafficClass,
} from './traffic-classifier';

const DATACENTER_ASN_SET: ReadonlySet<number> = new Set(datacenterAsnEntries().map(([a]) => a));

/** What kind of network a group's main network is, for the false-exclusion read. */
export type MainNetworkKind = 'datacenter' | 'non_eyeball' | 'ordinary';

export function mainNetworkKind(
  cfAsn: number,
  networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>,
): MainNetworkKind {
  if (DATACENTER_ASN_SET.has(cfAsn)) return 'datacenter';
  return networkClassByAsn.get(cfAsn) === 'non_eyeball' ? 'non_eyeball' : 'ordinary';
}

/** One group of one day, as the report lists it. */
export interface CoordinatedGroupDay extends CoordinatedGroup {
  day: string;
  heldOut: boolean;
  kind: MainNetworkKind;
}

/** Per day: what the candidate does to the rows of coordinated members. */
export interface CoordinatedReachDay {
  day: string;
  heldOut: boolean;
  /** Coordinated groups on the day. */
  groups: number;
  /** Rows of coordinated members, any class. */
  memberRows: number;
  /** Member rows the overlay moves into `suspected_automation`. */
  toSuspected: number;
  /** Member rows with no other family and no human evidence: they would read `single_signal_coordinated`. */
  singleSignalOnly: number;
  /** Member rows that leave `browser_with_human_evidence` for `unresolved`. */
  humanToUnresolved: number;
  /** Member rows whose group's main network is neither datacenter nor non-eyeball. */
  ordinaryNetworkRows: number;
  /** Of those, the rows the overlay moves into `suspected_automation`. */
  ordinaryNetworkToSuspected: number;
}

/** The families a moved row paired with to reach Suspected, counted. */
export interface SecondFamilyCount {
  /** Base families joined with `+`, sorted. */
  families: string;
  rows: number;
}

export interface CoordinatedReport {
  constants: typeof COORDINATED_CONSTANTS;
  groups: CoordinatedGroupDay[];
  reach: CoordinatedReachDay[];
  secondFamilies: SecondFamilyCount[];
}

/** The class a row reads with the coordinated family added, when it is a member. */
export function coordinatedClass(result: PageViewClassification, member: boolean): TrafficClass {
  if (!member) return result.class;
  return candidateClass(result.class, familiesOfCodes(result.reasonCodes), [
    'coordinated_identities',
  ]);
}

export class CoordinatedCollector {
  private readonly groups: CoordinatedGroupDay[] = [];
  private readonly reach: CoordinatedReachDay[] = [];
  private readonly secondFamilies = new Map<string, number>();
  private current: {
    reach: CoordinatedReachDay;
    memberRowIds: ReadonlySet<number>;
    kindByHash: Map<string, MainNetworkKind>;
  } | null = null;

  /** Start a day. Call before its rows. */
  addDay(
    day: string,
    found: CoordinatedDay,
    heldOut: boolean,
    networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>,
  ): void {
    const kindByHash = new Map<string, MainNetworkKind>();
    let coordinated = 0;
    for (const g of found.groups) {
      const kind = mainNetworkKind(g.cfAsn, networkClassByAsn);
      this.groups.push({ ...g, day, heldOut, kind });
      if (!g.coordinated) continue;
      coordinated += 1;
      for (const hash of g.userAgentHashes) kindByHash.set(hash, kind);
    }
    const reach: CoordinatedReachDay = {
      day,
      heldOut,
      groups: coordinated,
      memberRows: 0,
      toSuspected: 0,
      singleSignalOnly: 0,
      humanToUnresolved: 0,
      ordinaryNetworkRows: 0,
      ordinaryNetworkToSuspected: 0,
    };
    this.reach.push(reach);
    this.current = { reach, memberRowIds: found.memberRowIds, kindByHash };
  }

  /** Overlay one row of the current day. Returns the class it would read. */
  addRow(
    row: Pick<ClassifierRow, 'id' | 'userAgentHash'>,
    result: PageViewClassification,
  ): TrafficClass {
    const day = this.current;
    if (day === null) throw new Error('CoordinatedCollector.addRow before addDay');
    const member = day.memberRowIds.has(row.id);
    const overlay = coordinatedClass(result, member);
    if (!member) return overlay;
    const { reach } = day;
    const families = familiesOfCodes(result.reasonCodes);
    const moved = overlay === 'suspected_automation' && result.class !== 'suspected_automation';
    reach.memberRows += 1;
    if (moved) {
      reach.toSuspected += 1;
      const key = [...families].sort(compareText).join('+');
      this.secondFamilies.set(key, (this.secondFamilies.get(key) ?? 0) + 1);
    }
    // A member with human evidence and no other family reads `conflicting_signals`,
    // not the single-signal code, so it is counted under `humanToUnresolved` alone.
    if (
      result.class !== 'identified_automation' &&
      families.length === 0 &&
      !result.reasonCodes.includes('app_executed')
    ) {
      reach.singleSignalOnly += 1;
    }
    if (result.class === 'browser_with_human_evidence' && overlay === 'unresolved') {
      reach.humanToUnresolved += 1;
    }
    const kind = row.userAgentHash === null ? undefined : day.kindByHash.get(row.userAgentHash);
    if (kind === 'ordinary') {
      reach.ordinaryNetworkRows += 1;
      if (moved) reach.ordinaryNetworkToSuspected += 1;
    }
    return overlay;
  }

  finish(): CoordinatedReport {
    return {
      constants: COORDINATED_CONSTANTS,
      groups: this.groups,
      reach: this.reach,
      secondFamilies: [...this.secondFamilies.entries()]
        .map(([families, rows]) => ({ families, rows }))
        .sort((a, b) => b.rows - a.rows || compareText(a.families, b.families)),
    };
  }
}

// ─── Markdown ───────────────────────────────────────────────────────────────

function table(head: readonly string[], body: readonly (readonly (string | number)[])[]): string {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function yes(v: boolean): string {
  return v ? 'yes' : 'no';
}

/** Ordinary groups listed per day beside the coordinated ones, largest first. */
const UNCOORDINATED_GROUPS_SHOWN_PER_DAY = 3;

function reachTable(rows: readonly CoordinatedReachDay[]): string {
  if (rows.length === 0) return 'No days.';
  return table(
    [
      'Day',
      'Coordinated groups',
      'Member rows',
      'To Suspected',
      'Single signal only',
      'Human evidence to Unresolved',
      'Ordinary-network rows',
      'Ordinary to Suspected',
    ],
    rows.map((r) => [
      r.day,
      r.groups,
      r.memberRows,
      r.toSuspected,
      r.singleSignalOnly,
      r.humanToUnresolved,
      r.ordinaryNetworkRows,
      r.ordinaryNetworkToSuspected,
    ]),
  );
}

/** The candidate's sections of the shadow report. Slice metrics are rendered by the caller. */
export function renderCoordinatedMarkdown(report: CoordinatedReport): string[] {
  const out: string[] = [];
  out.push('', '## Coordinated identities candidate (AECI-1659)', '');
  out.push(
    'Report-only. Identities that share a main network form a group of at least ' +
      `${report.constants.COORDINATED_MIN_IDENTITIES}. A group is coordinated when ` +
      `${report.constants.COORDINATED_MIN_EVIDENCE} of three tests pass. Every row of a member is ` +
      'a member row, and it still needs a second family to reach Suspected.',
  );
  out.push('');
  out.push(
    table(
      ['Constant', 'Value'],
      Object.entries(report.constants).map(([k, v]) => [`\`${k}\``, v]),
    ),
  );

  out.push('', '### Groups', '');
  out.push(
    `Every coordinated group, then the ${UNCOORDINATED_GROUPS_SHOWN_PER_DAY} largest others per day. ` +
      'The JSON report has every group.',
  );
  out.push('');
  const shown: CoordinatedGroupDay[] = [];
  const others = new Map<string, number>();
  for (const g of report.groups) {
    if (g.coordinated) {
      shown.push(g);
      continue;
    }
    const seen = others.get(g.day) ?? 0;
    if (seen < UNCOORDINATED_GROUPS_SHOWN_PER_DAY) shown.push(g);
    others.set(g.day, seen + 1);
  }
  shown.sort((a, b) => compareText(a.day, b.day) || b.views - a.views || a.cfAsn - b.cfAsn);
  out.push(
    shown.length === 0
      ? 'No groups.'
      : table(
          [
            'Day',
            'Held out',
            'ASN',
            'Kind',
            'Identities',
            'Views',
            'Share',
            'Start aligned',
            'Max pair overlap',
            'Distinct path ratio',
            'Start',
            'Partition',
            'Share test',
            'Coordinated',
          ],
          shown.map((g) => [
            g.day,
            yes(g.heldOut),
            g.cfAsn,
            g.kind,
            g.identities,
            g.views,
            pct(g.share),
            `${g.startAligned} of ${g.identities}`,
            g.maxPairOverlap,
            pct(g.distinctPathRatio),
            yes(g.passes.start),
            yes(g.passes.partition),
            yes(g.passes.share),
            yes(g.coordinated),
          ]),
        ),
  );

  out.push('', '### Reach per day, tuning days', '');
  out.push(reachTable(report.reach.filter((r) => !r.heldOut)));
  out.push('', '### Reach per day, held-out days', '');
  out.push(
    'Read these only after choosing values on the tuning days.',
    '',
    reachTable(report.reach.filter((r) => r.heldOut)),
  );

  out.push('', '### Second family on rows moved to Suspected', '');
  out.push(
    'The families each moved row already carried. A hash-level family here (`swarm`, ' +
      '`crawl_shape`) is the case the 2026-11-07 ruling needs to settle.',
  );
  out.push('');
  out.push(
    report.secondFamilies.length === 0
      ? 'No row moved.'
      : table(
          ['Families', 'Rows'],
          report.secondFamilies.map((s) => [s.families.replaceAll('+', ' + '), s.rows]),
        ),
  );
  return out;
}
