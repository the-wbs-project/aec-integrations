import { describe, expect, it } from 'vitest';

import {
  contextDirectionLabel,
  directionFilterLabel,
  mechanismDisplay,
  mechanismKindLabel,
} from './mechanism-labels';

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

describe('contextDirectionLabel', () => {
  // The frame translation happens on the server (context_direction). This helper only
  // turns a precomputed token into mock-up 6's words (AECI-1720 restore C), naming the
  // partner, and its glyph. It never changes or infers the token.
  it('maps outbound to "Sends to {partner}" (→) and inbound to "Receives from {partner}" (←)', () => {
    expect(contextDirectionLabel('outbound', 'Procore')).toEqual({
      label: 'Sends to Procore',
      glyph: '→',
      token: 'outbound',
    });
    expect(contextDirectionLabel('inbound', 'Procore')).toEqual({
      label: 'Receives from Procore',
      glyph: '←',
      token: 'inbound',
    });
  });

  it('maps both to "Syncs both ways" (⇄), with no partner name', () => {
    expect(contextDirectionLabel('both', 'Procore')).toEqual({
      label: 'Syncs both ways',
      glyph: '⇄',
      token: 'both',
    });
  });

  it('yields an empty token for a null direction (rendered as the dash empty state)', () => {
    expect(contextDirectionLabel(null, 'Procore')).toEqual({ label: '', glyph: '', token: null });
  });
});

describe('directionFilterLabel', () => {
  it("names this page's product on the two one-way chips", () => {
    expect(directionFilterLabel('outbound', 'Revu')).toBe('Revu sends');
    expect(directionFilterLabel('inbound', 'Revu')).toBe('Revu receives');
    expect(directionFilterLabel('both', 'Revu')).toBe('Both ways');
  });
});

describe('mechanismDisplay', () => {
  it('prints a name that contains its one kind as a word in place of the kind', () => {
    expect(mechanismDisplay(['API'], 'REST API')).toEqual({ labels: ['REST API'], name: null });
    expect(mechanismDisplay(['Native'], 'Native integration')).toEqual({
      labels: ['Native integration'],
      name: null,
    });
  });

  it('drops a name that only repeats a kind', () => {
    expect(mechanismDisplay(['Native'], 'native')).toEqual({ labels: ['Native'], name: null });
  });

  it('keeps both when the name says something the kind does not', () => {
    expect(mechanismDisplay(['Native'], 'Revu Studio')).toEqual({
      labels: ['Native'],
      name: 'Revu Studio',
    });
    // "API" inside a longer word is not the kind.
    expect(mechanismDisplay(['API'], 'Rapid sync')).toEqual({
      labels: ['API'],
      name: 'Rapid sync',
    });
  });

  it('keeps every chip on a row with several kinds, and no name at all', () => {
    expect(mechanismDisplay(['Native', 'API'], 'REST API')).toEqual({
      labels: ['Native', 'API'],
      name: 'REST API',
    });
    expect(mechanismDisplay(['API'], null)).toEqual({ labels: ['API'], name: null });
  });
});
