/**
 * The versioned, evidence-preserving traffic classifier (AECI-872 /
 * `ADMIN_PANEL_SPEC.md` §13 D19).
 *
 * ─── What this is ───────────────────────────────────────────────────────────
 *
 * One pure function, {@link classifyPageView}, that places a stored `page_views`
 * row in one of four reporting classes and says why. It reads only what the row
 * already holds plus a few per-window facts the caller computes once
 * ({@link ClassifierContext}). It touches no binding, issues no query and reads no clock. That is what lets
 * the offline shadow runner (`scripts/traffic-classification-shadow.ts`) and the
 * later Phase 2 cron writer (AECI-1345) share it byte for byte.
 *
 * ─── What this is NOT ───────────────────────────────────────────────────────
 *
 * It is **report-only**. Nothing here writes `is_bot`, and no ASN joins
 * `DATACENTER_ASNS` on its evidence (D14, D19(h)). Phase 1 changes no reported
 * number: the shadow runner prints its classes beside the current verdict and
 * the cut-over is Chris's decision (`POST_LAUNCH_MONITORING.md` §3c).
 *
 * ─── Precedence, first match wins ───────────────────────────────────────────
 *
 *   1. identified_automation — the edge verified the bot, or the stored
 *      `bot_name` is a crawler the UA named. A claim, not an inference.
 *   2. suspected_automation — automation signals from at least
 *      {@link SUSPECTED_MIN_SIGNAL_FAMILIES} DIFFERENT families. Network ownership
 *      is one family however many network facts agree (D19(b)).
 *   3. browser_with_human_evidence — our app was observed executing, and no
 *      automation signal or stored bot verdict contradicts it.
 *   4. unresolved — everything else, always with at least one reason code.
 *
 * Internal traffic is a FLAG beside the class, never a class (D19(b)). The class
 * is computed for internal rows too, so the operator slice can measure false
 * exclusions.
 *
 * ─── Versioning ─────────────────────────────────────────────────────────────
 *
 * {@link TRAFFIC_CLASSIFIER_VERSION} names the rules. {@link classifierFingerprint}
 * hashes every rule input. `traffic-classifier.spec.ts` pins both as literals, so
 * editing any input without bumping the version fails the spec. A version is
 * recorded on every classification, and days under two versions are flagged,
 * never blended (D19(c)).
 */

import { UNTRACKED_ROUTE_PREFIXES } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { networkClassEntries, type AsnNetworkClass } from './asn-registry';
import {
  datacenterAsnEntries,
  GENERIC_BOT_LABEL,
  genericBotRule,
  namedBotEntries,
} from './bot-classification';
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

/**
 * The rules' name. Bump it on ANY change to a rule input, including a constant in
 * `swarm-detection.ts`, a `DATACENTER_ASNS` entry or a `NAMED_BOTS` pattern. The
 * spec's pin tells you when.
 */
export const TRAFFIC_CLASSIFIER_VERSION = 'tc-2026.10.2';

/** The four D19(b) reporting classes, in precedence order. Stable: stored later. */
export const TRAFFIC_CLASSES = [
  'identified_automation',
  'suspected_automation',
  'browser_with_human_evidence',
  'unresolved',
] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];

/**
 * Every reason code the classifier can emit. Short and STABLE: Phase 2 stores them
 * and they are compared across versions months later, so renaming one is a data
 * migration, not a refactor. Ordered by group; a row's codes come back in this
 * order so two runs compare as strings.
 */
export const REASON_CODES = [
  // identified_automation: how the bot is known.
  'verified_edge',
  'ua_self_declared',
  'ua_generic_token',
  // identified_automation: what it is for. Exactly one per identified row.
  'purpose_indexing',
  'purpose_ai_training',
  'purpose_assistant_retrieval',
  'purpose_preview',
  'purpose_monitoring',
  'purpose_unknown',
  // Automation signals. Each belongs to one family in SIGNAL_FAMILIES.
  'asn_datacenter',
  'asn_non_eyeball',
  'verdict_non_browser',
  'verdict_inconsistent',
  'swarm_member',
  'asn_rotator_member',
  // Human evidence.
  'app_executed',
  'spa_followup',
  'search_referred',
  'referred_external',
  // Why a row is unresolved.
  'no_corroboration',
  'conflicting_signals',
  'bot_label_unmapped',
  'single_signal_network',
  'single_signal_request_shape',
  'single_signal_swarm',
  'single_signal_rotator',
  // Evidence the row lacks. Attached to any class; drives evidenceComplete.
  'evidence_no_asn',
  'evidence_no_tls',
  'evidence_pre_provenance',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** A crawler's purpose, as the D19(b) table splits identified automation. */
export type CrawlerPurpose =
  | 'purpose_indexing'
  | 'purpose_ai_training'
  | 'purpose_assistant_retrieval'
  | 'purpose_preview'
  | 'purpose_monitoring'
  | 'purpose_unknown';

/**
 * Stored `bot_name` label → purpose. A label that merges purposes gets
 * `purpose_unknown`, never the likelier guess: `OpenAI` covers OAI-SearchBot and
 * ChatGPT-User, `PerplexityBot` covers Perplexity-User, `Meta` covers a training
 * agent and a link previewer. Splitting them needs the UA at ingest (AECI-762).
 * Any label missing here is `purpose_unknown`.
 */
export const BOT_PURPOSE_BY_LABEL: Readonly<Record<string, CrawlerPurpose>> = {
  Googlebot: 'purpose_indexing',
  Bingbot: 'purpose_indexing',
  Applebot: 'purpose_indexing',
  DuckDuckBot: 'purpose_indexing',
  YandexBot: 'purpose_indexing',
  Baiduspider: 'purpose_indexing',
  PetalBot: 'purpose_indexing',
  AhrefsBot: 'purpose_indexing',
  SemrushBot: 'purpose_indexing',
  MJ12bot: 'purpose_indexing',
  DotBot: 'purpose_indexing',
  DataForSeoBot: 'purpose_indexing',
  'GPTBot (OpenAI)': 'purpose_ai_training',
  'Bytespider (ByteDance)': 'purpose_ai_training',
  OpenAI: 'purpose_unknown',
  'ClaudeBot (Anthropic)': 'purpose_unknown',
  PerplexityBot: 'purpose_unknown',
  Amazonbot: 'purpose_unknown',
  Meta: 'purpose_unknown',
  'Censys (scanner)': 'purpose_unknown',
  'Uptime monitor': 'purpose_monitoring',
  [GENERIC_BOT_LABEL]: 'purpose_unknown',
};

/**
 * Cloudflare `verifiedBotCategory` → purpose, matched case-insensitively. Used
 * only when the edge verified the bot, and preferred over the label because it is
 * a check rather than a claim. `cf_verified_bot_category` had no reader before
 * this, so the shadow report lists the values it actually saw.
 */
export const BOT_PURPOSE_BY_CF_CATEGORY: Readonly<Record<string, CrawlerPurpose>> = {
  'search engine crawler': 'purpose_indexing',
  'search engine optimization': 'purpose_indexing',
  'ai search': 'purpose_indexing',
  'ai crawler': 'purpose_ai_training',
  'ai assistant': 'purpose_assistant_retrieval',
  'page preview': 'purpose_preview',
  'monitoring & analytics': 'purpose_monitoring',
};

/** `referrer_source` values that are search engines (`referrer-classification.ts`). */
export const SEARCH_REFERRER_SOURCES = [
  'Google',
  'Bing',
  'DuckDuckGo',
  'Yahoo',
  'Ecosia',
  'Brave Search',
  'Yandex',
  'Baidu',
] as const;

/**
 * How long after an arrival a `browser-spa` hop on the same
 * `(user_agent_hash, cf_asn)` pair still counts as that arrival's app executing.
 */
export const SPA_FOLLOWUP_WINDOW_MINUTES = 30;

/**
 * Automation signals grouped by what they observe. Suspected automation needs
 * signals from {@link SUSPECTED_MIN_SIGNAL_FAMILIES} families, so two network facts
 * about one ASN never add up to two signals (D19(b): network ownership alone never
 * settles identity).
 */
export const SIGNAL_FAMILIES = {
  network: ['asn_datacenter', 'asn_non_eyeball'],
  request_shape: ['verdict_non_browser', 'verdict_inconsistent'],
  swarm: ['swarm_member'],
  rotator: ['asn_rotator_member'],
} as const satisfies Record<string, readonly ReasonCode[]>;
type SignalFamily = keyof typeof SIGNAL_FAMILIES;

/** Distinct signal families needed for `suspected_automation`. */
export const SUSPECTED_MIN_SIGNAL_FAMILIES = 2;

const SINGLE_SIGNAL_CODE: Readonly<Record<SignalFamily, ReasonCode>> = {
  network: 'single_signal_network',
  request_shape: 'single_signal_request_shape',
  swarm: 'single_signal_swarm',
  rotator: 'single_signal_rotator',
};

/**
 * The precedence table as data, so it is part of the fingerprint. The fingerprint
 * hashes data, not code: a change to the branching in {@link classifyPageView}
 * must also change this text, or the pin cannot see it.
 */
export const CLASS_PRECEDENCE = [
  [
    'identified_automation',
    'verified_edge (cf_verified_bot = true, or any non-null cf_verified_bot_category) | ua_self_declared (not when the ASN rule could have written the label) | ua_generic_token',
  ],
  ['suspected_automation', `signal families >= ${SUSPECTED_MIN_SIGNAL_FAMILIES}`],
  ['browser_with_human_evidence', 'app_executed and no automation signal or stored bot verdict'],
  ['unresolved', 'otherwise; always carries a code'],
] as const;

/**
 * The stored `page_views` columns the classifier reads. The raw UA is never
 * stored, so a crawler is known by its `bot_name` label.
 */
export interface ClassifierRow {
  id: number;
  createdAt: string;
  navigation: string | null;
  writerProvenance: string | null;
  clientVerdict: string | null;
  isBot: boolean | null;
  botName: string | null;
  cfAsn: number | null;
  cfVerifiedBot: boolean | null;
  cfVerifiedBotCategory: string | null;
  hasSecChUa: boolean | null;
  hasAcceptLanguage: boolean | null;
  secFetchDest: string | null;
  tlsVersion: string | null;
  referrerSource: string | null;
  isOperator: boolean | null;
  userAgentHash: string | null;
}

/**
 * Per-window facts the caller computes once and hands to every row. Each comes
 * from existing code, never a re-derivation: swarm and rotator membership from
 * `detectSwarms`, network class from `networkClassOf` over `asn_registry`,
 * internal ids from `NOT_INTERNAL`, follow-ups from {@link findSpaFollowups}.
 */
export interface ClassifierContext {
  /** `user_agent_hash` values `detectSwarms` flagged for this window. */
  swarmUaHashes: ReadonlySet<string>;
  /** `cf_asn` values `detectSwarms` flagged as user-agent rotators. */
  rotatorAsns: ReadonlySet<number>;
  /** `asn_registry` network class per ASN. Absent = unknown to the registry. */
  networkClassByAsn: ReadonlyMap<number, AsnNetworkClass>;
  /** Row ids `NOT_INTERNAL` excludes. `is_operator` is also read off the row. */
  internalRowIds: ReadonlySet<number>;
  /** Arrival ids whose pair had a browser-verified SPA hop soon after. */
  spaFollowupRowIds: ReadonlySet<number>;
}

export interface PageViewClassification {
  class: TrafficClass;
  /** In {@link REASON_CODES} order. Never empty: every class carries at least one code. */
  reasonCodes: ReasonCode[];
  /** Excluded by identity (`NOT_INTERNAL`). A flag beside the class, never a class. */
  internal: boolean;
  /** False when the row lacks an input the classifier needs. Never quiet (D19(g)). */
  evidenceComplete: boolean;
  version: string;
}

const NAMED_BOT_LABELS: ReadonlySet<string> = new Set(namedBotEntries().map(([, , l]) => l));
const DATACENTER_ASN_SET: ReadonlySet<number> = new Set(datacenterAsnEntries().map(([a]) => a));
const DATACENTER_LABEL_BY_ASN: ReadonlyMap<number, string> = new Map(datacenterAsnEntries());
const SEARCH_SOURCES: ReadonlySet<string> = new Set(SEARCH_REFERRER_SOURCES);
const REASON_ORDER: ReadonlyMap<ReasonCode, number> = new Map(REASON_CODES.map((c, i) => [c, i]));

/**
 * Whether the stored label could have come from the ASN rule rather than the UA.
 * `Censys (scanner)` is both a `NAMED_BOTS` label and a `DATACENTER_ASNS` label, so
 * on a Censys ASN the label alone cannot say the client declared itself. Such a
 * row is judged on its network signal instead, never as self-declared.
 */
function labelCouldBeFromAsn(row: ClassifierRow): boolean {
  return row.cfAsn !== null && DATACENTER_LABEL_BY_ASN.get(row.cfAsn) === row.botName;
}

/** Whether a stored `bot_name` is one a `NAMED_BOTS` pattern writes. */
export function isNamedBotLabel(label: string | null): boolean {
  return label !== null && NAMED_BOT_LABELS.has(label);
}

function isArrival(row: ClassifierRow): boolean {
  return row.navigation === 'arrival' || row.writerProvenance === 'ssr-arrival';
}

/**
 * Whether Cloudflare verified this bot. Cloudflare sets `verifiedBotCategory` only
 * for verified bots, so a non-null category is verification on its own. Measured
 * 2026-10-14: the category was populated on 2,937 arrivals since 2026-10-01 while
 * `cf_verified_bot` was NULL on every row (AECI-1348 tracks the boolean).
 */
export function isEdgeVerified(
  row: Pick<ClassifierRow, 'cfVerifiedBot' | 'cfVerifiedBotCategory'>,
): boolean {
  return row.cfVerifiedBot === true || Boolean(row.cfVerifiedBotCategory);
}

function purposeOf(row: ClassifierRow): CrawlerPurpose {
  if (isEdgeVerified(row) && row.cfVerifiedBotCategory) {
    const byCategory = BOT_PURPOSE_BY_CF_CATEGORY[row.cfVerifiedBotCategory.toLowerCase()];
    if (byCategory) return byCategory;
  }
  return (row.botName && BOT_PURPOSE_BY_LABEL[row.botName]) || 'purpose_unknown';
}

function evidenceGaps(row: ClassifierRow): ReasonCode[] {
  const gaps: ReasonCode[] = [];
  if (isArrival(row) && row.cfAsn === null) gaps.push('evidence_no_asn');
  if (isArrival(row) && !row.tlsVersion) gaps.push('evidence_no_tls');
  if (row.writerProvenance === null) gaps.push('evidence_pre_provenance');
  return gaps;
}

function automationSignals(row: ClassifierRow, ctx: ClassifierContext): ReasonCode[] {
  const out: ReasonCode[] = [];
  if (row.cfAsn !== null && DATACENTER_ASN_SET.has(row.cfAsn)) out.push('asn_datacenter');
  if (row.cfAsn !== null && ctx.networkClassByAsn.get(row.cfAsn) === 'non_eyeball') {
    out.push('asn_non_eyeball');
  }
  if (row.clientVerdict === 'non-browser') out.push('verdict_non_browser');
  if (row.clientVerdict === 'inconsistent') out.push('verdict_inconsistent');
  if (row.userAgentHash !== null && ctx.swarmUaHashes.has(row.userAgentHash)) {
    out.push('swarm_member');
  }
  if (row.cfAsn !== null && ctx.rotatorAsns.has(row.cfAsn)) out.push('asn_rotator_member');
  return out;
}

function familiesOf(signals: readonly ReasonCode[]): SignalFamily[] {
  return (Object.keys(SIGNAL_FAMILIES) as SignalFamily[]).filter((family) =>
    (SIGNAL_FAMILIES[family] as readonly ReasonCode[]).some((code) => signals.includes(code)),
  );
}

function humanEvidence(row: ClassifierRow, ctx: ClassifierContext): ReasonCode[] {
  const executedHere = row.writerProvenance === 'browser-spa' && row.clientVerdict === 'browser';
  const followedUp = isArrival(row) && ctx.spaFollowupRowIds.has(row.id);
  if (!executedHere && !followedUp) return [];
  const out: ReasonCode[] = ['app_executed'];
  if (followedUp) out.push('spa_followup');
  return out;
}

function referralCodes(row: ClassifierRow): ReasonCode[] {
  const source = row.referrerSource;
  if (!source || source === 'Direct') return [];
  return [SEARCH_SOURCES.has(source) ? 'search_referred' : 'referred_external'];
}

function finish(
  cls: TrafficClass,
  codes: ReasonCode[],
  row: ClassifierRow,
  ctx: ClassifierContext,
  gaps: readonly ReasonCode[],
): PageViewClassification {
  const unique = [...new Set([...codes, ...gaps])];
  unique.sort((a, b) => (REASON_ORDER.get(a) ?? 0) - (REASON_ORDER.get(b) ?? 0));
  return {
    class: cls,
    reasonCodes: unique,
    internal: row.isOperator === true || ctx.internalRowIds.has(row.id),
    evidenceComplete: gaps.length === 0,
    version: TRAFFIC_CLASSIFIER_VERSION,
  };
}

/** Classify one stored page view. Pure; see the module header for precedence. */
export function classifyPageView(
  row: ClassifierRow,
  ctx: ClassifierContext,
): PageViewClassification {
  const gaps = evidenceGaps(row);

  // 1. Identified: the edge checked it, or the UA said so at ingest.
  const identity: ReasonCode[] = [];
  if (isEdgeVerified(row)) identity.push('verified_edge');
  if (row.isBot === true && isNamedBotLabel(row.botName) && !labelCouldBeFromAsn(row)) {
    identity.push('ua_self_declared');
  }
  if (row.isBot === true && row.botName === GENERIC_BOT_LABEL) identity.push('ua_generic_token');
  if (identity.length > 0) {
    return finish('identified_automation', [...identity, purposeOf(row)], row, ctx, gaps);
  }

  const signals = automationSignals(row, ctx);
  const families = familiesOf(signals);

  // 2. Suspected: independent families agree.
  if (families.length >= SUSPECTED_MIN_SIGNAL_FAMILIES) {
    return finish('suspected_automation', signals, row, ctx, gaps);
  }

  // A stored `is_bot` the current rules cannot reproduce: an older label, or a
  // datacenter label whose ASN the row no longer carries. Evidence against a
  // human verdict, but not a signal family of its own.
  const unmappedBot = row.isBot === true && !signals.includes('asn_datacenter');
  const human = humanEvidence(row, ctx);
  const referral = referralCodes(row);

  // 3. Browser with human evidence: the app ran and nothing contradicts it.
  if (human.length > 0 && signals.length === 0 && !unmappedBot) {
    return finish('browser_with_human_evidence', [...human, ...referral], row, ctx, gaps);
  }

  // 4. Unresolved, always with a reason.
  const why: ReasonCode[] = [...signals, ...human, ...referral];
  if (unmappedBot) why.push('bot_label_unmapped');
  if (human.length > 0) {
    why.push('conflicting_signals');
  } else if (families.length === 1) {
    why.push(SINGLE_SIGNAL_CODE[families[0] as SignalFamily]);
  } else if (!unmappedBot) {
    why.push('no_corroboration');
  }
  return finish('unresolved', why, row, ctx, gaps);
}

/** The fields {@link findSpaFollowups} needs from a row. */
export type FollowupRow = Pick<
  ClassifierRow,
  | 'id'
  | 'createdAt'
  | 'navigation'
  | 'writerProvenance'
  | 'clientVerdict'
  | 'cfAsn'
  | 'userAgentHash'
>;

/**
 * Arrival ids whose `(user_agent_hash, cf_asn)` pair produced a browser-verified
 * `browser-spa` hop within {@link SPA_FOLLOWUP_WINDOW_MINUTES} after the arrival.
 * Rows with a NULL hash or ASN never pair: an unknown is not a match.
 *
 * `rows` must reach {@link SPA_FOLLOWUP_WINDOW_MINUTES} past the last arrival, or a
 * late follow-up is missed. The shadow runner pulls that margin.
 */
export function findSpaFollowups(
  rows: readonly FollowupRow[],
  windowMinutes: number = SPA_FOLLOWUP_WINDOW_MINUTES,
): Set<number> {
  const key = (r: FollowupRow) => `${r.userAgentHash}|${r.cfAsn}`;
  const hops = new Map<string, number[]>();
  for (const r of rows) {
    if (r.userAgentHash === null || r.cfAsn === null) continue;
    if (r.writerProvenance !== 'browser-spa' || r.clientVerdict !== 'browser') continue;
    const list = hops.get(key(r)) ?? [];
    list.push(Date.parse(r.createdAt));
    hops.set(key(r), list);
  }
  const windowMs = windowMinutes * 60_000;
  const out = new Set<number>();
  for (const r of rows) {
    if (r.userAgentHash === null || r.cfAsn === null) continue;
    if (r.navigation !== 'arrival' && r.writerProvenance !== 'ssr-arrival') continue;
    const at = Date.parse(r.createdAt);
    if ((hops.get(key(r)) ?? []).some((t) => t >= at && t <= at + windowMs)) out.add(r.id);
  }
  return out;
}

/** JSON with object keys sorted, so the same inputs always hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort(compareText);
    const body = keys.map(
      (k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    );
    return `{${body.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Every rule input, as plain data. Printed in the shadow report header and hashed
 * by {@link classifierFingerprint}. Adding a rule input means adding it here.
 */
export function classifierRuleInputs() {
  return {
    classes: TRAFFIC_CLASSES,
    reasonCodes: REASON_CODES,
    precedence: CLASS_PRECEDENCE,
    signalFamilies: SIGNAL_FAMILIES,
    suspectedMinSignalFamilies: SUSPECTED_MIN_SIGNAL_FAMILIES,
    namedBots: namedBotEntries(),
    genericBot: genericBotRule(),
    datacenterAsns: [...datacenterAsnEntries()].sort((a, b) => a[0] - b[0]),
    networkClassByInfoType: networkClassEntries(),
    nonBrowserVerdicts: NON_BROWSER_VERDICTS,
    swarm: {
      SWARM_MIN_VIEWS,
      SWARM_MIN_ASN_RATIO,
      SWARM_PRIOR_LOOKBACK_DAYS,
      SWARM_PRIOR_MIN_FLAGGED_DAYS,
      SWARM_RECURRING_ASN_RATIO,
      SWARM_RECURRING_MIN_VIEWS,
      ASN_ROTATOR_MIN_VIEWS,
      ASN_ROTATOR_MIN_UA_RATIO,
      SWARM_MAX_CANDIDATES,
    },
    internal: {
      untrackedRoutePrefixes: UNTRACKED_ROUTE_PREFIXES,
      operatorPairLookbackDays: OPERATOR_PAIR_LOOKBACK_DAYS,
    },
    purposeByLabel: BOT_PURPOSE_BY_LABEL,
    purposeByCfCategory: BOT_PURPOSE_BY_CF_CATEGORY,
    searchReferrerSources: SEARCH_REFERRER_SOURCES,
    spaFollowupWindowMinutes: SPA_FOLLOWUP_WINDOW_MINUTES,
  };
}

/** SHA-256 (hex) over the canonical JSON of {@link classifierRuleInputs}. */
export async function classifierFingerprint(): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(classifierRuleInputs()));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
