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
  // The frame translation now happens on the server (context_direction); this
  // helper only turns a precomputed token into its label + glyph.
  it('maps outbound → Outbound (→) and inbound → Inbound (←)', () => {
    expect(contextDirectionLabel('outbound')).toEqual({
      label: 'Outbound',
      glyph: '→',
      token: 'outbound',
    });
    expect(contextDirectionLabel('inbound')).toEqual({
      label: 'Inbound',
      glyph: '←',
      token: 'inbound',
    });
  });

  it('maps both → Both (⇄)', () => {
    expect(contextDirectionLabel('both')).toEqual({
      label: 'Both',
      glyph: '⇄',
      token: 'both',
    });
  });

  it('yields an empty token for a null direction (rendered as the em-dash empty state)', () => {
    expect(contextDirectionLabel(null)).toEqual({ label: '', glyph: '', token: null });
  });
});
