import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import { AecBreadcrumb, type BreadcrumbItem } from '../shared/breadcrumb/breadcrumb';
import { AdminBreadcrumbStore } from './admin-breadcrumb.store';
import { ADMIN_DETAIL_FALLBACK_LABELS, adminNavPosition } from './admin-nav';

/** The trail's root. Links to `/admin`, which redirects to the Overview. */
const ROOT_LABEL = $localize`:@@admin.breadcrumb.root:Admin`;

/**
 * AECI-777 — the operator console's breadcrumb, rendered ONCE by `AdminShell`
 * and derived entirely from the router URL.
 *
 *   /admin/overview      →  Admin › Insights › Overview
 *   /admin/vendors       →  Admin › Operations › Vendors
 *   /admin/vendors/:id   →  Admin › Operations › Vendors › Acme Corp
 *
 * It replaces the four hand-rolled "Back to …" links that each detail screen
 * carried, which had drifted into four class strings and two wrapper shapes for
 * one job, and it says where you are rather than only where you can go back to.
 *
 * ── WHY IT IS DERIVED, NOT DECLARED ──────────────────────────────────────────
 * The alternative was an `<aec-admin-breadcrumb [trail]="…">` each screen fills
 * in, mirroring how the public detail pages project an `<ol>` into
 * `DetailLayout`'s `breadcrumbs` slot. That is the right shape THERE, where the
 * trail runs through taxonomy the route does not encode. Here the route already
 * encodes everything: the URL names the section and `ADMIN_NAV_GROUPS` names its
 * label and category. Declaring it per screen would be sixteen call sites
 * restating an IA that is already written down once — the same duplication §5.0a
 * retired when the header stopped mirroring the console's nav.
 *
 * So: one consumer of the URL, one consumer of the array, and a screen added to
 * the nav gets its trail with no edit here.
 *
 * ── THE FOUR PARAMETERISED ROUTES ────────────────────────────────────────────
 * `/admin/<section>/<id>` is resolved STRUCTURALLY: the parent is `/admin/<section>`,
 * looked up in the same map. There is no detail-route table to maintain, so a
 * future detail pair gets its trail from its list screen's nav entry alone.
 *
 * The last crumb wants the entity's name, which only the child component knows
 * and only after its `afterNextRender` fetch. It arrives via
 * `AdminBreadcrumbStore`, keyed on the id — see that file for why the id travels
 * with the label. Until it lands (and on the SSR paint, which has no fetch at
 * all) the crumb shows the section's fallback word, exactly as the screen's own
 * `h2` does.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * - **No heading.** `ADMIN_PANEL_SPEC.md` §5: the shell owns the only `h1` and
 *   each screen the only `h2`. A heading here would sit between them and break
 *   axe's heading-order rule, which is the same conclusion §5 and §5.0a already
 *   reached for the nav's group labels.
 * - **No JSON-LD.** `/admin` is `noindex`, and structured data must never
 *   describe a page we tell crawlers to skip (the rule `products-pair.resolver.ts`
 *   states for the one page that does emit a `BreadcrumbList`).
 * - **No category link.** There is no `/admin/operations` route, and a crumb that
 *   looks clickable and is not is worse than plain text.
 * - **No ARIA widget.** A nav of router links is `<nav>` + `<ol>` +
 *   `aria-current` — `ANGULAR_STYLE_GUIDE.md` §19.
 */
@Component({
  selector: 'aec-admin-breadcrumb',
  imports: [AecBreadcrumb],
  // AECI-1813: the public site's one breadcrumb (`shared/breadcrumb`), as ruled on
  // 2026-11-24. This component only derives the trail.
  template: `<aec-breadcrumb class="mt-4" [items]="crumbs()" />`,
  styles: [':host { display: block; }'],
})
export class AdminBreadcrumb {
  private readonly router = inject(Router);
  private readonly store = inject(AdminBreadcrumbStore);

  /** Current path, query and fragment stripped: `?banned=true` changes the
   *  filter, not where you are. `urlAfterRedirects` so `/admin/reviewers` shows
   *  the trail for the screen it lands on rather than the one it named. */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** A crumb with no `link` is text: the category, which has no route, or the
   *  page you are on, which the shared breadcrumb marks `aria-current`. */
  protected readonly crumbs = computed<readonly BreadcrumbItem[]>(() => {
    const path = (this.url().split(/[?#]/)[0] ?? '').split('/').filter(Boolean);
    const [, section, id] = path;

    // `/admin` itself, or anything whose section names no screen (a typo, or a
    // route added to the router but not to the nav). Show where they are and
    // stop — an invented trail is worse than a short one.
    const position = section ? adminNavPosition(`/admin/${section}`) : null;
    if (!position) return [{ label: ROOT_LABEL }];

    const root: BreadcrumbItem = { label: ROOT_LABEL, link: '/admin' };
    const category: BreadcrumbItem = { label: position.groupHeading };

    if (id === undefined) {
      return [root, category, { label: position.label }];
    }

    return [
      root,
      category,
      { label: position.label, link: `/admin/${section}` },
      { label: this.entityLabel(section as string, id) },
    ];
  });

  /** The published entity name, but only if it describes THIS id — otherwise the
   *  section's fallback word. See `AdminBreadcrumbStore` for why. */
  private entityLabel(section: string, id: string): string {
    const entry = this.store.entry();
    if (entry?.id === id) return entry.label;
    return ADMIN_DETAIL_FALLBACK_LABELS[section] ?? section;
  }
}
