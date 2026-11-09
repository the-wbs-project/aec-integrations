/**
 * The tested core of the AECI-872 shadow runner
 * (`scripts/traffic-classification-shadow.ts`, `POST_LAUNCH_MONITORING.md` §3c).
 *
 * The runner pulls `page_views` read-only from a D1, loads the rows into a local
 * SQLite database built from the real migrations, and then calls this module. Here
 * the existing detectors run unchanged (`detectSwarms`, `NOT_INTERNAL`,
 * `readArrivalCfCoverage`, `loadAsnAnnotations`), every row is classified by
 * `classifyPageView`, and the result is set beside the verdict the digest gives
 * today. Nothing here writes to the source D1, and nothing writes `is_bot`.
 *
 * Lives under `src/lib` rather than `scripts/lib` for the same reason
 * `metrics-backfill.ts` does: the unit lane and `tsc` cover `src/**` only.
 */

import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';

import { compareText } from '@aeci/shared/text-sort';

import type { Db } from '../db/client';
import { asnRegistry, pageViews } from '../db/schema';
import {
  ARRIVAL_CF_COVERAGE_MIN,
  readArrivalCfCoverage,
  type ArrivalCfCoverage,
} from './arrival-coverage';
import { loadAsnAnnotations, type AsnNetworkClass } from './asn-registry';
import { NOT_INTERNAL, OPERATOR_PAIR_LOOKBACK_DAYS } from './page-view-predicates';
import { detectSwarms, NON_BROWSER_VERDICTS, SWARM_PRIOR_LOOKBACK_DAYS } from './swarm-detection';
import { findCoordinatedGroups } from './coordinated-identities';
import {
  CandidateCollector,
  readHashWindows,
  readVerifiedHopDays,
  renderCandidateMarkdown,
  type CandidateReport,
} from './traffic-shadow-candidates';
import {
  CoordinatedCollector,
  renderCoordinatedMarkdown,
  type CoordinatedReport,
} from './traffic-shadow-coordinated';
import {
  BURST_WINDOW_SECONDS,
  classifyPageView,
  CRAWL_SHAPE_LOOKBACK_DAYS,
  CRAWL_SHAPE_MIN_VIEWS,
  crawlShapeTests,
  findBurstRows,
  findCrawlShapeRows,
  findSpaFollowups,
  isEdgeVerified,
  isNamedBotLabel,
  referralCodes,
  REASON_CODES,
  SPA_FOLLOWUP_WINDOW_MINUTES,
  TRAFFIC_CLASSES,
  type ClassifierContext,
  type ClassifierRow,
  type CrawlShapeWindow,
  type ReasonCode,
  type TrafficClass,
} from './traffic-classifier';

// ─── Read-only SQL for the pull ─────────────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Statements that can change a database. None may reach the source D1. */
const WRITE_KEYWORDS =
  /\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex|upsert)\b/i;

/**
 * Refuse anything that is not one `SELECT`. Every statement the runner sends to a
 * D1 passes through here first. A trailing `;` is allowed; any other `;` is not,
 * because it could start a second statement.
 */
export function assertSelectOnly(statement: string): string {
  const trimmed = statement.trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(trimmed)) {
    throw new Error(`Refusing a non-SELECT statement: ${trimmed.slice(0, 80)}`);
  }
  if (trimmed.includes(';')) throw new Error('Refusing a statement with more than one part.');
  if (WRITE_KEYWORDS.test(trimmed)) {
    throw new Error(`Refusing a statement with a write keyword: ${trimmed.slice(0, 80)}`);
  }
  return trimmed;
}

/** The `page_views` columns the runner pulls. No FK columns, no `dedupe_key`. */
export const PULL_COLUMNS = [
  'id',
  'path',
  'concrete_path',
  'navigation',
  'referrer_source',
  'cf_country',
  'cf_asn',
  'cf_as_organization',
  'cf_verified_bot',
  'cf_verified_bot_category',
  'user_agent_hash',
  'is_bot',
  'bot_name',
  'is_operator',
  'is_owner_visit',
  'sec_fetch_dest',
  'has_accept_language',
  'has_sec_ch_ua',
  'tls_version',
  'http_protocol',
  'client_verdict',
  'writer_provenance',
  'privacy_signal',
  // AECI-1584. Report-only: the candidate review shows it, and the classifier does not read it.
  'turnstile_verdict',
  'created_at',
] as const;

/** One pulled `page_views` row, as `wrangler d1 execute --json` returns it. */
export type PulledPageView = Record<(typeof PULL_COLUMNS)[number], string | number | null>;

/** One pulled `asn_registry` row. */
export interface PulledAsnRow {
  asn: number;
  info_type: string | null;
  as_name: string | null;
  source: string;
  fetched_at: string;
}

function isoLiteral(iso: string): string {
  if (!ISO_RE.test(iso)) throw new Error(`Not a UTC ISO instant: ${iso}`);
  return `'${iso}'`;
}

function intLiteral(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`Not a non-negative integer: ${n}`);
  return String(n);
}

/** One id-keyed chunk of `page_views` in `[fromIso, toIso)`. */
export function buildPageViewChunkSql(opts: {
  fromIso: string;
  toIso: string;
  afterId: number;
  limit: number;
  operatorOnly?: boolean;
}): string {
  return assertSelectOnly(
    `SELECT ${PULL_COLUMNS.join(', ')} FROM page_views` +
      ` WHERE created_at >= ${isoLiteral(opts.fromIso)} AND created_at < ${isoLiteral(opts.toIso)}` +
      (opts.operatorOnly ? ' AND is_operator = 1' : '') +
      ` AND id > ${intLiteral(opts.afterId)} ORDER BY id LIMIT ${intLiteral(opts.limit)}`,
  );
}

/** The `asn_registry` rows for every ASN seen in `[fromIso, toIso)`. */
export function buildAsnRegistrySql(fromIso: string, toIso: string): string {
  return assertSelectOnly(
    'SELECT asn, info_type, as_name, source, fetched_at FROM asn_registry WHERE asn IN' +
      ` (SELECT DISTINCT cf_asn FROM page_views WHERE created_at >= ${isoLiteral(fromIso)}` +
      ` AND created_at < ${isoLiteral(toIso)} AND cf_asn IS NOT NULL)`,
  );
}

// ─── Windows ────────────────────────────────────────────────────────────────

function shiftIso(iso: string, deltaMs: number): string {
  return new Date(Date.parse(iso) + deltaMs).toISOString();
}

const DAY_MS = 86_400_000;

/** Every `YYYY-MM-DD` from `fromDay` to `toDay`, inclusive. */
export function daysBetween(fromDay: string, toDay: string): string[] {
  if (!DAY_RE.test(fromDay) || !DAY_RE.test(toDay)) throw new Error('Days must be YYYY-MM-DD.');
  if (fromDay > toDay) throw new Error(`--from ${fromDay} is after --to ${toDay}.`);
  const out: string[] = [];
  for (let at = Date.parse(`${fromDay}T00:00:00.000Z`); ; at += DAY_MS) {
    const day = new Date(at).toISOString().slice(0, 10);
    if (day > toDay) break;
    out.push(day);
  }
  return out;
}

/**
 * The windows a run must pull to reproduce the digest exactly.
 *
 * - `rows`: the reported days, plus the longer of the {@link SWARM_PRIOR_LOOKBACK_DAYS}
 *   prior `detectSwarms` reads and the {@link CRAWL_SHAPE_LOOKBACK_DAYS} crawl-shape
 *   window before them, plus the SPA follow-up margin after. This is what a stored
 *   row's `evidence_from` and `evidence_to` state, so a longer read must widen it.
 * - `operatorAnchors`: `is_operator = 1` rows only, widened by
 *   {@link OPERATOR_PAIR_LOOKBACK_DAYS} each side so `NOT_INTERNAL`'s retro-join
 *   sees every anchor it would see on the source D1.
 */
export function evidenceWindows(fromDay: string, toDay: string) {
  daysBetween(fromDay, toDay);
  const start = `${fromDay}T00:00:00.000Z`;
  const end = shiftIso(`${toDay}T00:00:00.000Z`, DAY_MS);
  const lookbackDays = Math.max(SWARM_PRIOR_LOOKBACK_DAYS, CRAWL_SHAPE_LOOKBACK_DAYS);
  const rowsFrom = shiftIso(start, -lookbackDays * DAY_MS);
  const rowsTo = shiftIso(end, SPA_FOLLOWUP_WINDOW_MINUTES * 60_000);
  return {
    reported: { from: start, to: end },
    rows: { from: rowsFrom, to: rowsTo },
    operatorAnchors: {
      from: shiftIso(rowsFrom, -OPERATOR_PAIR_LOOKBACK_DAYS * DAY_MS),
      to: shiftIso(end, OPERATOR_PAIR_LOOKBACK_DAYS * DAY_MS),
    },
  };
}

// ─── Load ───────────────────────────────────────────────────────────────────

function str(v: string | number | null): string | null {
  return v === null || v === undefined ? null : String(v);
}

function num(v: string | number | null): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v: string | number | null): boolean | null {
  if (v === null || v === undefined) return null;
  return v === 1 || v === '1' || v === 'true';
}

/** 25 bound values per row; 100 rows stays far under SQLite's parameter limit. */
const LOAD_CHUNK = 100;

/**
 * Insert pulled rows into the local database, keeping their ids. Rows are
 * de-duplicated by id first, because the operator-anchor pull overlaps the row pull.
 */
export async function loadPulledRows(
  db: Db,
  views: readonly PulledPageView[],
  asns: readonly PulledAsnRow[],
): Promise<{ pageViews: number; asnRegistry: number }> {
  const byId = new Map<number, PulledPageView>();
  for (const v of views) byId.set(Number(v.id), v);
  const rows = [...byId.values()].map((v) => ({
    id: Number(v.id),
    path: String(v.path),
    concretePath: str(v.concrete_path),
    navigation: str(v.navigation),
    referrerSource: str(v.referrer_source),
    cfCountry: str(v.cf_country),
    cfAsn: num(v.cf_asn),
    cfAsOrganization: str(v.cf_as_organization),
    cfVerifiedBot: bool(v.cf_verified_bot),
    cfVerifiedBotCategory: str(v.cf_verified_bot_category),
    userAgentHash: str(v.user_agent_hash),
    isBot: bool(v.is_bot),
    botName: str(v.bot_name),
    isOperator: bool(v.is_operator),
    isOwnerVisit: bool(v.is_owner_visit),
    secFetchDest: str(v.sec_fetch_dest),
    hasAcceptLanguage: bool(v.has_accept_language),
    hasSecChUa: bool(v.has_sec_ch_ua),
    tlsVersion: str(v.tls_version),
    httpProtocol: str(v.http_protocol),
    clientVerdict: str(v.client_verdict),
    writerProvenance: str(v.writer_provenance),
    privacySignal: bool(v.privacy_signal),
    turnstileVerdict: str(v.turnstile_verdict),
    createdAt: String(v.created_at),
  }));
  for (let i = 0; i < rows.length; i += LOAD_CHUNK) {
    await db.insert(pageViews).values(rows.slice(i, i + LOAD_CHUNK));
  }
  const registry = [...new Map(asns.map((a) => [Number(a.asn), a])).values()].map((a) => ({
    asn: Number(a.asn),
    infoType: a.info_type,
    asName: a.as_name,
    source: a.source,
    fetchedAt: a.fetched_at,
  }));
  for (let i = 0; i < registry.length; i += LOAD_CHUNK) {
    await db.insert(asnRegistry).values(registry.slice(i, i + LOAD_CHUNK));
  }
  return { pageViews: rows.length, asnRegistry: registry.length };
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** The slices a labels file can name. Both are real browser activity. */
export const LABELLED_SLICES = ['operator', 'privacy_hardened'] as const;

const LabelSessionSchema = z.object({
  slice: z.enum(LABELLED_SLICES),
  browser: z.string().min(1),
  startUtc: z.string().datetime(),
  endUtc: z.string().datetime(),
  /** Home network. A session with GPC on has no row to read this from, so it may be absent. */
  cfAsn: z.number().int().positive().optional(),
  /** Pages opened, as `concrete_path` stores them. How a DNT/GPC row is matched. */
  paths: z
    .array(z.string().regex(/^\/[^?#]*$/))
    .min(1)
    .optional(),
  note: z.string().optional(),
});

const LabelsFileSchema = z.object({
  sessions: z.array(LabelSessionSchema).default([]),
  heldOutDays: z.array(z.string().regex(DAY_RE)).default([]),
});

export type LabelSession = z.infer<typeof LabelSessionSchema>;
export type LabelsFile = z.infer<typeof LabelsFileSchema>;

/** Validate a parsed labels file. Throws on a malformed one rather than guessing. */
export function parseLabelsFile(json: unknown): LabelsFile {
  const labels = LabelsFileSchema.parse(json);
  for (const s of labels.sessions) {
    if (Date.parse(s.startUtc) >= Date.parse(s.endUtc)) {
      throw new Error(`Labelled session ${s.browser} ends before it starts.`);
    }
    if (s.cfAsn === undefined && s.paths === undefined) {
      throw new Error(`Labelled session ${s.browser} needs a cfAsn, paths, or both.`);
    }
  }
  assertPrivacyRowsAttributable(labels.sessions);
  return labels;
}

const HOUR_MS = 3_600_000;

/** The start of the UTC hour `iso` falls in, as epoch milliseconds. */
function hourFloor(iso: string): number {
  return Math.floor(Date.parse(iso) / HOUR_MS) * HOUR_MS;
}

/**
 * Refuse two sessions that share a page and touch the same UTC hour. A privacy row's
 * time is cut to the hour, so its session could not be told apart, even when the two
 * windows do not overlap.
 */
function assertPrivacyRowsAttributable(sessions: readonly LabelSession[]): void {
  sessions.forEach((a, i) => {
    for (const b of sessions.slice(i + 1)) {
      const hoursOverlap =
        hourFloor(a.startUtc) <= hourFloor(b.endUtc) &&
        hourFloor(b.startUtc) <= hourFloor(a.endUtc);
      const shared = a.paths?.find((p) => b.paths?.includes(p));
      if (hoursOverlap && shared !== undefined) {
        throw new Error(
          `Labelled sessions ${a.browser} and ${b.browser} share ${shared} in one UTC hour.`,
        );
      }
    }
  });
}

/**
 * The labelled session a row belongs to, or null. There are two ways to match.
 *
 * - Network: inside the session window (inclusive) and on the session's home
 *   `cf_asn`. A stranger on the same ISP in the same ten minutes would match too; the
 *   window is short so that cost stays small.
 * - Privacy (AECI-1582): a DNT/GPC row stores no ASN and its time is cut to the hour
 *   (AECI-1386). So it matches on `privacy_signal`, on a page the session recorded,
 *   and from the start of the session's first hour to its end. A stranger with GPC on
 *   the same page in the same hour would match too. That shows as a false exclusion
 *   to read, and it never hides one.
 */
export function matchLabelledSession(
  row: Pick<ClassifierRow, 'createdAt' | 'cfAsn' | 'concretePath' | 'privacySignal'>,
  sessions: readonly LabelSession[],
): LabelSession | null {
  const at = Date.parse(row.createdAt);
  return (
    sessions.find((s) => {
      if (at > Date.parse(s.endUtc)) return false;
      if (row.cfAsn !== null && s.cfAsn === row.cfAsn && at >= Date.parse(s.startUtc)) return true;
      return (
        row.privacySignal === true &&
        row.concretePath !== null &&
        s.paths?.includes(row.concretePath) === true &&
        at >= hourFloor(s.startUtc)
      );
    }) ?? null
  );
}

// ─── Slices and metrics ─────────────────────────────────────────────────────

/** The §3c reviewed-sample slices the runner can build. */
export const SHADOW_SLICES = [
  'operator',
  'privacy_hardened',
  'known_bot',
  'privacy_unlabelled',
  'shared_proxy_candidate',
  'unknown',
] as const;
export type ShadowSlice = (typeof SHADOW_SLICES)[number];

/** What a slice's rows truly are, where we know. */
const SLICE_TRUTH: Readonly<Record<ShadowSlice, 'human' | 'automation' | 'unknown'>> = {
  operator: 'human',
  privacy_hardened: 'human',
  known_bot: 'automation',
  // AECI-1582. A scanner can send `DNT: 1` too, so this measures reach, not truth.
  privacy_unlabelled: 'unknown',
  shared_proxy_candidate: 'unknown',
  unknown: 'unknown',
};

/** The verdict the digest gives a row today, most decisive first. */
export const CURRENT_VERDICTS = ['internal', 'BOT', 'automation_flagged', 'HUMAN'] as const;
export type CurrentVerdict = (typeof CURRENT_VERDICTS)[number];

/** Distinct UA hashes on one eyeball ASN in one UTC hour before it is listed for review. */
export const SHARED_PROXY_MIN_UA_HASHES = 5;

export interface SharedProxyCandidate {
  cfAsn: number;
  hour: string;
  distinctUaHashes: number;
  views: number;
}

/**
 * Eyeball ASNs carrying many UA hashes in one hour: office NAT, campus, café, or a
 * proxy pool. Listed for a human to review, never labelled automatically.
 */
export function findSharedProxyCandidates(
  rows: readonly Pick<ClassifierRow, 'id' | 'createdAt' | 'cfAsn' | 'userAgentHash' | 'isBot'>[],
  networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>,
  minUaHashes: number = SHARED_PROXY_MIN_UA_HASHES,
): { candidates: SharedProxyCandidate[]; rowIds: Set<number> } {
  const groups = new Map<
    string,
    { cfAsn: number; hour: string; hashes: Set<string>; ids: number[] }
  >();
  for (const r of rows) {
    if (r.isBot === true || r.cfAsn === null || r.userAgentHash === null) continue;
    if (networkClassByAsn.get(r.cfAsn) !== 'eyeball') continue;
    const hour = r.createdAt.slice(0, 13);
    const key = `${r.cfAsn}|${hour}`;
    const g = groups.get(key) ?? { cfAsn: r.cfAsn, hour, hashes: new Set<string>(), ids: [] };
    g.hashes.add(r.userAgentHash);
    g.ids.push(r.id);
    groups.set(key, g);
  }
  const candidates: SharedProxyCandidate[] = [];
  const rowIds = new Set<number>();
  for (const g of groups.values()) {
    if (g.hashes.size < minUaHashes) continue;
    candidates.push({
      cfAsn: g.cfAsn,
      hour: g.hour,
      distinctUaHashes: g.hashes.size,
      views: g.ids.length,
    });
    for (const id of g.ids) rowIds.add(id);
  }
  candidates.sort((a, b) => b.distinctUaHashes - a.distinctUaHashes || compareText(a.hour, b.hour));
  return { candidates, rowIds };
}

/** One classified row, reduced to what the metrics need. */
export interface ShadowRowOutcome {
  day: string;
  slice: ShadowSlice;
  heldOut: boolean;
  current: CurrentVerdict;
  /** `is_bot` or the digest's automation filter, whatever `internal` says. */
  currentAutomation: boolean;
  class: TrafficClass;
  /** The class with crawl shape and bursts switched off: the rules before AECI-1578. */
  baselineClass: TrafficClass;
  internal: boolean;
}

export type ClassCounts = Record<TrafficClass, number>;

function zeroClassCounts(): ClassCounts {
  return Object.fromEntries(TRAFFIC_CLASSES.map((c) => [c, 0])) as ClassCounts;
}

function share(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

const AUTOMATION_CLASSES: ReadonlySet<TrafficClass> = new Set([
  'identified_automation',
  'suspected_automation',
]);

export interface SliceMetrics {
  slice: ShadowSlice;
  partition: 'all' | 'tuning' | 'held_out';
  truth: 'human' | 'automation' | 'unknown';
  rows: number;
  classCounts: ClassCounts;
  /** Human-truth slices only: rows placed in an automation class. */
  falseExclusions: { new: number; newShare: number | null; current: number } | null;
  /** Automation-truth slices only: rows placed in the human-evidence class. */
  missedAutomation: { new: number; newShare: number | null; current: number } | null;
  unresolved: number;
  unresolvedShare: number | null;
}

/** The three §3c metrics for one slice and partition. */
export function sliceMetrics(
  outcomes: readonly ShadowRowOutcome[],
  slice: ShadowSlice,
  partition: SliceMetrics['partition'],
): SliceMetrics {
  const rows = outcomes.filter(
    (o) =>
      o.slice === slice &&
      (partition === 'all' || (partition === 'held_out' ? o.heldOut : !o.heldOut)),
  );
  const classCounts = zeroClassCounts();
  for (const o of rows) classCounts[o.class] += 1;
  const truth = SLICE_TRUTH[slice];
  const automationNew = rows.filter((o) => AUTOMATION_CLASSES.has(o.class)).length;
  const humanNew = classCounts.browser_with_human_evidence;
  return {
    slice,
    partition,
    truth,
    rows: rows.length,
    classCounts,
    falseExclusions:
      truth === 'human'
        ? {
            new: automationNew,
            newShare: share(automationNew, rows.length),
            current: rows.filter((o) => o.currentAutomation).length,
          }
        : null,
    missedAutomation:
      truth === 'automation'
        ? {
            new: humanNew,
            newShare: share(humanNew, rows.length),
            current: rows.filter((o) => o.current === 'HUMAN').length,
          }
        : null,
    unresolved: classCounts.unresolved,
    unresolvedShare: share(classCounts.unresolved, rows.length),
  };
}

/** Rows the crawl-shape and burst families moved out of their baseline class. */
export interface FamilyMove {
  slice: ShadowSlice;
  partition: 'tuning' | 'held_out';
  from: TrafficClass;
  to: TrafficClass;
  rows: number;
}

/** Every baseline-to-new class change, by slice and partition, largest first. */
export function familyMoves(outcomes: readonly ShadowRowOutcome[]): FamilyMove[] {
  const moves = new Map<string, FamilyMove>();
  for (const o of outcomes) {
    if (o.baselineClass === o.class) continue;
    const partition = o.heldOut ? 'held_out' : 'tuning';
    const key = [o.slice, partition, o.baselineClass, o.class].join('|');
    const move = moves.get(key) ?? {
      slice: o.slice,
      partition,
      from: o.baselineClass,
      to: o.class,
      rows: 0,
    };
    move.rows += 1;
    moves.set(key, move);
  }
  return [...moves.values()].sort(
    (a, b) =>
      b.rows - a.rows ||
      compareText([a.slice, a.from, a.to].join(), [b.slice, b.from, b.to].join()),
  );
}

/** One client-day that carried a new family's signal. */
export interface NewFamilyClient {
  day: string;
  userAgentHash: string | null;
  cfAsn: number | null;
  /** Rows of this client-day carrying `crawl_shape_member` or `burst_member`. */
  views: number;
  crawlShapeViews: number;
  burstViews: number;
  classCounts: ClassCounts;
}

/** Which crawl-shape test a pair passed. */
export type CrawlTest = 'dayOnly' | 'trailingOnly' | 'both';

/**
 * The two crawl-shape tests side by side, over Chris's AECI-1578 population: rows
 * the baseline left in `single_signal_network`, with a hash and an ASN.
 */
export interface CrawlReach extends Record<CrawlTest, number> {
  population: number;
  neither: number;
}

/**
 * A pair crawl shape moved to an automation class. The list to read for the
 * false-exclusion risk: a real person on a VPN who loads many different pages and
 * never navigates inside the app looks like this. A low `windowArrivals` over many
 * `activeDays` is the shape to look at first.
 */
export interface CrawlExclusionPair {
  day: string;
  userAgentHash: string;
  cfAsn: number;
  test: CrawlTest;
  dayViews: number;
  windowArrivals: number;
  distinctPaths: number;
  activeDays: number;
  /** The day's views that arrived from a search engine or another site. */
  referredViews: number;
}

/**
 * A pair that would have a crawl shape but for the hop veto. The list to read for a
 * crawler hidden on a shared pair: one person's hop stops the signal for every other
 * client on that browser identity and network. Few `verifiedHops` beside many
 * `dayArrivals` is the shape to look at first.
 */
export interface CrawlVetoedPair {
  day: string;
  userAgentHash: string;
  cfAsn: number;
  test: CrawlTest;
  dayArrivals: number;
  dayDistinctPaths: number;
  windowArrivals: number;
  distinctPaths: number;
  verifiedHops: number;
}

/** Which test a pair's counts pass, or null when neither does. Ignores the veto. */
function crawlTestOf(w: CrawlShapeWindow): CrawlTest | null {
  const { day, trailing } = crawlShapeTests(w);
  if (day && trailing) return 'both';
  if (day) return 'dayOnly';
  return trailing ? 'trailingOnly' : null;
}

const CRAWL_TEST_LABEL: Readonly<Record<CrawlTest, string>> = {
  dayOnly: 'day only',
  trailingOnly: 'trailing only',
  both: 'both',
};

// ─── The run ────────────────────────────────────────────────────────────────

/**
 * The columns `classifyPageView` reads, selected under its own field names. Shared
 * with the Phase 2 writer (`traffic-classification-writer.ts`) through
 * {@link buildClassificationDay}.
 */
export const CLASSIFIER_COLUMNS = {
  id: pageViews.id,
  createdAt: pageViews.createdAt,
  concretePath: pageViews.concretePath,
  navigation: pageViews.navigation,
  writerProvenance: pageViews.writerProvenance,
  clientVerdict: pageViews.clientVerdict,
  isBot: pageViews.isBot,
  botName: pageViews.botName,
  cfAsn: pageViews.cfAsn,
  cfVerifiedBot: pageViews.cfVerifiedBot,
  cfVerifiedBotCategory: pageViews.cfVerifiedBotCategory,
  hasSecChUa: pageViews.hasSecChUa,
  hasAcceptLanguage: pageViews.hasAcceptLanguage,
  secFetchDest: pageViews.secFetchDest,
  tlsVersion: pageViews.tlsVersion,
  referrerSource: pageViews.referrerSource,
  isOperator: pageViews.isOperator,
  userAgentHash: pageViews.userAgentHash,
  privacySignal: pageViews.privacySignal,
} satisfies Record<keyof ClassifierRow, unknown>;

/** One UTC day's rows and the context `classifyPageView` needs for them. */
export interface ClassificationDay {
  day: string;
  /** Every `page_views` row created in the UTC day, internal rows included, by id. */
  rows: ClassifierRow[];
  ctx: ClassifierContext;
  networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>;
  swarm: Awaited<ReturnType<typeof detectSwarms>>;
  coverage: ArrivalCfCoverage;
  /** The rows window the judgement rests on, `[from, to)` UTC ISO (`evidenceWindows`). */
  evidence: { from: string; to: string };
  /** Per-pair crawl-shape counts over the window, for the shadow report. */
  crawlWindows: CrawlShapeWindow[];
}

/**
 * Per-pair counts over the reported day plus {@link CRAWL_SHAPE_LOOKBACK_DAYS}, with
 * the reported day's own counts beside them. One grouped statement with a fixed few
 * bound values, so it stays clear of D1's parameter and compound-SELECT limits
 * however many pairs exist. Every row counts, `is_bot = 1` included, because the
 * targets are mostly rows the ASN rule labelled. The `having` floor reads the window,
 * which a pair passing the day test always meets too.
 *
 * Arrivals stop at the end of the reported day. Hops read the SPA follow-up margin
 * past it. Nothing else looks forward.
 */
export async function readCrawlShapeWindows(db: Db, day: string): Promise<CrawlShapeWindow[]> {
  const { reported, rows: evidence } = evidenceWindows(day, day);
  const arrival = sql`${pageViews.createdAt} < ${reported.to}
    and ${pageViews.concretePath} is not null
    and (${pageViews.navigation} = 'arrival' or ${pageViews.writerProvenance} = 'ssr-arrival')`;
  const dayArrival = sql`${pageViews.createdAt} >= ${reported.from} and ${arrival}`;
  const groups = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      cfAsn: pageViews.cfAsn,
      arrivals: sql<number>`sum(case when ${arrival} then 1 else 0 end)`,
      distinctPaths: sql<number>`count(distinct case when ${arrival} then ${pageViews.concretePath} end)`,
      activeDays: sql<number>`count(distinct case when ${arrival} then substr(${pageViews.createdAt}, 1, 10) end)`,
      dayArrivals: sql<number>`sum(case when ${dayArrival} then 1 else 0 end)`,
      dayDistinctPaths: sql<number>`count(distinct case when ${dayArrival} then ${pageViews.concretePath} end)`,
      verifiedHops: sql<number>`sum(case when ${pageViews.writerProvenance} = 'browser-spa' and ${pageViews.clientVerdict} = 'browser' then 1 else 0 end)`,
    })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, shiftIso(reported.from, -CRAWL_SHAPE_LOOKBACK_DAYS * DAY_MS)),
        lt(pageViews.createdAt, evidence.to),
        isNotNull(pageViews.userAgentHash),
        isNotNull(pageViews.cfAsn),
      ),
    )
    .groupBy(pageViews.userAgentHash, pageViews.cfAsn)
    .having(sql`sum(case when ${arrival} then 1 else 0 end) >= ${CRAWL_SHAPE_MIN_VIEWS}`);
  return groups.flatMap((g) =>
    g.userAgentHash === null || g.cfAsn === null
      ? []
      : [{ ...g, userAgentHash: g.userAgentHash, cfAsn: g.cfAsn }],
  );
}

/**
 * Assemble one UTC day for classification. This is the single population
 * definition (D19(h)): the shadow runner and the nightly writer both call it, so
 * the class a row is stored with is the class the shadow report counted.
 *
 * The detectors run unchanged: `detectSwarms`, `NOT_INTERNAL`, the SPA follow-up
 * lookup `SPA_FOLLOWUP_WINDOW_MINUTES` past the day's end, and `loadAsnAnnotations`.
 * Crawl shape and bursts read every row, because their targets are mostly
 * `is_bot = 1` rows that the `HUMAN`-scoped detectors never see. So the swarm prior
 * cannot stand in for {@link readCrawlShapeWindows}.
 */
export async function buildClassificationDay(db: Db, day: string): Promise<ClassificationDay> {
  const windows = evidenceWindows(day, day);
  const startIso = windows.reported.from;
  const endIso = windows.reported.to;
  const dayWindow = and(gte(pageViews.createdAt, startIso), lt(pageViews.createdAt, endIso));

  const [rows, internalRows, hops, swarm, coverage, crawlWindows, burstTail] = await Promise.all([
    db.select(CLASSIFIER_COLUMNS).from(pageViews).where(dayWindow).orderBy(pageViews.id),
    db
      .select({ id: pageViews.id })
      .from(pageViews)
      .where(and(dayWindow, sql`not (${NOT_INTERNAL})`)),
    db
      .select(CLASSIFIER_COLUMNS)
      .from(pageViews)
      .where(
        and(
          gte(pageViews.createdAt, startIso),
          lt(pageViews.createdAt, windows.rows.to),
          eq(pageViews.writerProvenance, 'browser-spa'),
          eq(pageViews.clientVerdict, 'browser'),
        ),
      ),
    detectSwarms(db, startIso, endIso),
    readArrivalCfCoverage(db, startIso, endIso),
    readCrawlShapeWindows(db, day),
    db
      .select({
        id: pageViews.id,
        createdAt: pageViews.createdAt,
        concretePath: pageViews.concretePath,
        cfAsn: pageViews.cfAsn,
        userAgentHash: pageViews.userAgentHash,
      })
      .from(pageViews)
      .where(
        and(
          gte(pageViews.createdAt, shiftIso(startIso, -BURST_WINDOW_SECONDS * 1000)),
          lt(pageViews.createdAt, startIso),
        ),
      ),
  ]);

  const annotations = await loadAsnAnnotations(
    db,
    rows.map((r) => r.cfAsn).filter((a): a is number => a !== null),
  );
  const networkClassByAsn = new Map(
    [...annotations.values()].map((a) => [a.asn, a.network_class] as const),
  );
  const ctx: ClassifierContext = {
    swarmUaHashes: new Set(swarm.uaCandidates.map((c) => c.userAgentHash)),
    rotatorAsns: new Set(swarm.asnCandidates.map((c) => c.cfAsn)),
    networkClassByAsn,
    internalRowIds: new Set(internalRows.map((r) => r.id)),
    spaFollowupRowIds: findSpaFollowups([...rows, ...hops]),
    crawlShapeRowIds: findCrawlShapeRows(rows, crawlWindows),
    burstRowIds: findBurstRows(rows, burstTail),
  };
  return {
    day,
    rows,
    ctx,
    networkClassByAsn,
    swarm,
    coverage,
    evidence: windows.rows,
    crawlWindows,
  };
}

export interface DayReport {
  day: string;
  rows: number;
  classCounts: ClassCounts;
  internal: number;
  /** Unresolved rows among the non-internal ones. The D19 count. */
  unresolved: number;
  /** `unresolved / non-internal rows`. Null on an empty day. */
  unresolvedShare: number | null;
  evidenceIncomplete: number;
  arrivalCoverage: ArrivalCfCoverage;
  /** Arrival coverage under `ARRIVAL_CF_COVERAGE_MIN`: the day lacks its network (D19(g)). */
  degraded: boolean;
  swarmTruncated: boolean;
  currentCounts: Record<CurrentVerdict, number>;
  digest: { humanRaw: number; flagged: number; humanAfterAutomation: number };
  /** The runner's `HUMAN` count equals the digest's headline for the day. */
  reproducesDigest: boolean;
}

export interface ShadowResult {
  days: DayReport[];
  confusion: Record<CurrentVerdict, ClassCounts>;
  slices: SliceMetrics[];
  reasonCodeCounts: Record<ReasonCode, number>;
  botLabels: { botName: string; rows: number; classCounts: ClassCounts }[];
  cfVerifiedBotCategories: { category: string; rows: number }[];
  sharedProxyCandidates: (SharedProxyCandidate & { day: string })[];
  labelledSessions: (LabelSession & { matchedRows: number; matchedPrivacyRows: number })[];
  familyMoves: FamilyMove[];
  newFamilyClients: NewFamilyClient[];
  crawlReach: CrawlReach & { perDay: (CrawlReach & { day: string })[] };
  crawlExclusionPairs: CrawlExclusionPair[];
  crawlVetoedPairs: CrawlVetoedPair[];
  /** AECI-1584. Hash-level rule candidates, measured beside the running classifier. */
  candidates: CandidateReport;
  /**
   * AECI-1659. The coordinated-identities candidate, overlaid on the running
   * classifier. `slices` and `moves` are the §3c metrics under the overlay, with
   * the running classifier's class as the baseline.
   */
  coordinated: CoordinatedReport & { slices: SliceMetrics[]; moves: FamilyMove[] };
}

function sumReach(days: readonly CrawlReach[]): CrawlReach {
  const total: CrawlReach = { population: 0, dayOnly: 0, trailingOnly: 0, both: 0, neither: 0 };
  for (const d of days) {
    total.population += d.population;
    total.dayOnly += d.dayOnly;
    total.trailingOnly += d.trailingOnly;
    total.both += d.both;
    total.neither += d.neither;
  }
  return total;
}

/** Classify every row of every reported day already loaded into `db`. */
export async function runShadow(
  db: Db,
  opts: { fromDay: string; toDay: string; labels: LabelsFile },
): Promise<ShadowResult> {
  const heldOut = new Set(opts.labels.heldOutDays);
  const outcomes: ShadowRowOutcome[] = [];
  const days: DayReport[] = [];
  const confusion = Object.fromEntries(
    CURRENT_VERDICTS.map((v) => [v, zeroClassCounts()]),
  ) as Record<CurrentVerdict, ClassCounts>;
  const reasonCodeCounts = Object.fromEntries(REASON_CODES.map((c) => [c, 0])) as Record<
    ReasonCode,
    number
  >;
  const botLabels = new Map<string, ClassCounts>();
  const categories = new Map<string, number>();
  const sharedProxyCandidates: ShadowResult['sharedProxyCandidates'] = [];
  const sessionMatches = new Map<LabelSession, number>();
  const sessionPrivacyMatches = new Map<LabelSession, number>();
  const newFamilyClients = new Map<string, NewFamilyClient>();
  const reachPerDay: (CrawlReach & { day: string })[] = [];
  const crawlExclusionPairs: CrawlExclusionPair[] = [];
  const crawlVetoedPairs: CrawlVetoedPair[] = [];
  const candidates = new CandidateCollector();
  const coordinated = new CoordinatedCollector();
  const coordinatedOutcomes: ShadowRowOutcome[] = [];

  for (const day of daysBetween(opts.fromDay, opts.toDay)) {
    const { rows, ctx, networkClassByAsn, swarm, coverage, crawlWindows } =
      await buildClassificationDay(db, day);
    candidates.addDay(day, await readHashWindows(db, day), heldOut.has(day));
    const internalIds = new Set(ctx.internalRowIds);
    for (const r of rows) if (r.isOperator === true) internalIds.add(r.id);
    coordinated.addDay(
      day,
      findCoordinatedGroups(rows, (r) => internalIds.has(r.id)),
      heldOut.has(day),
      networkClassByAsn,
    );
    const reach: CrawlReach = { population: 0, dayOnly: 0, trailingOnly: 0, both: 0, neither: 0 };
    const exclusions = new Map<string, CrawlExclusionPair>();
    const windowByPair = new Map(crawlWindows.map((w) => [`${w.userAgentHash}|${w.cfAsn}`, w]));
    for (const w of crawlWindows) {
      const test = crawlTestOf(w);
      if (test === null || w.verifiedHops === 0 || w.dayArrivals === 0) continue;
      crawlVetoedPairs.push({
        day,
        userAgentHash: w.userAgentHash,
        cfAsn: w.cfAsn,
        test,
        dayArrivals: w.dayArrivals,
        dayDistinctPaths: w.dayDistinctPaths,
        windowArrivals: w.arrivals,
        distinctPaths: w.distinctPaths,
        verifiedHops: w.verifiedHops,
      });
    }
    const proxies = findSharedProxyCandidates(rows, networkClassByAsn);
    const baselineCtx: ClassifierContext = {
      ...ctx,
      crawlShapeRowIds: new Set(),
      burstRowIds: new Set(),
    };
    for (const c of proxies.candidates) sharedProxyCandidates.push({ ...c, day });

    const classCounts = zeroClassCounts();
    const currentCounts = Object.fromEntries(CURRENT_VERDICTS.map((v) => [v, 0])) as Record<
      CurrentVerdict,
      number
    >;
    let internal = 0;
    let unresolved = 0;
    let evidenceIncomplete = 0;

    for (const row of rows) {
      const result = classifyPageView(row, ctx);
      const baseline = classifyPageView(row, baselineCtx);
      const pairKey = `${row.userAgentHash}|${row.cfAsn}`;
      const crawlWindow = windowByPair.get(pairKey);
      const crawlTest =
        crawlWindow && ctx.crawlShapeRowIds.has(row.id) ? crawlTestOf(crawlWindow) : null;
      if (
        baseline.reasonCodes.includes('single_signal_network') &&
        row.userAgentHash !== null &&
        row.cfAsn !== null
      ) {
        reach.population += 1;
        if (crawlTest) reach[crawlTest] += 1;
        else reach.neither += 1;
      }
      if (
        crawlWindow &&
        crawlTest &&
        AUTOMATION_CLASSES.has(result.class) &&
        !AUTOMATION_CLASSES.has(baseline.class)
      ) {
        const pair = exclusions.get(pairKey) ?? {
          day,
          userAgentHash: crawlWindow.userAgentHash,
          cfAsn: crawlWindow.cfAsn,
          test: crawlTest,
          dayViews: 0,
          windowArrivals: crawlWindow.arrivals,
          distinctPaths: crawlWindow.distinctPaths,
          activeDays: crawlWindow.activeDays,
          referredViews: 0,
        };
        pair.dayViews += 1;
        if (referralCodes(row).length > 0) pair.referredViews += 1;
        exclusions.set(pairKey, pair);
      }
      const crawlShape = result.reasonCodes.includes('crawl_shape_member');
      const burst = result.reasonCodes.includes('burst_member');
      if (crawlShape || burst) {
        const key = JSON.stringify([day, row.userAgentHash, row.cfAsn]);
        const client = newFamilyClients.get(key) ?? {
          day,
          userAgentHash: row.userAgentHash,
          cfAsn: row.cfAsn,
          views: 0,
          crawlShapeViews: 0,
          burstViews: 0,
          classCounts: zeroClassCounts(),
        };
        client.views += 1;
        if (crawlShape) client.crawlShapeViews += 1;
        if (burst) client.burstViews += 1;
        client.classCounts[result.class] += 1;
        newFamilyClients.set(key, client);
      }
      const flagged =
        (row.userAgentHash !== null && ctx.swarmUaHashes.has(row.userAgentHash)) ||
        (row.cfAsn !== null && ctx.rotatorAsns.has(row.cfAsn)) ||
        (NON_BROWSER_VERDICTS as readonly string[]).includes(row.clientVerdict ?? '');
      const current: CurrentVerdict = result.internal
        ? 'internal'
        : row.isBot === true
          ? 'BOT'
          : flagged
            ? 'automation_flagged'
            : 'HUMAN';

      const session = matchLabelledSession(row, opts.labels.sessions);
      if (session) {
        sessionMatches.set(session, (sessionMatches.get(session) ?? 0) + 1);
        if (row.privacySignal === true) {
          sessionPrivacyMatches.set(session, (sessionPrivacyMatches.get(session) ?? 0) + 1);
        }
      }
      const slice: ShadowSlice = session
        ? session.slice
        : isEdgeVerified(row) || isNamedBotLabel(row.botName)
          ? 'known_bot'
          : row.privacySignal === true
            ? 'privacy_unlabelled'
            : proxies.rowIds.has(row.id)
              ? 'shared_proxy_candidate'
              : 'unknown';
      candidates.addRow({ day, row, result, slice, labelled: SLICE_TRUTH[slice] === 'human' });

      const outcome: ShadowRowOutcome = {
        day,
        slice,
        heldOut: heldOut.has(day),
        current,
        currentAutomation: row.isBot === true || flagged,
        class: result.class,
        baselineClass: baseline.class,
        internal: result.internal,
      };
      outcomes.push(outcome);
      // AECI-1659. The overlay never touches the counts below, so the digest
      // comparison and every existing section read the running classifier alone.
      coordinatedOutcomes.push({
        ...outcome,
        class: coordinated.addRow(row, result),
        baselineClass: result.class,
      });

      classCounts[result.class] += 1;
      currentCounts[current] += 1;
      confusion[current][result.class] += 1;
      for (const code of result.reasonCodes) reasonCodeCounts[code] += 1;
      if (result.internal) internal += 1;
      else if (result.class === 'unresolved') unresolved += 1;
      if (!result.evidenceComplete) evidenceIncomplete += 1;
      if (row.botName) {
        const counts = botLabels.get(row.botName) ?? zeroClassCounts();
        counts[result.class] += 1;
        botLabels.set(row.botName, counts);
      }
      if (row.cfVerifiedBotCategory) {
        categories.set(
          row.cfVerifiedBotCategory,
          (categories.get(row.cfVerifiedBotCategory) ?? 0) + 1,
        );
      }
    }

    reachPerDay.push({ day, ...reach });
    crawlExclusionPairs.push(...exclusions.values());

    const humanAfterAutomation = swarm.totalHumanViews - swarm.flaggedViews;
    days.push({
      day,
      rows: rows.length,
      classCounts,
      internal,
      unresolved,
      unresolvedShare: share(unresolved, rows.length - internal),
      evidenceIncomplete,
      arrivalCoverage: coverage,
      degraded: coverage.coverage < ARRIVAL_CF_COVERAGE_MIN,
      swarmTruncated: swarm.truncated,
      currentCounts,
      digest: {
        humanRaw: swarm.totalHumanViews,
        flagged: swarm.flaggedViews,
        humanAfterAutomation,
      },
      reproducesDigest: currentCounts.HUMAN === humanAfterAutomation,
    });
  }

  const slices: SliceMetrics[] = [];
  for (const slice of SHADOW_SLICES) {
    for (const partition of ['all', 'tuning', 'held_out'] as const) {
      slices.push(sliceMetrics(outcomes, slice, partition));
    }
  }

  const coordinatedSlices: SliceMetrics[] = [];
  for (const slice of SHADOW_SLICES) {
    for (const partition of ['all', 'tuning', 'held_out'] as const) {
      coordinatedSlices.push(sliceMetrics(coordinatedOutcomes, slice, partition));
    }
  }

  const reportWindow = evidenceWindows(opts.fromDay, opts.toDay);
  const hopDays = await readVerifiedHopDays(db, reportWindow.rows.from, reportWindow.rows.to);

  return {
    days,
    confusion,
    slices,
    reasonCodeCounts,
    botLabels: [...botLabels.entries()]
      .map(([botName, classCounts]) => ({
        botName,
        rows: Object.values(classCounts).reduce((a, b) => a + b, 0),
        classCounts,
      }))
      .sort((a, b) => b.rows - a.rows || compareText(a.botName, b.botName)),
    cfVerifiedBotCategories: [...categories.entries()]
      .map(([category, rows]) => ({ category, rows }))
      .sort((a, b) => b.rows - a.rows || compareText(a.category, b.category)),
    sharedProxyCandidates,
    labelledSessions: opts.labels.sessions.map((s) => ({
      ...s,
      matchedRows: sessionMatches.get(s) ?? 0,
      matchedPrivacyRows: sessionPrivacyMatches.get(s) ?? 0,
    })),
    familyMoves: familyMoves(outcomes),
    newFamilyClients: [...newFamilyClients.values()].sort(
      (a, b) => b.views - a.views || compareText(a.day, b.day),
    ),
    crawlReach: {
      ...sumReach(reachPerDay),
      perDay: reachPerDay,
    },
    crawlExclusionPairs: crawlExclusionPairs.sort(
      (a, b) => a.windowArrivals - b.windowArrivals || compareText(a.day, b.day),
    ),
    crawlVetoedPairs: crawlVetoedPairs.sort(
      (a, b) =>
        a.verifiedHops - b.verifiedHops ||
        b.dayArrivals - a.dayArrivals ||
        compareText(a.day, b.day),
    ),
    candidates: candidates.finish(hopDays),
    coordinated: {
      ...coordinated.finish(),
      slices: coordinatedSlices,
      moves: familyMoves(coordinatedOutcomes),
    },
  };
}

// ─── Report ─────────────────────────────────────────────────────────────────

export interface ShadowMeta {
  classifierVersion: string;
  fingerprint: string;
  gitSha: string;
  generatedAt: string;
  target: string;
  window: { fromDay: string; toDay: string };
  evidenceWindows: ReturnType<typeof evidenceWindows>;
  pulled: { pageViews: number; asnRegistry: number };
  labelsPath: string | null;
  heldOutDays: string[];
  ruleInputs: unknown;
}

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function table(head: readonly string[], body: readonly (readonly (string | number)[])[]): string {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

/** The §3c step 3 table: the three numbers together, per slice and partition. */
function sliceTable(slices: readonly SliceMetrics[]): string {
  return table(
    [
      'Slice',
      'Partition',
      'Rows',
      'False exclusions (new / current)',
      'Missed automation (new / current)',
      'Unresolved share',
    ],
    slices
      .filter((s) => s.rows > 0 || s.partition === 'all')
      .map((s) => [
        s.slice,
        s.partition,
        s.rows,
        s.falseExclusions
          ? `${s.falseExclusions.new} (${pct(s.falseExclusions.newShare)}) / ${s.falseExclusions.current}`
          : 'n/a',
        s.missedAutomation
          ? `${s.missedAutomation.new} (${pct(s.missedAutomation.newShare)}) / ${s.missedAutomation.current}`
          : 'n/a',
        pct(s.unresolvedShare),
      ]),
  );
}

/** The Markdown half of the report. The JSON half is `{ meta, ...result }`. */
export function renderShadowMarkdown(meta: ShadowMeta, result: ShadowResult): string {
  const out: string[] = [];
  out.push(`# Traffic classification shadow run (AECI-872)`);
  out.push('');
  out.push('Report-only. Nothing in this run wrote to any D1 or changed a reported number.');
  out.push('');
  out.push(
    table(
      ['Field', 'Value'],
      [
        ['Classifier version', `\`${meta.classifierVersion}\``],
        ['Fingerprint', `\`${meta.fingerprint}\``],
        ['Git SHA', `\`${meta.gitSha}\``],
        ['Generated', meta.generatedAt],
        ['Target', meta.target],
        ['Reported days', `${meta.window.fromDay} to ${meta.window.toDay}`],
        [
          'Rows pulled from',
          `${meta.evidenceWindows.rows.from} to ${meta.evidenceWindows.rows.to}`,
        ],
        [
          'Operator anchors from',
          `${meta.evidenceWindows.operatorAnchors.from} to ${meta.evidenceWindows.operatorAnchors.to}`,
        ],
        ['Rows loaded', `${meta.pulled.pageViews} page views, ${meta.pulled.asnRegistry} ASNs`],
        ['Labels file', meta.labelsPath ?? '(none)'],
        ['Held-out days', meta.heldOutDays.join(', ') || '(none)'],
      ],
    ),
  );
  out.push('');
  out.push('The full rule inputs are in the JSON report under `meta.ruleInputs`.');

  out.push('', '## Per day', '');
  out.push(
    table(
      [
        'Day',
        'Rows',
        ...TRAFFIC_CLASSES,
        'Internal',
        'Unresolved share',
        'Evidence incomplete',
        'Arrival coverage',
        'Degraded',
        'Digest human',
        'Reproduces digest',
      ],
      result.days.map((d) => [
        d.day,
        d.rows,
        ...TRAFFIC_CLASSES.map((c) => d.classCounts[c]),
        d.internal,
        pct(d.unresolvedShare),
        d.evidenceIncomplete,
        `${pct(d.arrivalCoverage.coverage)} of ${d.arrivalCoverage.arrivals}`,
        d.degraded ? 'yes' : 'no',
        d.digest.humanAfterAutomation,
        d.reproducesDigest ? 'yes' : `NO (${d.currentCounts.HUMAN})`,
      ]),
    ),
  );

  out.push('', '## Current verdict by new class', '');
  out.push(
    table(
      ['Current', ...TRAFFIC_CLASSES],
      CURRENT_VERDICTS.map((v) => [v, ...TRAFFIC_CLASSES.map((c) => result.confusion[v][c])]),
    ),
  );

  out.push('', '## Slice metrics (§3c step 3)', '');
  out.push(sliceTable(result.slices));

  out.push('', '## Moved by the crawl-shape and burst families', '');
  out.push(
    'Each row classified twice, with the two families on and off. Only rows whose class changed.',
    '',
  );
  out.push(
    result.familyMoves.length === 0
      ? 'None.'
      : table(
          ['Slice', 'Partition', 'From', 'To', 'Rows'],
          result.familyMoves.map((m) => [m.slice, m.partition, m.from, m.to, m.rows]),
        ),
  );

  out.push('', '## Crawl shape: day test beside the trailing test', '');
  out.push(
    'Views the baseline left in `single_signal_network`, with a hash and an ASN. "Day test only" is reach the trailing window would lose, when repeat visits pull its distinct-path ratio under the floor. "Trailing test only" is reach no single day would have.',
    '',
  );
  const reachRow = (label: string, r: CrawlReach) => [
    label,
    r.population,
    r.dayOnly,
    r.trailingOnly,
    r.both,
    r.neither,
  ];
  out.push(
    table(
      ['Day', 'Population', 'Day test only', 'Trailing test only', 'Both', 'Neither'],
      [
        ...result.crawlReach.perDay.map((d) => reachRow(d.day, d)),
        reachRow('Total', result.crawlReach),
      ],
    ),
  );

  out.push(
    '',
    `## False-exclusion review: pairs crawl shape moved to automation (top 50 of ${result.crawlExclusionPairs.length})`,
    '',
  );
  out.push(
    'A real person on a VPN who loads many different pages and never navigates inside the app looks like this. Lowest window volume first. No rule here can tell the two apart, so this needs a human read.',
    '',
  );
  out.push(
    result.crawlExclusionPairs.length === 0
      ? 'None.'
      : table(
          [
            'Day',
            'UA hash',
            'ASN',
            'Test',
            'Day views',
            'Window arrivals',
            'Distinct paths',
            'Active days',
            'Referred views',
          ],
          result.crawlExclusionPairs
            .slice(0, 50)
            .map((p) => [
              p.day,
              `\`${p.userAgentHash.slice(0, 8)}\``,
              p.cfAsn,
              CRAWL_TEST_LABEL[p.test],
              p.dayViews,
              p.windowArrivals,
              p.distinctPaths,
              p.activeDays,
              p.referredViews,
            ]),
        ),
  );

  const vetoed = result.crawlVetoedPairs;
  out.push('', `## Crawl shape: pairs the hop veto stopped (top 50 of ${vetoed.length})`, '');
  out.push(
    `One browser-verified hop stops both tests for the whole pair, so a person on a shared pair can hide a crawler. Fewest hops first, then most arrivals. ${vetoed.filter((p) => p.verifiedHops === 1).length} pair-days had exactly one hop. Together the listed pair-days kept ${vetoed.reduce((n, p) => n + p.dayArrivals, 0)} arrivals from the signal. Many arrivals behind few hops is the shape to read.`,
    '',
  );
  out.push(
    vetoed.length === 0
      ? 'None.'
      : table(
          [
            'Day',
            'UA hash',
            'ASN',
            'Test',
            'Verified hops',
            'Day arrivals',
            'Day distinct paths',
            'Window arrivals',
            'Distinct paths',
          ],
          vetoed
            .slice(0, 50)
            .map((p) => [
              p.day,
              `\`${p.userAgentHash.slice(0, 8)}\``,
              p.cfAsn,
              CRAWL_TEST_LABEL[p.test],
              p.verifiedHops,
              p.dayArrivals,
              p.dayDistinctPaths,
              p.windowArrivals,
              p.distinctPaths,
            ]),
        ),
  );

  out.push(
    '',
    `## Clients carrying a new family (top 50 of ${result.newFamilyClients.length})`,
    '',
  );
  out.push(
    result.newFamilyClients.length === 0
      ? 'None.'
      : table(
          ['Day', 'UA hash', 'ASN', 'Views', 'Crawl shape', 'Burst', ...TRAFFIC_CLASSES],
          result.newFamilyClients
            .slice(0, 50)
            .map((c) => [
              c.day,
              c.userAgentHash === null ? '(null)' : `\`${c.userAgentHash.slice(0, 8)}\``,
              c.cfAsn ?? '(null)',
              c.views,
              c.crawlShapeViews,
              c.burstViews,
              ...TRAFFIC_CLASSES.map((k) => c.classCounts[k]),
            ]),
        ),
  );

  out.push(...renderCandidateMarkdown(result.candidates));

  out.push(...renderCoordinatedMarkdown(result.coordinated));
  out.push('', '### Slice metrics with the coordinated family (§3c step 3)', '');
  out.push(sliceTable(result.coordinated.slices));
  out.push('', '### Moved by the coordinated family', '');
  out.push('Baseline is the running classifier. Only rows whose class changed.', '');
  out.push(
    result.coordinated.moves.length === 0
      ? 'None.'
      : table(
          ['Slice', 'Partition', 'From', 'To', 'Rows'],
          result.coordinated.moves.map((m) => [m.slice, m.partition, m.from, m.to, m.rows]),
        ),
  );

  out.push('', '## Labelled sessions', '');
  out.push(
    result.labelledSessions.length === 0
      ? 'No labelled sessions in the labels file.'
      : table(
          ['Slice', 'Browser', 'Start', 'End', 'ASN', 'Matched rows', 'Of which privacy rows'],
          result.labelledSessions.map((s) => [
            s.slice,
            s.browser,
            s.startUtc,
            s.endUtc,
            s.cfAsn ?? '(none)',
            s.matchedRows,
            s.matchedPrivacyRows,
          ]),
        ),
  );

  out.push('', '## Reason codes', '');
  out.push(
    table(
      ['Code', 'Rows'],
      REASON_CODES.filter((c) => result.reasonCodeCounts[c] > 0).map((c) => [
        `\`${c}\``,
        result.reasonCodeCounts[c],
      ]),
    ),
  );

  out.push('', '## Stored bot labels by new class', '');
  out.push(
    table(
      ['bot_name', 'Rows', ...TRAFFIC_CLASSES],
      result.botLabels.map((b) => [
        b.botName,
        b.rows,
        ...TRAFFIC_CLASSES.map((c) => b.classCounts[c]),
      ]),
    ),
  );

  out.push('', '## Cloudflare verified-bot categories seen', '');
  out.push(
    result.cfVerifiedBotCategories.length === 0
      ? 'None. No row in the window carried `cf_verified_bot_category`.'
      : table(
          ['Category', 'Rows'],
          result.cfVerifiedBotCategories.map((c) => [c.category, c.rows]),
        ),
  );

  out.push(
    '',
    `## Shared-proxy candidates for review (top 50 of ${result.sharedProxyCandidates.length})`,
    '',
  );
  out.push(
    result.sharedProxyCandidates.length === 0
      ? 'None.'
      : table(
          ['Day', 'Hour (UTC)', 'ASN', 'Distinct UA hashes', 'Views'],
          [...result.sharedProxyCandidates]
            .sort((a, b) => b.distinctUaHashes - a.distinctUaHashes || compareText(a.hour, b.hour))
            .slice(0, 50)
            .map((c) => [c.day, c.hour, c.cfAsn, c.distinctUaHashes, c.views]),
        ),
  );
  out.push('');
  return out.join('\n');
}
