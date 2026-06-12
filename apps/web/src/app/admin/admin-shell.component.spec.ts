/**
 * Render test for `AdminShell` (AECI-203 / Phase 5.12; extended to a layout in
 * AECI-205 / Phase 5.14). The resolved value drives the two states:
 *   - `summary` set (admin) → the shell renders with the pending-count badge and
 *     a `<router-outlet/>` for the child queue; the resolved count seeds
 *     `AdminSummaryStore` so the badge is live.
 *   - `summary === null` (non-admin) → the global `<aec-not-found/>` renders so
 *     the surface is never revealed.
 * Mirrors `taxonomy-index.component.spec.ts`'s ActivatedRoute(data) render setup.
 */
import { ActivatedRoute, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { AdminSummaryResponse } from '@aeci/shared';

import { AdminSummaryStore } from './admin-summary.store';
import { AdminShell } from './admin-shell';

function renderFixture(summary: AdminSummaryResponse | null): {
  fixture: ComponentFixture<AdminShell>;
  store: AdminSummaryStore;
  el: HTMLElement;
} {
  const data = { summary };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      { provide: ActivatedRoute, useValue: { snapshot: { data }, data: of(data) } },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const fixture = TestBed.createComponent(AdminShell);
  fixture.detectChanges();
  return { fixture, store, el: fixture.nativeElement as HTMLElement };
}

function render(summary: AdminSummaryResponse | null): HTMLElement {
  return renderFixture(summary).el;
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

  it('renders a <router-outlet> for the child queue and links the nav to /admin/reviews', () => {
    const root = render({ pending_reviews: 4 });
    expect(root.querySelector('router-outlet')).not.toBeNull();
    const link = root.querySelector('nav[aria-label="Admin sections"] a');
    expect(link?.getAttribute('href')).toBe('/admin/reviews');
  });

  it('seeds the shared store from the resolver and reflects live decrements in the badge', () => {
    const { fixture, store, el } = renderFixture({ pending_reviews: 5 });
    expect(store.pendingReviews()).toBe(5);
    expect(el.querySelector('nav[aria-label="Admin sections"]')?.textContent).toContain('5');

    // A moderation action elsewhere decrements the store → the badge ticks down.
    store.decrement();
    fixture.detectChanges();
    expect(el.querySelector('nav[aria-label="Admin sections"]')?.textContent).toContain('4');
  });

  it('does not render the queue chrome (outlet) for a non-admin', () => {
    const root = render(null);
    expect(root.querySelector('router-outlet')).toBeNull();
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
