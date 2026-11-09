import { describe, expect, it } from 'vitest';

import type { FieldCaption, FieldCorrection } from '@aeci/shared';

import {
  correctionFor,
  correctionInSlot,
  newestCaption,
  newestCorrection,
} from './field-caption-facts';

const correction = (field: string, date: string): FieldCorrection => ({
  field,
  date,
  source_url: null,
  cleared: false,
});
const caption = (name: string, date: string): FieldCaption => ({
  form: 'updated',
  vendor_names: [name],
  date,
});

describe('correctionFor', () => {
  it('finds the field and tolerates an absent list', () => {
    const list = [correction('website', '2026-01-01'), correction('docs_url', '2026-02-01')];
    expect(correctionFor(list, 'docs_url')?.date).toBe('2026-02-01');
    expect(correctionFor(list, 'name')).toBeNull();
    expect(correctionFor(undefined, 'name')).toBeNull();
  });
});

describe('correctionInSlot (AECI-1628)', () => {
  const set = correction('website', '2026-01-01');
  const removed = { ...correction('docs_url', '2026-01-01'), cleared: true };

  it('shows a value-setting correction only while the value shows', () => {
    expect(correctionInSlot([set], 'website', true)).toBe(set);
    expect(correctionInSlot([set], 'website', false)).toBeNull();
  });

  it('shows a removal only while the slot is empty', () => {
    expect(correctionInSlot([removed], 'docs_url', false)).toBe(removed);
    expect(correctionInSlot([removed], 'docs_url', true)).toBeNull();
  });

  it('treats an older API with no cleared flag as value-setting', () => {
    const legacy = { field: 'website', date: '2026-01-01', source_url: null } as FieldCorrection;
    expect(correctionInSlot([legacy], 'website', true)).toBe(legacy);
    expect(correctionInSlot(undefined, 'website', true)).toBeNull();
  });
});

describe('newestCorrection', () => {
  it('picks the latest and keeps the first on a tie', () => {
    const a = correction('a', '2026-01-01T00:00:00.000Z');
    const b = correction('b', '2026-03-01T00:00:00.000Z');
    const c = correction('c', '2026-03-01T00:00:00.000Z');
    expect(newestCorrection([a, b, c])).toBe(b);
    expect(newestCorrection([])).toBeNull();
    expect(newestCorrection(undefined)).toBeNull();
  });

  it('never picks an unparseable date over a real one', () => {
    const real = correction('a', '2026-01-01');
    expect(newestCorrection([correction('b', 'soon'), real])).toBe(real);
  });
});

describe('newestCaption', () => {
  it('picks the later caption and tolerates either side being empty', () => {
    const early = caption('A', '2026-01-01');
    const late = caption('B', '2026-02-01');
    expect(newestCaption(early, late)).toBe(late);
    expect(newestCaption(late, early)).toBe(late);
    expect(newestCaption(null, late)).toBe(late);
    expect(newestCaption(early, undefined)).toBe(early);
    expect(newestCaption(null, undefined)).toBeNull();
  });
});
