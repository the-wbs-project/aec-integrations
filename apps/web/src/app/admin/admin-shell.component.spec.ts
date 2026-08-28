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
 *
 * AECI-694 turned the sidebar into a horizontal row of category dropdowns, so
 * the structural assertions moved with it: group labels are disclosure BUTTONS
 * rather than `<p>` + `aria-labelledby`, and a single-screen group (Catalog)
 * collapses to a plain link with no button at all. What did NOT move is the
 * thing these tests exist to pin: the eleven hrefs, in §5 order, with nothing
 * dead and the badge on exactly one of them. Panels are `[hidden]`, not removed,
 * so every link is still queryable from the nav landmark.
 */
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
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
      // A catch-all route so `Router.navigateByUrl` can actually resolve a URL:
      // the category triggers derive their current state from it.
      provideRouter([{ path: '**', children: [] }]),
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

/** The category disclosure buttons, in row order. Catalog has none: with one
 *  screen it collapses to a plain link. */
function categoryTriggers(root: HTMLElement): HTMLButtonElement[] {
  return [
    ...root.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Admin sections"] button[aria-haspopup]',
    ),
  ];
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

  describe('grouped navigation (AECI-576 / §5, AECI-694 row)', () => {
    it('renders Insights and Operations as dropdowns and collapses Catalog to a link', () => {
      const root = render({ pending_reviews: 4 });
      const nav = root.querySelector('nav[aria-label="Admin sections"]')!;

      // Two triggers, not three: a dropdown revealing one destination is a click
      // that buys nothing, so a single-screen group renders as a plain link.
      // The heading is the trigger's first <span>; the rest of its text is the
      // mirrored pending badge.
      expect(
        categoryTriggers(root).map((b) => b.querySelector('span')?.textContent?.trim()),
      ).toEqual(['Insights', 'Operations']);

      // Catalog is a direct link, labelled with the GROUP heading rather than
      // its item's ("Coverage"): at the top level of a nav the category is what
      // is self-describing.
      const row = nav.querySelector('ul')!;
      const catalog = [...row.children].find((li) => li.textContent?.trim() === 'Catalog');
      expect(catalog?.querySelector('button')).toBeNull();
      expect(catalog?.querySelector('a')?.getAttribute('href')).toBe('/admin/catalog');
    });

    it('keeps every §5 route reachable, in order, from inside the panels', () => {
      const root = render({ pending_reviews: 4 });
      // Insights = Overview, Activity (AECI-577, §5.2), Traffic (AECI-578, §5.3),
      // Audience (AECI-586, §5.4); Catalog = Coverage (AECI-579, §5.5);
      // Operations = the three queues, Vendor claims (AECI-521 — folded into
      // ADMIN_NAV_GROUPS at the AECI-619 reconciliation), Vendors (AECI-652),
      // Users (AECI-692) and System status (AECI-580, §5.6).
      expect(navLinks(root)).toEqual([
        '/admin/overview',
        '/admin/activity',
        '/admin/traffic',
        '/admin/audience',
        '/admin/catalog',
        '/admin/reviews',
        '/admin/requests',
        '/admin/claims',
        '/admin/vendors',
        '/admin/users',
        '/admin/system',
      ]);
    });

    it('keeps the three existing Operations queues reachable and unchanged', () => {
      const root = render({ pending_reviews: 4 });
      const operations = root.querySelector('ul[aria-label="Operations"]')!;
      expect(operations.textContent).toContain('Review queue');
      expect(operations.textContent).toContain('Requests');
      expect(operations.textContent).toContain('Users');
      // Stage 2's claim queue (AECI-521) joins them, from the same array.
      expect(operations.textContent).toContain('Vendor claims');
      // As does the AECI-652 vendor surface — placed between claims and people
      // because claims → vendors → people is the escalation order an operator
      // actually walks. AECI-692 took the slot "Reviewer bans" held: it listed
      // only `banned_at IS NOT NULL`, which `/admin/users?banned=true` now does
      // with filters, search and paging, so one entry replaced the other rather
      // than joining it.
      expect(operations.textContent).toContain('Vendors');
      expect(operations.textContent).not.toContain('Reviewer bans');
    });

    it('links nothing that has no route yet — a nav entry is never a 404', () => {
      const root = render({ pending_reviews: 4 });
      const hrefs = navLinks(root);
      // Since AECI-586 every §5 route exists, so there is nothing left to hold
      // back — the assertion that matters now is that no entry is dead and none
      // is duplicated by the row/panel split.
      expect(new Set(hrefs).size).toBe(hrefs.length);
      const nav = root.querySelector('nav[aria-label="Admin sections"]')!;
      expect(nav.querySelector('[aria-disabled="true"]')).toBeNull();
      expect(nav.querySelector('a[href=""]')).toBeNull();
    });

    it('keeps closed panels out of the tab order', () => {
      const root = render({ pending_reviews: 4 });
      const panels = [...root.querySelectorAll('[id$="-panel"]')];
      expect(panels).toHaveLength(2);
      // `[hidden]`, not removed: the links stay queryable (and SSR-crawlable)
      // but are never silently tabbable while the panel is shut.
      for (const panel of panels) expect(panel.hasAttribute('hidden')).toBe(true);
    });

    it('opens a panel from its trigger and closes it again', () => {
      const { fixture, el } = renderFixture({ pending_reviews: 4 });
      const [insights] = categoryTriggers(el);
      expect(insights?.getAttribute('aria-expanded')).toBe('false');

      insights?.click();
      fixture.detectChanges();
      expect(insights?.getAttribute('aria-expanded')).toBe('true');
      const panelId = insights?.getAttribute('aria-controls') ?? '';
      expect(el.querySelector(`#${panelId}`)?.hasAttribute('hidden')).toBe(false);

      insights?.click();
      fixture.detectChanges();
      expect(insights?.getAttribute('aria-expanded')).toBe('false');
    });

    it('marks the category current when one of its screens is, query string and all', async () => {
      const { fixture, el } = renderFixture({ pending_reviews: 4 });
      const operations = categoryTriggers(el)[1];
      expect(operations?.getAttribute('aria-current')).toBeNull();

      // `/admin/reviewers` redirects here carrying a filter, so the category has
      // to survive a query string to light up at all.
      await TestBed.inject(Router).navigateByUrl('/admin/users?banned=true');
      fixture.detectChanges();
      expect(operations?.getAttribute('aria-current')).toBe('true');
    });

    it('puts the badge on the review queue, and mirrors it on the closed category', () => {
      const root = render({ pending_reviews: 7 });
      const operations = categoryTriggers(root)[1]!;
      // Mirrored onto the trigger because a collapsed panel would otherwise hide
      // the console's only live signal.
      expect(operations.textContent).toContain('7');

      const badgedLinks = [...root.querySelectorAll('nav[aria-label="Admin sections"] a')].filter(
        (a) => a.querySelector('[aria-hidden="true"]'),
      );
      expect(badgedLinks).toHaveLength(1);
      expect(badgedLinks[0]?.getAttribute('href')).toBe('/admin/reviews');
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
      // Category labels are disclosure buttons, deliberately not headings: a
      // heading here would sit between the shell's h1 and the screen's h2.
      expect(root.querySelector('h2, h3, h4, h5, h6')).toBeNull();
    });

    it('gives the admin nav an accessible name, and each panel list its own', () => {
      const root = render({ pending_reviews: 3 });
      const nav = root.querySelector('nav')!;
      expect(nav.getAttribute('aria-label')).toBeTruthy();
      // The row list is named by the landmark it sits in; each PANEL list names
      // itself, so a screen reader entering one knows which category it opened.
      for (const ul of nav.querySelectorAll('[id$="-panel"] ul')) {
        expect(ul.getAttribute('aria-label')).toBeTruthy();
      }
    });

    it('wires each trigger to the panel it controls', () => {
      const root = render({ pending_reviews: 3 });
      for (const trigger of categoryTriggers(root)) {
        expect(trigger.getAttribute('aria-haspopup')).toBe('true');
        const id = trigger.getAttribute('aria-controls');
        expect(id).toBeTruthy();
        expect(root.querySelector(`#${id}`)).not.toBeNull();
      }
    });

    it('announces the count once: visible badges aria-hidden + one sr-only equivalent', () => {
      const root = render({ pending_reviews: 3 });
      // Two visible badges (the mirrored trigger count and the Review queue
      // link's), both decorative, and exactly ONE spoken sentence between them.
      const counts = [...root.querySelectorAll('[aria-hidden="true"]')].filter(
        (el) => el.textContent?.trim() === '3',
      );
      expect(counts).toHaveLength(2);

      const spoken = [...root.querySelectorAll('.sr-only')].filter((el) =>
        el.textContent?.includes('reviews pending moderation'),
      );
      expect(spoken).toHaveLength(1);
      expect(spoken[0]?.getAttribute('aria-hidden')).toBeNull();
      expect(spoken[0]?.textContent).toContain('3 reviews pending moderation');
    });
  });
});
