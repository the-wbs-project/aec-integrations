/**
 * Render test for `AdminShell` (AECI-203 / Phase 5.12; extended to a layout in
 * AECI-205 / Phase 5.14; restructured into the operator-console shell in
 * AECI-576 / Phase 8.3 P1.2). The resolved value drives the two states:
 *   - `summary` set (admin) → the shell renders with the grouped nav, the queue
 *     badges and a `<router-outlet/>` for the child screen; the resolved counts
 *     seed `AdminSummaryStore` so the badges are live.
 *   - `summary === null` (non-admin) → the global `<aec-not-found/>` renders so
 *     the surface is never revealed.
 * Mirrors `taxonomy-index.component.spec.ts`'s ActivatedRoute(data) render setup.
 *
 * AECI-694 turned the sidebar into a horizontal row of category dropdowns, so
 * the structural assertions moved with it: group labels are disclosure BUTTONS
 * rather than `<p>` + `aria-labelledby`, and a single-screen group (Catalog)
 * collapses to a plain link with no button at all. What did NOT move is the
 * thing these tests exist to pin: the thirteen hrefs, in §5 order, with nothing
 * dead. Panels are `[hidden]`, not removed, so every link is still queryable
 * from the nav landmark.
 *
 * AECI-922 moved the badge assertions. There were one badged link and a trigger
 * mirroring its number; there are now THREE badged links (the three Operations
 * queues) and a trigger showing their SUM. Two consequences these tests pin,
 * because neither is visible from the template alone: the trigger is the sum and
 * not a mirror, so a spec that asserts one number would pass on the wrong one;
 * and a zero renders NO badge at all, on the link and on the trigger alike.
 */
import { ActivatedRoute, Router, provideRouter } from '@angular/router';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import type { AdminSummaryResponse } from '@aeci/shared';

import { AdminSummaryStore } from './admin-summary.store';
import { AdminShell } from './admin-shell';

/** Every queue empty. Spread under each test's own overrides so a test names
 *  only the counts it cares about, and a fourth queue does not touch 20 call
 *  sites. */
const EMPTY: AdminSummaryResponse = {
  pending_reviews: 0,
  pending_requests: 0,
  pending_claims: 0,
};

function renderFixture(counts: Partial<AdminSummaryResponse> | null): {
  fixture: ComponentFixture<AdminShell>;
  store: AdminSummaryStore;
  el: HTMLElement;
} {
  const summary: AdminSummaryResponse | null = counts && { ...EMPTY, ...counts };
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

function render(counts: Partial<AdminSummaryResponse> | null): HTMLElement {
  return renderFixture(counts).el;
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

/**
 * A trigger by its HEADING, not its index.
 *
 * The positional form broke the moment AECI-722 gave Catalog a second screen and
 * turned it into a third dropdown, silently re-pointing two "Operations" tests at
 * Catalog. Addressing by label means the next group added cannot do that again.
 */
function categoryTrigger(root: HTMLElement, heading: string): HTMLButtonElement {
  const found = categoryTriggers(root).find(
    (b) => b.querySelector('span')?.textContent?.trim() === heading,
  );
  if (!found) throw new Error(`No category trigger labelled "${heading}"`);
  return found;
}

describe('AdminShell', () => {
  it('titles the console "Admin", not "Moderation" (AECI-576)', () => {
    const root = render({ pending_reviews: 12 });
    expect(root.querySelector('aec-not-found')).toBeNull();
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Admin');
    expect(root.textContent).not.toContain('Moderation');
  });

  it('renders the shell + queue badges for an admin', () => {
    const root = render({ pending_reviews: 12 });

    // The admin nav landmark (identified by its aria-label) carries the badge.
    const nav = root.querySelector('nav[aria-label="Admin sections"]');
    expect(nav).not.toBeNull();
    expect(nav?.textContent).toContain('12');
    // Accessible, non-aria-hidden description of the count.
    const srOnly = root.querySelector('.sr-only');
    expect(srOnly?.textContent).toContain('12 items awaiting action');
  });

  // AECI-922. The pre-922 behaviour was a literal "0" on the trigger and on the
  // Review queue link; with three queues that becomes four zeros in one open
  // panel, which trains an operator to stop reading the numbers. It also matches
  // the header account menu, which has always hidden its badge at zero.
  it('renders NO badge when every queue is empty', () => {
    const root = render(EMPTY);
    expect(root.querySelector('aec-not-found')).toBeNull();
    const nav = root.querySelector('nav[aria-label="Admin sections"]')!;
    expect(nav.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(nav.textContent).not.toContain('0');
    expect(nav.textContent).not.toContain('awaiting action');
  });

  describe('grouped navigation (AECI-576 / §5, AECI-694 row)', () => {
    it('renders all three groups as dropdowns now that Catalog has two screens', () => {
      const root = render({ pending_reviews: 4 });

      // THREE triggers since AECI-722. Catalog collapsed to a plain link while it
      // had one screen; adding Connectors flipped it to a dropdown with no code
      // change, because the rule keys off `items.length` rather than a flag. That
      // this assertion had to move is the rule working, not a regression.
      expect(
        categoryTriggers(root).map((b) => b.querySelector('span')?.textContent?.trim()),
      ).toEqual(['Insights', 'Catalog', 'Operations']);
    });

    it('keeps every §5 route reachable, in order, from inside the panels', () => {
      const root = render({ pending_reviews: 4 });
      // Insights = Overview, Activity (AECI-577, §5.2), Traffic (AECI-578, §5.3),
      // Audience (AECI-586, §5.4) and Subscribers (AECI-859, §5.4 — the
      // row-level half of the same section); Catalog = Coverage (AECI-579, §5.5)
      // and Connectors (AECI-722, §5.9);
      // Operations = the three queues, Vendor claims (AECI-521 — folded into
      // ADMIN_NAV_GROUPS at the AECI-619 reconciliation), Vendors (AECI-652),
      // Users (AECI-692) and System status (AECI-580, §5.6).
      expect(navLinks(root)).toEqual([
        '/admin/overview',
        '/admin/activity',
        '/admin/traffic',
        '/admin/audience',
        '/admin/subscribers',
        '/admin/catalog',
        '/admin/connectors',
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
      // Three since AECI-722 gave Catalog a second screen and therefore a panel.
      expect(panels).toHaveLength(3);
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
      const operations = categoryTrigger(el, 'Operations');
      expect(operations.getAttribute('aria-current')).toBeNull();

      // `/admin/reviewers` redirects here carrying a filter, so the category has
      // to survive a query string to light up at all.
      await TestBed.inject(Router).navigateByUrl('/admin/users?banned=true');
      fixture.detectChanges();
      expect(operations.getAttribute('aria-current')).toBe('true');
    });

    it('badges each Operations queue and SUMS them on the closed category', () => {
      const root = render({ pending_reviews: 7, pending_requests: 2, pending_claims: 3 });
      const operations = categoryTrigger(root, 'Operations');
      // The sum, on the trigger, because a collapsed panel would otherwise hide
      // the console's only live signal. Deliberately three DIFFERENT counts: a
      // trigger that mirrored one queue instead of summing them would still read
      // as a plausible number against equal ones.
      expect(operations.textContent).toContain('12');

      const badged = [...root.querySelectorAll('nav[aria-label="Admin sections"] a')].filter((a) =>
        a.querySelector('[aria-hidden="true"]'),
      );
      expect(badged.map((a) => a.getAttribute('href'))).toEqual([
        '/admin/reviews',
        '/admin/requests',
        '/admin/claims',
      ]);
      expect(badged.map((a) => a.querySelector('[aria-hidden="true"]')?.textContent)).toEqual([
        '7',
        '2',
        '3',
      ]);
    });

    // The sum is only honest because the three counts are disjoint sets — open
    // CORRECTIONS and open CLAIMS are two kinds of one `vendor_requests` table.
    // The server owns that split (`lib/admin-queue-counts.ts`); what this pins is
    // that the shell adds rather than picks.
    it('shows nothing on Operations when all three of its queues are empty', () => {
      const root = render({ pending_reviews: 0, pending_requests: 0, pending_claims: 0 });
      expect(categoryTrigger(root, 'Operations').querySelector('[aria-hidden="true"]')).toBeNull();
    });

    it('badges Operations from the two request queues alone when reviews are clear', () => {
      const root = render({ pending_reviews: 0, pending_requests: 4, pending_claims: 1 });
      expect(categoryTrigger(root, 'Operations').textContent).toContain('5');
      const badged = [...root.querySelectorAll('nav[aria-label="Admin sections"] a')].filter((a) =>
        a.querySelector('[aria-hidden="true"]'),
      );
      // The empty review queue drops OUT of the badged set rather than showing 0.
      expect(badged.map((a) => a.getAttribute('href'))).toEqual([
        '/admin/requests',
        '/admin/claims',
      ]);
    });
  });

  it('renders a <router-outlet> for the child screen', () => {
    const root = render({ pending_reviews: 4 });
    expect(root.querySelector('router-outlet')).not.toBeNull();
  });

  it('seeds all three counts from the resolver and reflects live decrements', () => {
    const { fixture, store, el } = renderFixture({
      pending_reviews: 5,
      pending_requests: 2,
      pending_claims: 1,
    });
    expect(store.pendingReviews()).toBe(5);
    expect(store.pendingRequests()).toBe(2);
    expect(store.pendingClaims()).toBe(1);
    expect(store.operationsTotal()).toBe(8);

    // A moderation action elsewhere decrements ONE queue → that badge and the
    // group total both tick down, and the other two queues are untouched.
    store.decrement('claims');
    fixture.detectChanges();
    expect(store.pendingClaims()).toBe(0);
    expect(store.pendingReviews()).toBe(5);
    expect(categoryTrigger(el, 'Operations').textContent).toContain('7');
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
    expect(root.textContent).not.toContain('awaiting action');
  });

  // Structural a11y invariants (the repo's component-level axe convention —
  // cf. browse-grid.component.spec.ts "single h2 for axe heading-order"). The
  // live axe pass runs in Playwright e2e on rendered routes.
  describe('accessibility', () => {
    it('uses a single h1 and no other heading — each screen owns the only h2', () => {
      const root = render({ pending_reviews: 3 });
      expect(root.querySelectorAll('h1')).toHaveLength(1);
      // Category labels are disclosure buttons, deliberately not headings: a
      // heading here would sit between the shell's h1 and the screen's h2. The
      // breadcrumb (AECI-777) is held to the same rule and is covered by this
      // assertion, since it renders inside this header.
      expect(root.querySelector('h2, h3, h4, h5, h6')).toBeNull();
    });

    it('renders the breadcrumb as a SECOND, separately named landmark (AECI-777)', () => {
      const root = render({ pending_reviews: 3 });
      const labels = [...root.querySelectorAll('nav')].map((n) => n.getAttribute('aria-label'));
      // Two navs in one landmark tree are indistinguishable in a screen reader's
      // landmark list unless both are named, and named differently.
      expect(labels).toEqual(['Admin sections', 'Breadcrumb']);
    });

    it('puts the breadcrumb below the nav row, not above it', () => {
      const root = render({ pending_reviews: 3 });
      const row = root.querySelector('nav[aria-label="Admin sections"]')!;
      const crumbs = root.querySelector('nav[aria-label="Breadcrumb"]')!;
      // Order is the design decision, not an accident — see the template comment.
      // It also keeps every `querySelector('nav')` in this file pointed at the row.
      expect(row.compareDocumentPosition(crumbs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('gives the admin nav an accessible name, and each panel list its own', () => {
      const root = render({ pending_reviews: 3 });
      // Addressed by label, not by position. AECI-777 hangs a second <nav> (the
      // breadcrumb) in this header, and `querySelector('nav')` would have picked
      // whichever came first — the same positional fragility AECI-722 hit with the
      // category triggers, and the same fix.
      const nav = root.querySelector('nav[aria-label="Admin sections"]')!;
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

    it('speaks every badge exactly once: visible counts aria-hidden, sr-only text beside each', () => {
      const root = render({ pending_reviews: 3, pending_requests: 2, pending_claims: 1 });

      // Every visible count is decorative. None of them is ever the accessible
      // name of anything.
      const visible = [...root.querySelectorAll('nav[aria-label="Admin sections"] span')].filter(
        (el) => /^\d+$/.test(el.textContent?.trim() ?? ''),
      );
      expect(visible).toHaveLength(4); // three links + the Operations trigger
      for (const el of visible) expect(el.getAttribute('aria-hidden')).toBe('true');

      const spoken = [...root.querySelectorAll('.sr-only')]
        .map((el) => el.textContent?.trim() ?? '')
        .filter((text) => text.includes('awaiting action'));
      // One sentence per badge, and the trigger's is the SUM — so a screen reader
      // hears the same total a sighted operator sees, not three numbers it has to
      // add.
      expect(spoken).toEqual([
        '6 items awaiting action',
        '3 awaiting action',
        '2 awaiting action',
        '1 awaiting action',
      ]);
      for (const el of root.querySelectorAll('.sr-only')) {
        expect(el.getAttribute('aria-hidden')).toBeNull();
      }
    });
  });
});
