import type { ProductUsefulness } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import { orderUsefulness } from './usefulness-order';

const g = (slug: string, name: string, points = ['x']) => ({ slug, name, points });

describe('orderUsefulness', () => {
  it('passes null through', () => {
    expect(orderUsefulness(null, new Map())).toBeNull();
  });

  it('sorts audiences alphabetically, ignoring case and stored order', () => {
    const u: ProductUsefulness = {
      audiences: [
        g('specialty-contracting', 'Specialty Contracting'),
        g('foreman-field-supervisor', 'Foreman / Field Supervisor'),
        g('bim-manager', 'BIM Manager'),
        g('architecture', 'architecture'),
      ],
      phases: [],
    };
    expect(orderUsefulness(u, new Map())!.audiences.map((a) => a.slug)).toEqual([
      'architecture',
      'bim-manager',
      'foreman-field-supervisor',
      'specialty-contracting',
    ]);
  });

  it('sorts phases by display_order, then name, with unordered terms last', () => {
    const u: ProductUsefulness = {
      audiences: [],
      phases: [
        g('closeout-operations', 'Closeout & Operations'),
        g('minted', 'Aardvark'),
        g('design', 'Design'),
        g('pre-construction', 'Pre-Construction'),
        g('tie-b', 'Tie B'),
        g('tie-a', 'Tie A'),
      ],
    };
    const order = new Map<string, number | null>([
      ['design', 20],
      ['pre-construction', 30],
      ['closeout-operations', 50],
      ['tie-a', 30],
      ['tie-b', 30],
      ['minted', null],
    ]);
    expect(orderUsefulness(u, order)!.phases.map((p) => p.slug)).toEqual([
      'design',
      'pre-construction',
      'tie-a',
      'tie-b',
      'closeout-operations',
      'minted',
    ]);
  });

  it('keeps each group points in the order the writer chose, and does not mutate input', () => {
    const u: ProductUsefulness = {
      audiences: [g('b', 'B', ['third', 'first', 'second']), g('a', 'A', ['z', 'a'])],
      phases: [],
    };
    const out = orderUsefulness(u, new Map())!;
    expect(out.audiences.map((a) => a.points)).toEqual([
      ['z', 'a'],
      ['third', 'first', 'second'],
    ]);
    expect(u.audiences.map((a) => a.slug)).toEqual(['b', 'a']);
  });
});
