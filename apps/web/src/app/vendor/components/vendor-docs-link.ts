import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';

/**
 * The vendor-guide pages the portal links to (AECI-1253 item 3,
 * `STAGE_2_PRODUCT_DOCS_SPEC.md` §7 question 1). Each key is a slug under
 * `/docs/vendors/`, and each value is the page's title, used as the link's
 * screen-reader suffix. The titles are kept here, not read from the docs
 * manifest, because importing the manifest would pull every docs page into the
 * portal bundle. `vendor-docs-link.component.spec.ts` fails when a slug stops
 * resolving or a title drifts from the page's frontmatter.
 */
export const VENDOR_GUIDE_PAGES = {
  'claiming-your-listing': () =>
    $localize`:@@vendor.docsLink.page.claiming:Claiming your vendor listing`,
  'your-seat': () => $localize`:@@vendor.docsLink.page.seat:Your seat`,
  'your-dashboard': () => $localize`:@@vendor.docsLink.page.dashboard:Your dashboard`,
  'editing-profile-and-products': () =>
    $localize`:@@vendor.docsLink.page.editing:Editing your profile and products`,
  'notifications-and-messages': () =>
    $localize`:@@vendor.docsLink.page.notifications:Notifications and messages`,
  'confirming-integration-data': () =>
    $localize`:@@vendor.docsLink.page.attesting:Confirming integration data`,
  'owning-an-integration': () => $localize`:@@vendor.docsLink.page.owning:Owning an integration`,
  'requesting-changes-and-appeals': () =>
    $localize`:@@vendor.docsLink.page.contests:Requesting changes and appeals`,
  'replying-to-reviews': () => $localize`:@@vendor.docsLink.page.replying:Replying to reviews`,
  plans: () => $localize`:@@vendor.docsLink.page.plans:Plans`,
  billing: () => $localize`:@@vendor.docsLink.page.billing:Billing`,
  checklists: () => $localize`:@@vendor.docsLink.page.checklists:Your checklists`,
  'change-history': () => $localize`:@@vendor.docsLink.page.history:Your change history`,
} as const satisfies Record<string, () => string>;

export type VendorGuidePage = keyof typeof VENDOR_GUIDE_PAGES;

/**
 * DESIGN.md's standalone link role, as `shared/view-public-link` draws it (AECI-1809):
 * secondary ink, underlined, 14px at 600 on a 44px target, no side padding. The
 * portal's other new-tab links ("Learn more", the create receipt's "View public
 * page") bind this so the hand-copied 12px spelling is gone. Whole class names.
 */
export const STANDALONE_LINK_CLASS =
  'inline-flex min-h-11 items-center gap-2 rounded-mark text-t-14 font-semibold text-(--text-secondary) underline decoration-(--border-strong) underline-offset-4 transition-colors duration-base ease-standard hover:text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/**
 * `VendorDocsLink` (AECI-1253): the portal's one "Learn more" link into the
 * vendor guide. One per portal surface, placed under the surface's heading or
 * intro, so the help sits where the task is.
 *
 * It is a standalone link (`DESIGN.md` "The Link Treatment Rule", the
 * `aec-view-public-link` spelling) and it opens a new tab, because the portal is
 * an editing surface with no `CanDeactivate` guard: a same-tab click could
 * discard an edit (case 2 of the rule). `rel="noopener"` alone, as the
 * destination is our own site. `aec-new-tab-icon` draws the cue and carries the
 * "(opens in a new tab)" note inside the anchor.
 *
 * The visible text is always "Learn more", so the accessible name gets the page
 * title as a visually hidden suffix ("Learn more: Your seat (opens in a new
 * tab)"). A links list never reads two identical entries that go to different
 * pages, and the name still begins with the visible text (WCAG 2.5.3).
 *
 * Since AECI-1811 it is the standalone link exactly as `aec-view-public-link`
 * draws it: 14px at 600 on a 44px target with no side padding, so its text lines
 * up with the paragraph or heading above it. The shared component exports no class
 * constant, so {@link STANDALONE_LINK_CLASS} repeats its spelling once, here, and
 * `vendor-docs-link.component.spec.ts` fails if the two drift apart. Light theme only.
 */
@Component({
  selector: 'aec-vendor-docs-link',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NewTabIcon],
  template: `
    <a
      [href]="href()"
      target="_blank"
      rel="noopener"
      [attr.data-docs-link]="page()"
      [class]="linkClass"
      ><span i18n="@@vendor.docsLink.learnMore"
        >Learn more<span class="sr-only">: {{ title() }} </span></span
      >
      <aec-new-tab-icon
    /></a>
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class VendorDocsLink {
  protected readonly linkClass = STANDALONE_LINK_CLASS;
  /** The vendor-guide page, by slug. */
  readonly page = input.required<VendorGuidePage>();

  protected readonly href = computed(() => `/docs/vendors/${this.page()}`);
  protected readonly title = computed(() => VENDOR_GUIDE_PAGES[this.page()]());
}
