/**
 * Render test for `AdminShell` (AECI-203 / Phase 5.12). The resolved value
 * drives the two states:
 *   - `summary` set (admin) → the shell renders with the pending-count badge.
 *   - `summary === null` (non-admin) → the global `<aec-not-found/>` renders so
 *     the surface is never revealed.
 * Mirrors `taxonomy-index.component.spec.ts`'s ActivatedRoute(data) render setup.
 */
import { ActivatedRoute, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { AdminSummaryResponse } from '@aeci/shared';

import { AdminShell } from './admin-shell';

function render(summary: AdminSummaryResponse | null): HTMLElement {
  const data = { summary };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data }, data: of(data) } },
    ],
  });
  const fixture = TestBed.createComponent(AdminShell);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('AdminShell', () => {
  it('renders the shell + pending-count badge for an admin', () => {
    const root = render({ pending_reviews: 12 });

    expect(root.querySelector('aec-not-found')).toBeNull();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Moderation');
    // The admin nav landmark (identified by its aria-label) carries the badge.
    const nav = root.querySelector('nav[aria-label="Admin sections"]');
    expect(nav).not.toBeNull();
    expect(nav?.textContent).toContain('12');
    // Accessible, non-aria-hidden description of the count.
    const srOnly = root.querySelector('.sr-only');
    expect(srOnly?.textContent).toContain('12 reviews pending moderation');
  });

  it('renders a zero badge without breaking', () => {
    const root = render({ pending_reviews: 0 });
    expect(root.querySelector('aec-not-found')).toBeNull();
    expect(root.querySelector('nav[aria-label="Admin sections"]')?.textContent).toContain('0');
  });

  it('renders the not-found shell (no admin chrome) for a non-admin (null summary)', () => {
    const root = render(null);

    expect(root.querySelector('aec-not-found')).not.toBeNull();
    // The admin shell chrome must NOT render — don't reveal the surface. (The
    // NotFound component has its own recovery <nav>, so target the admin nav.)
    expect(root.querySelector('nav[aria-label="Admin sections"]')).toBeNull();
    expect(root.textContent).not.toContain('Review queue');
    expect(root.textContent).not.toContain('reviews pending moderation');
  });

  // Structural a11y invariants (the repo's component-level axe convention —
  // cf. browse-grid.component.spec.ts "single h2 for axe heading-order"). The
  // live axe pass runs in Playwright e2e on rendered routes.
  describe('accessibility', () => {
    it('uses a single h1 then h2 (no skipped heading levels)', () => {
      const root = render({ pending_reviews: 3 });
      expect(root.querySelectorAll('h1')).toHaveLength(1);
      // No heading deeper than h2 (would skip a level under the single h2).
      expect(root.querySelector('h3, h4, h5, h6')).toBeNull();
    });

    it('gives the admin nav an accessible name', () => {
      const root = render({ pending_reviews: 3 });
      const nav = root.querySelector('nav');
      expect(nav?.getAttribute('aria-label')).toBeTruthy();
    });

    it('announces the count once: visible badge aria-hidden + an sr-only equivalent', () => {
      const root = render({ pending_reviews: 3 });
      const badge = root.querySelector('[aria-hidden="true"]');
      expect(badge?.textContent?.trim()).toBe('3');
      const srOnly = root.querySelector('.sr-only');
      expect(srOnly?.getAttribute('aria-hidden')).toBeNull();
      expect(srOnly?.textContent).toContain('3 reviews pending moderation');
    });
  });
});
