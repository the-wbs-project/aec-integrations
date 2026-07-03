import { describe, expect, it } from 'vitest';

import { contextDirectionLabel, directionLabel, mechanismKindLabel } from './mechanism-labels';

/**
 * Runs under `ng test` (`.component.spec.ts`) because `$localize` is provided by
 * the Angular unit-test pipeline (it is undefined under plain-node Vitest). No
 * TestBed needed — these are pure functions. Pins the shared label id set used
 * by both the `/integrations` table row and the `/search` integration hit card.
 */
describe('mechanismKindLabel', () => {
  it.each([
    ['native', 'Native'],
    ['iPaaS', 'iPaaS'],
    ['marketplace-app', 'Marketplace app'],
    ['api', 'API'],
    ['webhook', 'Webhook'],
    ['partner', 'Partner'],
  ])('maps %s → %s', (kind, label) => {
    expect(mechanismKindLabel(kind)).toBe(label);
  });

  it('returns empty string for null / undefined / unknown', () => {
    expect(mechanismKindLabel(null)).toBe('');
    expect(mechanismKindLabel(undefined)).toBe('');
    expect(mechanismKindLabel('mystery')).toBe('');
  });
});

describe('directionLabel', () => {
  it.each([
    ['one-way', 'One-way'],
    ['bidirectional', 'Bidirectional'],
  ])('maps %s → %s', (direction, label) => {
    expect(directionLabel(direction)).toBe(label);
  });

  it('returns empty string for null / undefined / unknown', () => {
    expect(directionLabel(null)).toBe('');
    expect(directionLabel(undefined)).toBe('');
    expect(directionLabel('sideways')).toBe('');
  });
});

describe('contextDirectionLabel', () => {
  it('re-frames a one-way flow to the context product (source → Outbound, target → Inbound)', () => {
    expect(contextDirectionLabel('one-way', true)).toEqual({
      label: 'Outbound',
      glyph: '→',
      token: 'outbound',
    });
    expect(contextDirectionLabel('one-way', false)).toEqual({
      label: 'Inbound',
      glyph: '←',
      token: 'inbound',
    });
  });

  it('reads a bidirectional flow as Both from either endpoint', () => {
    for (const isSource of [true, false]) {
      expect(contextDirectionLabel('bidirectional', isSource)).toEqual({
        label: 'Both',
        glyph: '⇄',
        token: 'both',
      });
    }
  });

  it('yields an empty token for a null / undefined direction (rendered as the em-dash empty state)', () => {
    for (const absent of [null, undefined] as const) {
      expect(contextDirectionLabel(absent, true)).toEqual({ label: '', glyph: '', token: null });
    }
  });
});
