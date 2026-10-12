import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

/**
 * One benefit line on the vendor program page (`docs/VENDOR_PROGRAM_PAGE_SPEC.md` §3,
 * ruling 2026-10-12): the item markup "What a free claim gets you" and "What Managed
 * adds" both use, so the two sections cannot drift.
 *
 * A plain semibold title, then the body (projected, so each line keeps its own i18n
 * id and in-text links), then, when the line has a docs page, a trailing "Learn more"
 * link. That link opens in a new tab with the house cue (`aec-new-tab-icon`), like
 * every docs link on this page. Its accessible name carries the title, so a links
 * list never reads five identical "Learn more" entries.
 *
 * The host is the `li` itself, so the parent `ul` keeps a valid list.
 */
@Component({
  // Attribute selector so the rendered DOM is a literal `<li>` in the parent list.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'li[aec-vendor-program-benefit]',
  imports: [RouterLink, NewTabIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'border-t border-(--border-default) py-4' },
  template: `
    <p class="font-semibold text-(--text-primary)">{{ benefitTitle() }}</p>
    <div class="mt-1 leading-relaxed text-(--text-secondary)"><ng-content /></div>
    @if (link(); as path) {
      <p class="mt-2">
        <a
          [routerLink]="path"
          [fragment]="fragment()"
          target="_blank"
          rel="noopener"
          data-testid="vp-learn-more"
          class="inline-flex items-center gap-1.5 rounded-(--radius-sm) font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          ><span i18n="@@vendorProgram.benefit.learnMore"
            >Learn more<span class="sr-only">: {{ benefitTitle() }}</span></span
          ><aec-new-tab-icon
        /></a>
      </p>
    }
  `,
})
export class VendorProgramBenefit {
  /** The line's title, already localized by the caller. */
  readonly benefitTitle = input.required<string>();
  /** The docs page that explains the line, if it has one. */
  readonly link = input<string | null>(null);
  /** A fragment on that page. */
  readonly fragment = input<string | undefined>(undefined);
}
