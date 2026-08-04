import type { IntegrationListItem, ProductLink } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { groupPoweredIntegrations } from './powered-hub-grouping';

/**
 * Unit tests for the Addendum B hub-grouping heuristic. Pure function, so these
 * run under the plain Vitest runner (no TestBed) — the component's rendering is
 * covered by `product-detail.component.spec.ts`.
 */
const link = (slug: string, name = slug): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

let seq = 0;
const edge = (
  source: ProductLink,
  target: ProductLink,
  mechanismKind: IntegrationListItem['mechanism_kind'] = 'native',
): IntegrationListItem => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  name: `${source.name} ↔ ${target.name}`,
  mechanism_kind: mechanismKind,
  mechanism_name: null,
  direction: null,
  source,
  target,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

describe('groupPoweredIntegrations', () => {
  const procore = link('procore', 'Procore');
  const acc = link('autodesk-construction-cloud', 'Autodesk Construction Cloud');
  const acumatica = link('acumatica', 'Acumatica');
  const sage = link('sage-intacct', 'Sage Intacct');
  const vista = link('viewpoint-vista', 'Viewpoint Vista');

  it('returns no groups for an empty edge list', () => {
    expect(groupPoweredIntegrations([])).toEqual([]);
  });

  it('files every edge under the globally more frequent endpoint, regardless of orientation', () => {
    // Procore appears in all three edges; the stored orientation flips between
    // them, which must not change which side is the hub.
    const groups = groupPoweredIntegrations([
      edge(procore, acumatica),
      edge(sage, procore),
      edge(procore, vista),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.hub.slug).toBe('procore');
    expect(groups[0]!.partners.map((p) => p.slug)).toEqual([
      'acumatica',
      'sage-intacct',
      'viewpoint-vista',
    ]);
  });

  it('breaks a frequency tie on slug (alphabetically first becomes the hub)', () => {
    // One edge only → both endpoints have frequency 1.
    const groups = groupPoweredIntegrations([edge(procore, acumatica)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.hub.slug).toBe('acumatica');
    expect(groups[0]!.partners.map((p) => p.slug)).toEqual(['procore']);
  });

  it('collapses multiple mechanism kinds between the same pair into one partner chip', () => {
    const groups = groupPoweredIntegrations([
      edge(procore, acumatica, 'native'),
      edge(acumatica, procore, 'iPaaS'),
      edge(procore, sage),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.hub.slug).toBe('procore');
    expect(groups[0]!.partners.map((p) => p.slug)).toEqual(['acumatica', 'sage-intacct']);
  });

  it('sorts groups by partner count descending; partners by name', () => {
    const bluebeam = link('bluebeam', 'Bluebeam');
    const groups = groupPoweredIntegrations([
      // ACC hub: 3 partners.
      edge(acc, acumatica),
      edge(acc, vista),
      edge(acc, sage),
      // Procore hub: 4 partners → sorts first despite being authored second.
      edge(procore, acumatica),
      edge(procore, vista),
      edge(procore, sage),
      edge(procore, bluebeam),
    ]);

    expect(groups.map((g) => g.hub.slug)).toEqual(['procore', 'autodesk-construction-cloud']);
    expect(groups[0]!.partners.map((p) => p.name)).toEqual([
      'Acumatica',
      'Bluebeam',
      'Sage Intacct',
      'Viewpoint Vista',
    ]);
    expect(groups[1]!.partners.map((p) => p.name)).toEqual([
      'Acumatica',
      'Sage Intacct',
      'Viewpoint Vista',
    ]);
  });

  it('breaks an equal-size group tie on hub name', () => {
    const zed = link('zed-platform', 'Zed Platform');
    const able = link('able-platform', 'Able Platform');
    const groups = groupPoweredIntegrations([
      edge(zed, link('w-one', 'W One')),
      edge(zed, link('w-two', 'W Two')),
      edge(able, link('x-one', 'X One')),
      edge(able, link('x-two', 'X Two')),
    ]);

    expect(groups.map((g) => g.hub.name)).toEqual(['Able Platform', 'Zed Platform']);
    expect(groups.every((g) => g.partners.length === 2)).toBe(true);
  });

  it('skips a corrupt self-edge instead of emitting a self-referencing chip', () => {
    const groups = groupPoweredIntegrations([edge(procore, procore), edge(procore, acumatica)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.partners.map((p) => p.slug)).toEqual(['procore']);
    expect(groups[0]!.hub.slug).toBe('acumatica');
  });
});
