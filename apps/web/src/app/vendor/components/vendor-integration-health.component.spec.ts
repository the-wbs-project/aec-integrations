/**
 * AECI-999 — the drill-down model: health, grouping, filtering and URL state.
 *
 * A `.component.spec.ts` only so it runs under `ng test`, where `$localize` is
 * initialised (`mechanismKindLabel` feeds the search text). Nothing here needs a
 * TestBed.
 */
import { describe, expect, it } from 'vitest';

import type { VendorClaim, VendorIntegration } from '@aeci/shared';

import { VENDOR_INTEGRATIONS_FIXTURE } from '../vendor-fixtures';

import {
  EMPTY_FILTER,
  filterFromParams,
  filterToParams,
  groupByCounterpart,
  healthTallies,
  isFilterActive,
  matchesFilter,
  openSlugsFromParam,
  openSlugsToParam,
  rollUpHealth,
  summarizeIntegration,
} from './vendor-integration-health';

const BASE = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!;

function claim(overrides: Partial<VendorClaim>): VendorClaim {
  return { ...BASE.claims[0]!, id: crypto.randomUUID(), ...overrides };
}

function integration(overrides: Partial<VendorIntegration>): VendorIntegration {
  return { ...BASE, id: crypto.randomUUID(), ...overrides };
}

const MINE = [{ ...BASE.claims[1]!.mine[0]! }];
const params = (entries: Record<string, string>) => ({
  get: (name: string) => entries[name] ?? null,
});

describe('summarizeIntegration', () => {
  it('counts totals, confirmations, waiting and conflicts', () => {
    const { counts } = summarizeIntegration(BASE);
    // The fixture's Procore edge: unverified+unvoted, single_source, confirmed, conflict.
    expect(counts).toEqual({ total: 4, confirmed: 1, waiting: 1, conflict: 1 });
  });

  it('puts conflict above everything else', () => {
    expect(summarizeIntegration(BASE).health).toBe('conflict');
  });

  it('is needs_you when an attestable data flow has no position of the vendor’s own', () => {
    const i = integration({ claims: [claim({ agreement: 'confirmed', mine: MINE }), claim({})] });
    expect(summarizeIntegration(i).health).toBe('needs_you');
  });

  it('is confirmed only when every data flow is confirmed by both vendors', () => {
    const i = integration({ claims: [claim({ agreement: 'confirmed', mine: MINE })] });
    expect(summarizeIntegration(i).health).toBe('confirmed');
  });

  it('is responded when the vendor has answered everything but not all is confirmed', () => {
    const i = integration({
      claims: [
        claim({ agreement: 'confirmed', mine: MINE }),
        claim({ agreement: 'single_source', mine: MINE }),
      ],
    });
    expect(summarizeIntegration(i).health).toBe('responded');
  });

  it('never waits on the vendor on a connector-powered edge (AECI-705)', () => {
    const i = integration({ attestable: false, claims: [claim({})] });
    const summary = summarizeIntegration(i);
    expect(summary.health).toBe('connector');
    expect(summary.counts.waiting).toBe(0);
  });

  it('still reports a conflict on a connector-powered edge', () => {
    const i = integration({ attestable: false, claims: [claim({ agreement: 'conflict' })] });
    expect(summarizeIntegration(i).health).toBe('conflict');
  });

  it('is empty with no data flows, whatever else is true', () => {
    expect(summarizeIntegration(integration({ attestable: false, claims: [] })).health).toBe(
      'empty',
    );
  });
});

describe('rollUpHealth', () => {
  it('takes the most urgent state', () => {
    expect(rollUpHealth(['confirmed', 'needs_you', 'connector'])).toBe('needs_you');
    expect(rollUpHealth(['empty', 'confirmed'])).toBe('confirmed');
    expect(rollUpHealth([])).toBe('empty');
  });
});

describe('groupByCounterpart', () => {
  const groups = groupByCounterpart(VENDOR_INTEGRATIONS_FIXTURE.integrations);

  it('puts two integrations with the same pair in one group', () => {
    const procore = groups.filter(
      (g) => g.otherProduct.name === 'Procore' && g.integrations.length === 2,
    );
    expect(procore).toHaveLength(1);
    expect(procore[0]!.counts.total).toBe(5);
    expect(procore[0]!.health).toBe('conflict');
  });

  it('keeps the same counterpart under two context products as two groups', () => {
    expect(groups.filter((g) => g.otherProduct.name === 'Procore')).toHaveLength(2);
  });

  it('orders alphabetically by counterpart, never by health', () => {
    const names = groups.map((g) => g.otherProduct.name);
    expect(names).toEqual(
      [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
    );
  });

  it('is stable when a write changes health', () => {
    const before = groupByCounterpart(VENDOR_INTEGRATIONS_FIXTURE.integrations).map((g) => g.key);
    const healed = VENDOR_INTEGRATIONS_FIXTURE.integrations.map((i) => ({
      ...i,
      claims: i.claims.map((c) => ({ ...c, agreement: 'confirmed' as const, mine: MINE })),
    }));
    expect(groupByCounterpart(healed).map((g) => g.key)).toEqual(before);
  });
});

describe('matchesFilter', () => {
  it('matches a data object name, not only product names', () => {
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, query: 'submit' })).toBe(true);
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, query: 'invoices' })).toBe(false);
  });

  it('matches the connector a flow runs through', () => {
    const powered = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => i.powered_by)!;
    expect(matchesFilter(powered, { ...EMPTY_FILTER, query: powered.powered_by!.name })).toBe(true);
  });

  it('needs every term, case-insensitively', () => {
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, query: 'PROCORE rfis' })).toBe(true);
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, query: 'procore acumatica' })).toBe(false);
  });

  it('filters by health', () => {
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, health: 'conflict' })).toBe(true);
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, health: 'confirmed' })).toBe(false);
  });

  it('splits own products from other vendors’ products', () => {
    const both = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => i.slots.length === 2)!;
    expect(matchesFilter(both, { ...EMPTY_FILTER, side: 'own' })).toBe(true);
    expect(matchesFilter(both, { ...EMPTY_FILTER, side: 'other' })).toBe(false);
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, side: 'own' })).toBe(false);
    expect(matchesFilter(BASE, { ...EMPTY_FILTER, side: 'other' })).toBe(true);
  });
});

describe('healthTallies', () => {
  it('ignores the health chip itself so every chip can show its own count', () => {
    const all = healthTallies(VENDOR_INTEGRATIONS_FIXTURE.integrations, EMPTY_FILTER);
    const withChip = healthTallies(VENDOR_INTEGRATIONS_FIXTURE.integrations, {
      ...EMPTY_FILTER,
      health: 'confirmed',
    });
    expect(withChip).toEqual(all);
  });
});

describe('the needs_you chip (overview waiting links)', () => {
  // A conflict outranks needs_you in the rolled-up health, but the overview's
  // waiting row counts flows, so its ?status=needs_you link must still find this.
  const mixed: VendorIntegration = {
    ...BASE,
    attestable: true,
    claims: [claim({ agreement: 'conflict' }), claim({ agreement: 'unverified', mine: [] })],
  };

  it('matches an integration with a waiting flow even when its health is conflict', () => {
    expect(summarizeIntegration(mixed).health).toBe('conflict');
    expect(matchesFilter(mixed, { ...EMPTY_FILTER, health: 'needs_you' })).toBe(true);
    expect(matchesFilter(mixed, { ...EMPTY_FILTER, health: 'conflict' })).toBe(true);
  });

  it('tallies it under both chips', () => {
    const tallies = healthTallies([mixed], EMPTY_FILTER);
    expect(tallies.get('conflict')).toBe(1);
    expect(tallies.get('needs_you')).toBe(1);
  });
});

describe('groupByCounterpart totals', () => {
  it('keeps the unfiltered integration count so a filtered group is not called the only one', () => {
    const all = VENDOR_INTEGRATIONS_FIXTURE.integrations;
    const procoreKey = groupByCounterpart(all).find((g) => g.integrations.length > 1)!.key;
    const visible = all.filter((i) => i.attestable);
    const group = groupByCounterpart(visible, all).find((g) => g.key === procoreKey)!;
    expect(group.integrations.length).toBe(1);
    expect(group.totalIntegrations).toBe(2);
  });
});

describe('URL state', () => {
  it('round-trips a filter and omits defaults', () => {
    const filter = { query: 'rfis', health: 'needs_you', side: 'own' } as const;
    const out = filterToParams(filter);
    expect(out).toEqual({ q: 'rfis', status: 'needs_you', side: 'own' });
    expect(filterFromParams(params(out as Record<string, string>))).toEqual(filter);
    expect(filterToParams(EMPTY_FILTER)).toEqual({ q: null, status: null, side: null });
  });

  it('falls back to defaults for unknown values rather than showing nothing', () => {
    expect(filterFromParams(params({ status: 'bogus', side: 'mine' }))).toEqual(EMPTY_FILTER);
    expect(isFilterActive(filterFromParams(params({})))).toBe(false);
  });

  it('parses and serialises the open set', () => {
    const open = openSlugsFromParam('procore, acumatica,,');
    expect([...open]).toEqual(['procore', 'acumatica']);
    expect(openSlugsToParam(open)).toBe('acumatica,procore');
    expect(openSlugsToParam(new Set())).toBeNull();
  });
});
