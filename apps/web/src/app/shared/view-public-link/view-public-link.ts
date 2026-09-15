import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * `ViewPublicLink` (AECI-960) — "View public page", the portal's one way out to
 * the catalog it edits (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.7).
 *
 * The vendor portal reads and writes the catalog and, until this shipped, never
 * pointed at what the catalog renders: a vendor saved a product profile and had
 * no way to see the result short of guessing the public URL. This component is
 * that link, used at three sites — the vendor `<h1>`, the product `<h2>`, and
 * each integration card's header.
 *
 * ── WHY A PLAIN `href` AND A NEW TAB ────────────────────────────────────────
 * Not a `routerLink`, and not same-tab. The portal holds unsaved form state
 * (`apps/web` has no `CanDeactivate` guard and no `beforeunload` handler — see
 * §6.1's taxonomy-modal reasoning), so a same-tab navigation can silently
 * discard an edit. And the intent is a LOOKUP rather than a destination: the
 * vendor has not finished with the page they are on. `rel="noopener"` because a
 * new browsing context otherwise gets a handle on this one. This is the same
 * call, and the same markup, the admin console made in
 * `admin/vendors/vendor-detail.html` and `admin/vendors/vendor-products-table.html`.
 *
 * ── THE NEW TAB IS ANNOUNCED, AND `ariaLabel` IS NOT OPTIONAL POLISH ────────
 * The sr-only "(opens in a new tab)" sits BESIDE the anchor, not inside it,
 * matching the two shipped admin sites so the portal and the console read alike.
 * It renders ONLY on the unnamed link. A caller-supplied `ariaLabel` states the
 * new tab itself (it has to — the sibling span is not read in a rotor or links
 * list, which is the whole reason that name exists), so keeping the span there
 * too would announce the disclosure twice in browse mode. One of the two always
 * carries it; never both.
 *
 * `ariaLabel` exists because that uniform name is only safe where the link
 * appears ONCE on a page. The vendor header and the product header qualify. The
 * integrations tab does not: it renders one card per integration, so N links
 * would share the accessible name "View public page" while pointing at N
 * different pair pages. `ACCESSIBILITY_AUDIT.md` finding A4 is open against the
 * home page for exactly that shape (three "Source (opens in a new tab)" links to
 * three different destinations, WCAG 2.4.4 Link Purpose), and a rotor or
 * `NVDA+F7` links list is where it bites. So a caller rendering this in a
 * repeated context MUST pass a name that identifies its destination.
 *
 * The name is built with `$localize` at the CALL SITE, never as an interpolated
 * `i18n-aria-label` attribute — an interpolated `i18n-*` attribute emits no
 * attribute at all in this toolchain, which would leave the link unnamed rather
 * than badly named. `DESIGN.md` §"Disclosure group card" pins the shape: the
 * accessible name begins with the visible text so WCAG 2.5.3 Label in Name holds
 * and speech input can target it.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-view-public-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      [href]="href()"
      target="_blank"
      rel="noopener"
      [attr.aria-label]="ariaLabel()"
      class="inline-flex items-center rounded-(--radius-md) px-3 py-1.5 text-xs font-medium
        text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4
        transition-colors hover:text-(--text-primary) focus-visible:outline-2
        focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n="@@shared.viewPublicLink.label"
      >View public page</a
    >
    @if (!ariaLabel()) {
      <span class="sr-only" i18n="@@shared.viewPublicLink.newTab">(opens in a new tab)</span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class ViewPublicLink {
  /** Absolute in-app path to the public listing, e.g. `/products/revit`. */
  readonly href = input.required<string>();

  /**
   * Accessible name, REQUIRED wherever this link is rendered more than once on a
   * page (see the class comment). `null` falls back to the visible "View public
   * page" text, which is correct only for a once-per-page link.
   */
  readonly ariaLabel = input<string | null>(null);
}
