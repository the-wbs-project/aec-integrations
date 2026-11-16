import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { AecButton } from '../shared/button/button';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import {
  GROUP_PEEK_ROWS,
  groupDomId,
  peekGroup,
  stackPartners,
  type IntegrationCategoryGroup,
} from './integration-category-groups';
import { ProductIntegrationCard } from './product-integration-card';

/**
 * AECI-1783: one partner-category group of the long integration list.
 *
 * A group header (the category name and its count over a hairline rule, DESIGN.md §4
 * "Break the rhythm on purpose"), the group's cards, and a "Show more" button.
 *
 * **Every card is in the server HTML.** A closed group shows its first
 * {@link GROUP_PEEK_ROWS} cards. The rest carry `hidden="until-found"`, so they stay
 * crawlable links in the raw HTML and the browser's find-in-page still reaches them: a
 * match opens the card and fires `beforematch`, which opens the whole group. A browser
 * without `until-found` treats the cards as hidden, and "Show more" still reveals them.
 * "Show more" never fetches.
 *
 * The cut is placement, so it is the first rows in the group's own order and nothing
 * else (`peekGroup`). The logo stack names the first hidden partners in the same order.
 *
 * The heading takes `tabindex="-1"` so the jump rail can move focus to it.
 */
@Component({
  // Attribute selector on a real <section>, so the id the rail links to and the
  // heading that names the region sit on the element itself.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-integration-category-group]',
  imports: [AecButton, AecIcon, LogoOrInitial, ProductIntegrationCard],
  host: {
    '[id]': 'domId()',
    '[attr.aria-labelledby]': 'headingId()',
    class: 'block scroll-mt-20',
    'data-testid': 'integration-category-group',
  },
  template: `
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b pb-4">
      <!-- The size sits on the span: the unlayered heading rules beat a text-* utility
           on the heading itself. -->
      <h3
        [id]="headingId()"
        tabindex="-1"
        class="rounded-sm text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
      >
        <span class="font-display text-t-24 leading-tight font-semibold">{{ name() }}</span>
      </h3>
      <span
        class="relative rounded-pill bg-(--surface-sunken) px-3 py-0.5 text-t-13 font-semibold text-(--text-secondary) tabular-nums"
        data-testid="integration-category-group-count"
        ><span aria-hidden="true">{{ group().rows.length }}</span
        ><span class="sr-only">{{ countLabel() }}</span></span
      >
    </div>

    <ul
      class="aec-category-grid mt-4"
      role="list"
      [id]="listId()"
      [attr.aria-labelledby]="headingId()"
      data-testid="integration-cards"
    >
      @for (row of group().rows; track row.key; let i = $index) {
        <li
          aec-product-integration-card
          [row]="row"
          [contextSlug]="contextSlug()"
          [headingLevel]="4"
          [attr.hidden]="!isOpen() && i >= peekSize ? 'until-found' : null"
          (beforematch)="open.set(true)"
        ></li>
      }
    </ul>

    @if (!forceOpen() && split().hidden.length > 0) {
      <div class="mt-4">
        <button
          #toggleButton
          aecButton
          variant="secondary"
          type="button"
          class="max-sm:w-full"
          [attr.aria-expanded]="open()"
          [attr.aria-controls]="listId()"
          (click)="toggle(toggleButton)"
          data-testid="integration-category-group-toggle"
        >
          @if (open()) {
            <aec-icon name="chevron-up" decorative [size]="4" />
            <span i18n="@@facets.showFewer">Show fewer</span>
          } @else {
            <span class="flex -space-x-2" aria-hidden="true" data-testid="integration-stack">
              @for (row of stack(); track row.key) {
                <aec-logo-or-initial
                  class="rounded-mark ring-2 ring-(--surface-raised)"
                  [claimStatus]="'server-filtered'"
                  [src]="row.other.logo_url"
                  [name]="row.other.name"
                  size="sm"
                />
              }
            </span>
            <span>{{ showMoreLabel() }}</span>
            <aec-icon name="chevron-down" decorative [size]="4" />
          }
        </button>
      </div>
    }
  `,
  styles: `
    /* The group's card grid: one column, two from md, three from xl. The jump rail
       takes the left column from lg, so three columns wait for xl (mock-up 7 steps to
       two columns at 1260px and below in grouped mode). Never more than three (clash
       18). Positioned, so a hidden card below stays inside the list's box. */
    .aec-category-grid {
      position: relative;
      display: grid;
      gap: 1.5rem;
      grid-template-columns: minmax(0, 1fr);
    }
    @media (min-width: 48rem) {
      .aec-category-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (min-width: 80rem) {
      .aec-category-grid {
        grid-template-columns: repeat(3, minmax(0, 1fr));
      }
    }
    /* A card hidden until found leaves the grid flow, so it holds no empty cell. Its
       contents are skipped by the browser (content-visibility: hidden), but
       find-in-page still searches them and opens the card on a match. A browser
       without until-found reads plain hidden, which the card's own display utility
       would beat, so content-visibility is set here too: its links then leave the tab
       order and the accessibility tree, as under display: none. */
    .aec-category-grid > li[hidden] {
      content-visibility: hidden;
      position: absolute;
      inset-block-start: 0;
      inset-inline-start: 0;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class ProductIntegrationCategoryGroup {
  private readonly injector = inject(Injector);

  readonly group = input.required<IntegrationCategoryGroup>();
  /** This page's product slug; the pair-page context on every card. */
  readonly contextSlug = input.required<string>();
  /** A short filtered list opens every group and drops the button (the mock-up's rule). */
  readonly forceOpen = input(false);

  protected readonly peekSize = GROUP_PEEK_ROWS;

  /** The reader opened this group, or find-in-page did. */
  protected readonly open = signal(false);

  protected readonly isOpen = computed(() => this.forceOpen() || this.open());

  protected readonly split = computed(() => peekGroup(this.group().rows));

  protected readonly stack = computed(() => stackPartners(this.split().hidden));

  protected readonly domId = computed(() => groupDomId(this.group().key));
  protected readonly headingId = computed(() => `${this.domId()}-title`);
  protected readonly listId = computed(() => `${this.domId()}-list`);

  protected readonly name = computed(
    () =>
      this.group().category?.name ??
      $localize`:@@products.detail.body.integrations.group.uncategorised:No category on record`,
  );

  /** The same message ids as the section's lane counts, so a count reads one way. */
  protected readonly countLabel = computed(() => {
    const total = this.group().rows.length;
    return total === 1
      ? $localize`:@@products.detail.body.integrations.group.count.one:1 integration`
      : $localize`:@@products.detail.body.integrations.group.count:${total}:count: integrations`;
  });

  protected readonly showMoreLabel = computed(() => {
    const count = this.split().hidden.length;
    const category = this.group().category;
    return category
      ? $localize`:@@products.detail.body.integrations.group.showMore:Show ${count}:COUNT: more in ${category.name}:CATEGORY:`
      : $localize`:@@products.detail.body.integrations.group.showMore.plain:Show ${count}:COUNT: more`;
  });

  protected toggle(button: HTMLElement): void {
    const closing = this.open();
    this.open.set(!closing);
    // Closing removes the rows above the button, which can leave it off screen. Bring
    // it back so focus is never left out of sight (WCAG 2.4.11).
    if (closing) {
      afterNextRender(() => button.scrollIntoView({ block: 'nearest', behavior: 'instant' }), {
        injector: this.injector,
      });
    }
  }
}
