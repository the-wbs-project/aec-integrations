import type { ProductLink, VendorClaim, VendorIntegration } from '@aeci/shared';

import { compareText } from '@aeci/shared/text-sort';

import { mechanismKindLabel } from '../../search/mechanism-labels';

/**
 * The model behind the Integrations tab's drill-down (AECI-999 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §6.3): how a list of integrations becomes
 * counterpart groups, what "healthy" means for each level, and what the filter
 * bar matches.
 *
 * Pure functions over the wire shape, with no Angular in them, so every rule the
 * collapsed rows advertise is unit-testable without rendering a lane.
 *
 * ── NOTHING HERE RE-DERIVES AGREEMENT ───────────────────────────────────────
 * `claim.agreement` is read verbatim. The contract is that the portal never
 * recomputes `computeAgreement` (the section header in
 * `vendor-integrations-section.ts` explains why the retract path re-reads rather
 * than guessing). Health is a *summary* of the server's states, not a second
 * opinion about them.
 */

/**
 * One claim-level or integration-level health state, most urgent first.
 *
 * - `conflict`  — at least one data point has vendors disagreeing.
 * - `needs_you` — on an attestable edge, at least one data point has no position
 *                 of the vendor's own. The SAME predicate as the overview's
 *                 `waitingByProduct` and the section's summary line.
 * - `responded` — the vendor has a position on every data point, and at least
 *                 one is still short of `confirmed` (usually waiting on the
 *                 other vendor). An owns-both edge settles here for good,
 *                 because `confirmed` needs two DISTINCT vendors.
 * - `confirmed` — every data point is confirmed by both vendors.
 * - `connector` — delivered through a connector, so neither vendor attests; AEC
 *                 Integrations maintains the data flows (AECI-705).
 * - `empty`     — no data points on record.
 */
export type IntegrationHealth =
  | 'conflict'
  | 'needs_you'
  | 'responded'
  | 'confirmed'
  | 'connector'
  | 'empty';

/** Urgency order, used both to roll a group up and to order the filter chips. */
export const HEALTH_ORDER: readonly IntegrationHealth[] = [
  'conflict',
  'needs_you',
  'responded',
  'confirmed',
  'connector',
  'empty',
];

export interface HealthCounts {
  /** Every data point on record. */
  readonly total: number;
  /** `agreement === 'confirmed'`. */
  readonly confirmed: number;
  /** Attestable, and no position of the vendor's own. */
  readonly waiting: number;
  /** `agreement === 'conflict'`. */
  readonly conflict: number;
}

export interface IntegrationSummary {
  readonly health: IntegrationHealth;
  readonly counts: HealthCounts;
}

const ZERO: HealthCounts = { total: 0, confirmed: 0, waiting: 0, conflict: 0 };

function addCounts(a: HealthCounts, b: HealthCounts): HealthCounts {
  return {
    total: a.total + b.total,
    confirmed: a.confirmed + b.confirmed,
    waiting: a.waiting + b.waiting,
    conflict: a.conflict + b.conflict,
  };
}

/** Whether a claim is waiting on the vendor. Only meaningful on an attestable edge. */
export function claimWaitsOnVendor(integration: VendorIntegration, claim: VendorClaim): boolean {
  return integration.attestable && claim.mine.length === 0;
}

export function summarizeIntegration(integration: VendorIntegration): IntegrationSummary {
  const counts = integration.claims.reduce<HealthCounts>(
    (acc, claim) => ({
      total: acc.total + 1,
      confirmed: acc.confirmed + (claim.agreement === 'confirmed' ? 1 : 0),
      waiting: acc.waiting + (claimWaitsOnVendor(integration, claim) ? 1 : 0),
      conflict: acc.conflict + (claim.agreement === 'conflict' ? 1 : 0),
    }),
    ZERO,
  );
  return { health: healthFor(integration, counts), counts };
}

function healthFor(integration: VendorIntegration, counts: HealthCounts): IntegrationHealth {
  if (counts.total === 0) return 'empty';
  // A conflict outranks the connector state: it is still a disagreement on the
  // public record, even on an edge nobody can attest to today.
  if (counts.conflict > 0) return 'conflict';
  if (!integration.attestable) return 'connector';
  if (counts.waiting > 0) return 'needs_you';
  if (counts.confirmed === counts.total) return 'confirmed';
  return 'responded';
}

/** A group is as healthy as its least healthy integration. */
export function rollUpHealth(states: readonly IntegrationHealth[]): IntegrationHealth {
  let worst: IntegrationHealth = 'empty';
  for (const state of states) {
    if (HEALTH_ORDER.indexOf(state) < HEALTH_ORDER.indexOf(worst)) worst = state;
  }
  return worst;
}

/** Everything the tab lists for one counterpart product. */
export interface CounterpartGroup {
  /** Stable across revalidation: context product + counterpart product. */
  readonly key: string;
  readonly contextProduct: ProductLink;
  readonly otherProduct: ProductLink;
  readonly integrations: readonly VendorIntegration[];
  /**
   * Integrations on record with this counterpart BEFORE any filter. Decides
   * whether the level-2 row is skipped: a filtered group showing one of two
   * integrations must not claim that one is the only integration on record.
   */
  readonly totalIntegrations: number;
  readonly health: IntegrationHealth;
  readonly counts: HealthCounts;
}

export function counterpartKey(integration: VendorIntegration): string {
  return `${integration.context_product.id}:${integration.other_product.id}`;
}

/**
 * Group integrations by counterpart product, alphabetically by counterpart name.
 *
 * The order is deliberately NOT by health. An Affirm is optimistic and changes a
 * group's health the moment it is clicked, so a health-sorted list would move the
 * row out from under the pointer (the no-layout-shift rule in
 * `STAGE_2_REALTIME_SPEC.md` §6.3). Health is shown on the row and filtered by
 * the chips instead.
 *
 * Within a group, integrations keep the server's order.
 */
export function groupByCounterpart(
  integrations: readonly VendorIntegration[],
  unfiltered: readonly VendorIntegration[] = integrations,
): readonly CounterpartGroup[] {
  const totals = new Map<string, number>();
  for (const integration of unfiltered) {
    const key = counterpartKey(integration);
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }

  const byKey = new Map<string, VendorIntegration[]>();
  for (const integration of integrations) {
    const key = counterpartKey(integration);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(integration);
    else byKey.set(key, [integration]);
  }

  const groups = [...byKey.entries()].map(([key, members]): CounterpartGroup => {
    const summaries = members.map(summarizeIntegration);
    return {
      key,
      contextProduct: members[0]!.context_product,
      otherProduct: members[0]!.other_product,
      integrations: members,
      totalIntegrations: Math.max(totals.get(key) ?? 0, members.length),
      health: rollUpHealth(summaries.map((s) => s.health)),
      counts: summaries.reduce((acc, s) => addCounts(acc, s.counts), ZERO),
    };
  });

  return groups.sort(
    (a, b) =>
      compareText(a.otherProduct.name, b.otherProduct.name) ||
      compareText(a.contextProduct.name, b.contextProduct.name) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────

/** Which side of the integration the counterpart sits on. */
export type CounterpartSide = 'any' | 'own' | 'other';

export type HealthFilter = IntegrationHealth | 'all';

export interface IntegrationFilter {
  readonly query: string;
  readonly health: HealthFilter;
  readonly side: CounterpartSide;
}

export const EMPTY_FILTER: IntegrationFilter = { query: '', health: 'all', side: 'any' };

export function isFilterActive(filter: IntegrationFilter): boolean {
  return filter.query.trim() !== '' || filter.health !== 'all' || filter.side !== 'any';
}

function normalize(text: string): string {
  return text.toLocaleLowerCase('en').normalize('NFKD');
}

/**
 * The text a query is matched against: the counterpart, the integration's own
 * name and mechanism, the connector it runs through, and every data object on it.
 * A vendor looking for "RFIs" should find the integrations that move RFIs, not
 * only integrations named after them.
 */
function haystack(integration: VendorIntegration): string {
  return normalize(
    [
      integration.other_product.name,
      integration.name,
      integration.mechanism_name,
      mechanismKindLabel(integration.mechanism_kind),
      integration.powered_by?.name,
      ...integration.claims.map((c) => c.data_object_name),
    ]
      .filter(Boolean)
      .join('   '),
  );
}

/**
 * Whether one integration passes the filter. Filtering is per integration, not
 * per group: a counterpart with a conflicting native integration and a healthy
 * connector shows only the native one under "Conflict", and the group row's
 * health and counts follow what is shown.
 */
export function matchesFilter(integration: VendorIntegration, filter: IntegrationFilter): boolean {
  if (filter.side === 'own' && integration.slots.length !== 2) return false;
  if (filter.side === 'other' && integration.slots.length === 2) return false;
  if (filter.health !== 'all' && !matchesHealth(integration, filter.health)) return false;
  const terms = normalize(filter.query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(integration);
  return terms.every((term) => text.includes(term));
}

/**
 * Whether an integration belongs under a status chip.
 *
 * Every chip matches the integration's rolled-up health, except "Needs your
 * input", which matches ANY integration with a flow waiting on the vendor. The
 * overview's waiting rows count at the flow level (`waitingByProduct`) and link
 * here with `?status=needs_you`, and a waiting flow on an integration whose
 * health is `conflict` must still be found from that link.
 */
export function matchesHealth(integration: VendorIntegration, health: IntegrationHealth): boolean {
  const summary = summarizeIntegration(integration);
  return health === 'needs_you' ? summary.counts.waiting > 0 : summary.health === health;
}

/** Integrations per health state, before the health chip is applied, so each
 *  chip can say how many results choosing it would give. */
export function healthTallies(
  integrations: readonly VendorIntegration[],
  filter: IntegrationFilter,
): ReadonlyMap<IntegrationHealth, number> {
  const tallies = new Map<IntegrationHealth, number>(HEALTH_ORDER.map((h) => [h, 0]));
  const withoutHealth: IntegrationFilter = { ...filter, health: 'all' };
  for (const integration of integrations) {
    if (!matchesFilter(integration, withoutHealth)) continue;
    for (const health of HEALTH_ORDER) {
      if (matchesHealth(integration, health)) tallies.set(health, (tallies.get(health) ?? 0) + 1);
    }
  }
  return tallies;
}

// ── URL state ────────────────────────────────────────────────────────────────

const HEALTH_VALUES = new Set<string>(HEALTH_ORDER);

/** Read the filter from query params. Unknown values fall back to the default
 *  rather than producing an empty list from a mistyped link. */
export function filterFromParams(params: { get(name: string): string | null }): IntegrationFilter {
  const health = params.get('status');
  const side = params.get('side');
  return {
    query: params.get('q') ?? '',
    health: health && HEALTH_VALUES.has(health) ? (health as IntegrationHealth) : 'all',
    side: side === 'own' || side === 'other' ? side : 'any',
  };
}

/** The query params for a filter, with defaults omitted so a clean view has a
 *  clean URL. `null` removes the param under `queryParamsHandling: 'merge'`. */
export function filterToParams(filter: IntegrationFilter): Record<string, string | null> {
  const q = filter.query.trim();
  return {
    q: q === '' ? null : q,
    status: filter.health === 'all' ? null : filter.health,
    side: filter.side === 'any' ? null : filter.side,
  };
}

/** `open` is a comma-separated list of counterpart product slugs. */
export function openSlugsFromParam(value: string | null): ReadonlySet<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function openSlugsToParam(slugs: ReadonlySet<string>): string | null {
  return slugs.size === 0 ? null : [...slugs].sort().join(',');
}
