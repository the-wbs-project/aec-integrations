import type { ListVendorContestsResponse, ProductLink, VendorIntegration } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import {
  INTEGRATION_STATUS_KEYS,
  contestsFor,
  howYouGetIt,
  integrationStatus,
  statusFromParam,
  type IntegrationStatusKey,
} from '../integration-detail/integration-detail-model';

/**
 * The model behind the product's Integrations list (AECI-1149,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.1): counterpart grouping, the status
 * filter, and the URL state.
 *
 * It replaced the AECI-999 drill-down's health model. The status chips now filter
 * on the §6.17.2 status set, computed by the SAME `integrationStatus` the page
 * shows, so the list and the page never name one state two ways. An old
 * `?status=conflict` or `?status=needs_you` maps to its nearest key.
 *
 * Pure functions over the wire shape. Nothing here re-derives agreement.
 */

export type StatusFilter = IntegrationStatusKey | 'all';

/** Which side of the integration the counterpart sits on. */
export type CounterpartSide = 'any' | 'own' | 'other';

export interface IntegrationFilter {
  readonly query: string;
  readonly status: StatusFilter;
  readonly side: CounterpartSide;
}

export const EMPTY_FILTER: IntegrationFilter = { query: '', status: 'all', side: 'any' };

export interface StatusInputs {
  readonly contests: ListVendorContestsResponse;
  readonly entitled: boolean;
}

export function statusOf(
  integration: VendorIntegration,
  inputs: StatusInputs,
): IntegrationStatusKey {
  return integrationStatus(integration, {
    contests: contestsFor(inputs.contests, integration.id),
    entitled: inputs.entitled,
  });
}

export function isFilterActive(filter: IntegrationFilter): boolean {
  return filter.query.trim() !== '' || filter.status !== 'all' || filter.side !== 'any';
}

function normalize(text: string): string {
  return text.toLocaleLowerCase('en').normalize('NFKD');
}

/** The text a query matches: the counterpart, the integration's name and how you
 *  get it, the connector, and every type of data on it. */
function haystack(integration: VendorIntegration): string {
  return normalize(
    [
      integration.other_product.name,
      integration.name,
      integration.mechanism_name,
      howYouGetIt(integration.mechanism_kind, integration.powered_by?.name ?? null),
      integration.powered_by?.name,
      ...integration.claims.map((c) => c.data_object_name),
    ]
      .filter(Boolean)
      .join('   '),
  );
}

export function matchesFilter(
  integration: VendorIntegration,
  filter: IntegrationFilter,
  inputs: StatusInputs,
): boolean {
  if (filter.side === 'own' && integration.slots.length !== 2) return false;
  if (filter.side === 'other' && integration.slots.length === 2) return false;
  if (filter.status !== 'all' && statusOf(integration, inputs) !== filter.status) return false;
  const terms = normalize(filter.query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const text = haystack(integration);
  return terms.every((term) => text.includes(term));
}

/** Integrations per status, before the status chip is applied, so each chip can
 *  say how many results choosing it would give. */
export function statusTallies(
  integrations: readonly VendorIntegration[],
  filter: IntegrationFilter,
  inputs: StatusInputs,
): ReadonlyMap<IntegrationStatusKey, number> {
  const tallies = new Map<IntegrationStatusKey, number>(INTEGRATION_STATUS_KEYS.map((k) => [k, 0]));
  const withoutStatus: IntegrationFilter = { ...filter, status: 'all' };
  for (const integration of integrations) {
    if (!matchesFilter(integration, withoutStatus, inputs)) continue;
    const key = statusOf(integration, inputs);
    tallies.set(key, (tallies.get(key) ?? 0) + 1);
  }
  return tallies;
}

/** Everything the list shows for one counterpart product. */
export interface CounterpartGroup {
  /** Stable across revalidation: context product + counterpart product. */
  readonly key: string;
  readonly contextProduct: ProductLink;
  readonly otherProduct: ProductLink;
  readonly integrations: readonly VendorIntegration[];
}

export function counterpartKey(integration: VendorIntegration): string {
  return `${integration.context_product.id}:${integration.other_product.id}`;
}

/**
 * Group integrations by counterpart product, alphabetically by counterpart name,
 * never by status: a status moves while the vendor works, and a list sorted by it
 * would move the row out from under the pointer. Within a group, the server's
 * order.
 */
export function groupByCounterpart(
  integrations: readonly VendorIntegration[],
): readonly CounterpartGroup[] {
  const byKey = new Map<string, VendorIntegration[]>();
  for (const integration of integrations) {
    const key = counterpartKey(integration);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(integration);
    else byKey.set(key, [integration]);
  }
  const groups = [...byKey.entries()].map(
    ([key, members]): CounterpartGroup => ({
      key,
      contextProduct: members[0]!.context_product,
      otherProduct: members[0]!.other_product,
      integrations: members,
    }),
  );
  return groups.sort(
    (a, b) =>
      compareText(a.otherProduct.name, b.otherProduct.name) ||
      compareText(a.contextProduct.name, b.contextProduct.name) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

// ── URL state ────────────────────────────────────────────────────────────────

/** Read the filter from query params. An old §6.3 status value maps to its nearest
 *  key; an unknown one falls back to "all" rather than an empty list. */
export function filterFromParams(params: { get(name: string): string | null }): IntegrationFilter {
  const side = params.get('side');
  return {
    query: params.get('q') ?? '',
    status: statusFromParam(params.get('status')),
    side: side === 'own' || side === 'other' ? side : 'any',
  };
}

/** The query params for a filter, defaults omitted so a clean view has a clean
 *  URL. `null` removes the param under `queryParamsHandling: 'merge'`. The old
 *  `open` param of the drill-down is dropped. */
export function filterToParams(filter: IntegrationFilter): Record<string, string | null> {
  const q = filter.query.trim();
  return {
    q: q === '' ? null : q,
    status: filter.status === 'all' ? null : filter.status,
    side: filter.side === 'any' ? null : filter.side,
    open: null,
  };
}
