/**
 * Render test for `AdminShell` (AECI-203 / Phase 5.12; extended to a layout in
 * AECI-205 / Phase 5.14; restructured into the operator-console shell in
 * AECI-576 / Phase 8.3 P1.2). The resolved value drives the two states:
 *   - `summary` set (admin) → the shell renders with the grouped nav, the
 *     pending-count badge and a `<router-outlet/>` for the child screen; the
 *     resolved count seeds `AdminSummaryStore` so the badge is live.
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

function navLinks(root: HTMLElement): string[] {
  return [...root.querySelectorAll('nav[aria-label="Admin sections"] a')].map(
    (a) => a.getAttribute('href') ?? '',
  );
}

describe('AdminShell', () => {
  it('titles the console "Admin", not "Moderation" (AECI-576)', () => {
    const root = render({ pending_reviews: 12 });
    expect(root.querySelector('aec-not-found')).toBeNull();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Admin');
    expect(root.textContent).not.toContain('Moderation');
  });

  it('renders the shell + pending-count badge for an admin', () => {
    const root = render({ pending_reviews: 12 });

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

  describe('grouped navigation (AECI-576 / §5)', () => {
    it('groups the routes under Insights and Operations, Overview first', () => {
      const root = render({ pending_reviews: 4 });
      const nav = root.querySelector('nav[aria-label="Admin sections"]')!;
      const groups = [...nav.querySelectorAll('ul[aria-labelledby]')];
      expect(groups).toHaveLength(2);

      const headings = groups.map((ul) =>
        nav.querySelector(`#${ul.getAttribute('aria-labelledby')}`)?.textContent?.trim(),
      );
      expect(headings).toEqual(['Insights', 'Operations']);
      expect(navLinks(root)).toEqual([
        '/admin/overview',
        '/admin/reviews',
        '/admin/requests',
        '/admin/reviewers',
      ]);
    });

    it('keeps the three existing Operations queues reachable and unchanged', () => {
      const root = render({ pending_reviews: 4 });
      const operations = root.querySelector('ul[aria-labelledby="admin-nav-operations"]')!;
      expect(operations.textContent).toContain('Review queue');
      expect(operations.textContent).toContain('Requests');
      expect(operations.textContent).toContain('Reviewer bans');
    });

    it('links nothing that has no route yet — a nav entry is never a 404', () => {
      const root = render({ pending_reviews: 4 });
      const hrefs = navLinks(root);
      for (const unbuilt of [
        '/admin/activity',
        '/admin/traffic',
        '/admin/audience',
        '/admin/catalog',
        '/admin/system',
      ]) {
        expect(hrefs).not.toContain(unbuilt);
      }
      // And nothing ships as a disabled/dead entry either.
      const nav = root.querySelector('nav[aria-label="Admin sections"]')!;
      expect(nav.querySelectorAll('li').length).toBe(hrefs.length);
      expect(nav.querySelector('[aria-disabled="true"]')).toBeNull();
    });

    it('puts the badge on the review queue only', () => {
      const root = render({ pending_reviews: 7 });
      const items = [...root.querySelectorAll('nav[aria-label="Admin sections"] li')];
      const badged = items.filter((li) => li.querySelector('[aria-hidden="true"]'));
      expect(badged).toHaveLength(1);
      expect(badged[0]?.querySelector('a')?.getAttribute('href')).toBe('/admin/reviews');
    });
  });

  it('renders a <router-outlet> for the child screen', () => {
    const root = render({ pending_reviews: 4 });
    expect(root.querySelector('router-outlet')).not.toBeNull();
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
    expect(root.textContent).not.toContain('Overview');
    expect(root.textContent).not.toContain('reviews pending moderation');
  });

  // Structural a11y invariants (the repo's component-level axe convention —
  // cf. browse-grid.component.spec.ts "single h2 for axe heading-order"). The
  // live axe pass runs in Playwright e2e on rendered routes.
  describe('accessibility', () => {
    it('uses a single h1 and no other heading — each screen owns the only h2', () => {
      const root = render({ pending_reviews: 3 });
      expect(root.querySelectorAll('h1')).toHaveLength(1);
      // Nav group labels are <p>+aria-labelledby, deliberately not headings: a
      // heading here would sit between the shell's h1 and the screen's h2.
      expect(root.querySelector('h2, h3, h4, h5, h6')).toBeNull();
    });

    it('gives the admin nav an accessible name, and each group list its own', () => {
      const root = render({ pending_reviews: 3 });
      const nav = root.querySelector('nav')!;
      expect(nav.getAttribute('aria-label')).toBeTruthy();
      for (const ul of nav.querySelectorAll('ul')) {
        const labelId = ul.getAttribute('aria-labelledby');
        expect(labelId).toBeTruthy();
        expect(nav.querySelector(`#${labelId}`)?.textContent?.trim()).toBeTruthy();
      }
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
