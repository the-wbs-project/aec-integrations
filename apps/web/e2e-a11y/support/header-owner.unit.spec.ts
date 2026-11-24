import { describe, expect, it } from 'vitest';
import type { A11ySurface } from '../surfaces';
import { headerOwnerFor } from './header-owner';

// AECI-1877: the site header's popups are checked once per persona. If the first
// surface of a persona cannot run, the check must fall through to the next one
// rather than vanish.

function surface(id: string, persona: A11ySurface['persona'], fixture: A11ySurface['fixture']) {
  return {
    id,
    name: id,
    route: `/${id}`,
    fixture,
    persona,
    underRedesign: false,
    expectStatus: 200,
    sources: [],
  } satisfies A11ySurface;
}

const LIST = [
  surface('needs-fixtures', 'reviewer', 'phase2'),
  surface('home', 'anonymous', 'none'),
  surface('account', 'reviewer', 'auth'),
  surface('vendor-only', 'vendor', 'phase2'),
];

describe('headerOwnerFor', () => {
  it('picks the first surface of the persona when the fixtures are seeded', () => {
    expect(headerOwnerFor('reviewer', true, LIST)).toBe('needs-fixtures');
    expect(headerOwnerFor('anonymous', true, LIST)).toBe('home');
  });

  it('falls through past a phase2 surface when the fixtures are absent', () => {
    expect(headerOwnerFor('reviewer', false, LIST)).toBe('account');
  });

  it('returns null when no surface of the persona can run, and every one of them skips', () => {
    expect(headerOwnerFor('vendor', false, LIST)).toBeNull();
    expect(headerOwnerFor('admin', true, LIST)).toBeNull();
  });

  it('gives every persona in the real manifest an owner when the fixtures are seeded', () => {
    for (const persona of ['anonymous', 'reviewer', 'admin', 'vendor'] as const) {
      expect(headerOwnerFor(persona, true), persona).not.toBeNull();
    }
  });
});
