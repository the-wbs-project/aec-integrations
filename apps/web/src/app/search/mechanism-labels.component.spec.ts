import { describe, expect, it } from 'vitest';

import { directionLabel, mechanismKindLabel } from './mechanism-labels';

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
