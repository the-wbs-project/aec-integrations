import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, computed, inject, input } from '@angular/core';

import type { SyncFacts, WhatItSyncs, WhatItSyncsObject } from '@aeci/shared';

import { AecCard } from '../shared/card/card';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

/** One of the three curated facts, ready to render. */
interface FactView {
  readonly key: 'sync_frequency' | 'sync_support' | 'sync_setup';
  readonly label: string;
  readonly value: string;
}

/**
 * Whether the "What it syncs" block has anything to show: at least one record type, or
 * at least one curated fact. The page mounts the section, and lists it in the section
 * nav, on this same test, so a block with nothing in it never renders as an empty box.
 */
export function hasWhatItSyncs(
  syncs: WhatItSyncs | null | undefined,
  facts: SyncFacts | null | undefined,
): boolean {
  const objects = syncs?.objects.length ?? 0;
  const anyFact = !!facts && (!!facts.sync_frequency || !!facts.sync_support || !!facts.sync_setup);
  return objects > 0 || anyFact;
}

/**
 * AECI-2046 (ruling 15 on AECI-2035, `STAGE_1_5_SPEC.md` §13.13): a Sync Service's
 * "What it syncs" block on its product page.
 *
 * Two parts, each rendered only when it has content:
 *
 * - **The three facts** AECi curates: how often it syncs, who supports it, how setup
 *   works. A blank fact renders nothing. A line says AEC Integrations recorded them, on
 *   which date, and links the source, so a reader never takes them for the vendor's own
 *   words or an endpoint vendor's. The Terms promise that text we write on a listing a
 *   vendor maintains "is marked as ours, with its source and date".
 * - **The record types** across the pairs it delivers (`ProductDetail.what_it_syncs`,
 *   rolled up by the API after the owner's answers). Each says which way it moves and on
 *   how many of the pairs: "Both ways, on all 8 integrations", or "One way, on 3 of 8
 *   integrations". A note says how many pairs list no record type yet, so partial data
 *   never reads as "does not sync". Rendered in the API order, A to Z by name
 *   (`[surface:product-page-what-it-syncs]`). This component adds no sort or cut.
 *
 * The lines under the cards ("Recorded by…", "A to Z by name.") sit 16px under them,
 * the gap the sibling "Integrations it delivers" section leaves between its list and its
 * note (QA pass on AECI-2035: at 12px the card shadow left them reading as 8px).
 *
 * Layout fills the width by count (`DESIGN.md`, no narrow column with a blank right
 * half): the facts take one, two or three columns from `md`, and the record types one,
 * two or three from `sm`/`lg`, as "Similar products" does.
 *
 * Attribute selector on the page's `<section id="what-it-syncs">`, like the other body
 * sections, so the anchor and the labelled region stay on the element the nav links to.
 * Product data only, so the server and the browser render the same HTML.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-what-it-syncs]',
  imports: [AecCard, NewTabIcon],
  host: { class: 'grid scroll-mt-20 gap-8' },
  template: `
    <div>
      <p
        aria-hidden="true"
        class="aec-overline mb-3 text-(--text-secondary)"
        i18n="@@products.detail.whatItSyncs.kicker"
      >
        What it syncs
      </p>
      <h2 id="what-it-syncs-title">
        <span
          class="font-display text-t-36 leading-[1.1] font-semibold tracking-[-0.02em] text-(--text-primary)"
          >{{ heading() }}</span
        >
      </h2>
      @if (objects().length > 0) {
        <p
          class="mt-4 max-w-[38em] text-t-16 leading-relaxed text-(--text-secondary)"
          data-testid="what-it-syncs-intro"
        >
          {{ intro() }}
        </p>
      }
    </div>

    @if (facts().length > 0) {
      <div class="space-y-4" data-testid="what-it-syncs-facts-block">
        <dl class="m-0 grid gap-4" [class]="factColumns()" data-testid="what-it-syncs-facts">
          @for (fact of facts(); track fact.key) {
            <div aecCard class="min-w-0 p-6" [attr.data-testid]="'what-it-syncs-fact-' + fact.key">
              <dt class="aec-overline text-(--text-secondary)">{{ fact.label }}</dt>
              <dd class="m-0 mt-2 text-t-16 leading-relaxed text-(--text-primary) break-words">
                {{ fact.value }}
              </dd>
            </div>
          }
        </dl>
        <p class="text-t-14 text-(--text-secondary)" data-testid="what-it-syncs-facts-source">
          {{ recordedLine() }}
          @if (sourceUrl(); as url) {
            <a
              class="ms-1 inline-flex items-center gap-1 whitespace-nowrap text-(--accent-primary) underline underline-offset-2"
              [href]="url"
              target="_blank"
              rel="noopener nofollow"
              data-testid="what-it-syncs-facts-source-link"
              ><span i18n="@@products.detail.whatItSyncs.factsSourceLink">Source</span
              ><aec-new-tab-icon
            /></a>
          }
        </p>
      </div>
    }

    @if (objects().length > 0) {
      <div class="space-y-4">
        <ul
          role="list"
          class="m-0 grid list-none gap-3 p-0"
          [class]="objectColumns()"
          aria-labelledby="what-it-syncs-title"
          data-testid="what-it-syncs-objects"
        >
          @for (o of objects(); track o.slug) {
            <li aecCard class="min-w-0 p-4" data-testid="what-it-syncs-object">
              <p class="m-0 text-t-16 font-semibold text-(--text-primary) break-words">
                {{ o.name }}
              </p>
              <p class="m-0 mt-1 text-t-14 text-(--text-secondary)">
                {{ objectLine(o) }}
              </p>
            </li>
          }
        </ul>
        <p
          class="text-t-14 text-(--text-secondary)"
          data-testid="what-it-syncs-order"
          i18n="@@products.detail.whatItSyncs.order"
        >
          A to Z by name.
        </p>
        @if (uncovered() > 0) {
          <p class="text-t-14 text-(--text-secondary)" data-testid="what-it-syncs-uncovered">
            {{ uncoveredLine() }}
          </p>
        }
      </div>
    }
  `,
})
export class ProductWhatItSyncs {
  private readonly locale = inject(LOCALE_ID);

  readonly productName = input.required<string>();
  readonly syncs = input<WhatItSyncs | null>(null);
  readonly syncFacts = input<SyncFacts | null>(null);

  protected readonly objects = computed<readonly WhatItSyncsObject[]>(
    () => this.syncs()?.objects ?? [],
  );

  private readonly pairCount = computed(() => this.syncs()?.pair_count ?? 0);

  /** Pairs that list no record type yet. */
  protected readonly uncovered = computed(() => {
    const s = this.syncs();
    return s ? Math.max(0, s.pair_count - s.pairs_with_flows) : 0;
  });

  protected readonly facts = computed<readonly FactView[]>(() => {
    const f = this.syncFacts();
    if (!f) return [];
    const all: FactView[] = [
      {
        key: 'sync_frequency',
        label: $localize`:@@products.detail.whatItSyncs.fact.frequency:How often it syncs`,
        value: f.sync_frequency ?? '',
      },
      {
        key: 'sync_support',
        label: $localize`:@@products.detail.whatItSyncs.fact.support:Who supports it`,
        value: f.sync_support ?? '',
      },
      {
        key: 'sync_setup',
        label: $localize`:@@products.detail.whatItSyncs.fact.setup:How setup works`,
        value: f.sync_setup ?? '',
      },
    ];
    return all.filter((fact) => fact.value.trim().length > 0);
  });

  /** The facts' source link, or `null`. */
  protected readonly sourceUrl = computed(() => this.syncFacts()?.source_url ?? null);

  /** "Recorded by AEC Integrations on November 20, 2026.", or without a date. */
  protected readonly recordedLine = computed(() => {
    const at = this.syncFacts()?.recorded_at;
    const parsed = at ? new Date(at) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      return $localize`:@@products.detail.whatItSyncs.recorded:Recorded by AEC Integrations.`;
    }
    const date = formatDate(parsed, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@products.detail.whatItSyncs.recordedOn:Recorded by AEC Integrations on ${date}:DATE:.`;
  });

  protected readonly factColumns = computed(() => {
    const n = this.facts().length;
    if (n >= 3) return 'md:grid-cols-3';
    if (n === 2) return 'md:grid-cols-2';
    return '';
  });

  protected readonly objectColumns = computed(() => {
    const n = this.objects().length;
    if (n === 1) return '';
    if (n === 2 || n === 4) return 'sm:grid-cols-2';
    return 'sm:grid-cols-2 lg:grid-cols-3';
  });

  protected readonly heading = computed(() => {
    const name = this.productName();
    return $localize`:@@products.detail.whatItSyncs.heading:What ${name}:PRODUCT: syncs`;
  });

  protected readonly intro = computed(() => {
    const count = this.pairCount();
    if (count === 1) {
      return $localize`:@@products.detail.whatItSyncs.intro.one:The types of data that move on the integration it delivers, from its data flows.`;
    }
    return $localize`:@@products.detail.whatItSyncs.intro.other:The types of data that move across the ${count}:COUNT: integrations it delivers, from the data flows on each one.`;
  });

  protected readonly uncoveredLine = computed(() => {
    const n = this.uncovered();
    const total = this.pairCount();
    if (n === 1) {
      return $localize`:@@products.detail.whatItSyncs.uncovered.one:No types of data are listed yet for 1 of its ${total}:TOTAL: integrations.`;
    }
    return $localize`:@@products.detail.whatItSyncs.uncovered.other:No types of data are listed yet for ${n}:COUNT: of its ${total}:TOTAL: integrations.`;
  });

  /**
   * "Both ways, on all 8 integrations", "One way, on 3 of 8 integrations", or a mixed
   * "Both ways on 5 and one way on 3 of 8 integrations". With one pair, the direction
   * alone.
   */
  protected objectLine(o: WhatItSyncsObject): string {
    const total = this.pairCount();
    const both = o.both_ways;
    const one = o.one_way;
    if (both > 0 && one > 0) {
      return $localize`:@@products.detail.whatItSyncs.object.mixed:Both ways on ${both}:BOTH: and one way on ${one}:ONE: of ${total}:TOTAL: integrations`;
    }
    const direction =
      one === 0
        ? $localize`:@@products.detail.whatItSyncs.direction.both:Both ways`
        : $localize`:@@products.detail.whatItSyncs.direction.one:One way`;
    if (total <= 1) return direction;
    if (o.pair_count >= total) {
      return $localize`:@@products.detail.whatItSyncs.object.all:${direction}:DIRECTION:, on all ${total}:TOTAL: integrations`;
    }
    const count = o.pair_count;
    return $localize`:@@products.detail.whatItSyncs.object.some:${direction}:DIRECTION:, on ${count}:COUNT: of ${total}:TOTAL: integrations`;
  }
}
