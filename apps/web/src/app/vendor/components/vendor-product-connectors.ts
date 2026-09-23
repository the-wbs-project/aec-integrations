import { formatDate } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  afterNextRender,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import type { EvidencedPairContestTarget, VendorProductConnector } from '@aeci/shared';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { VendorApi } from '../vendor-api';

import { VendorContestForm } from './vendor-contest-form';

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * The read-only Connectors section at the bottom of a product's Integrations
 * tab (AECI-1013 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13).
 *
 * Lists the connectors that reach this product, one card per connector, with
 * the two tiers of `STAGE_1_5_SPEC.md` §13.1 kept visibly apart:
 *
 * - **Delivered**: the connector ships a listing covering both products.
 * - **Reachable**: both products sit in the connector's catalogue, so it could
 *   join them with configuration. Always labelled, always dated ("as of"), and
 *   never phrased as an integration. It sits in a closed `<details>` because a
 *   catalogue like Kroo's reaches hundreds of products.
 *
 * ── WHY A SECTION AND NOT A TAB ─────────────────────────────────────────────
 * Most products have no connector reach, so a seventh product tab would be empty
 * on most products (AECI-994 already brought the row to six). The section hides
 * itself when there is nothing to show, like the public page's reach line.
 *
 * ── READ-ONLY, AND OUTSIDE THE LIVE CURSOR ─────────────────────────────────
 * No edit controls: connector-powered edges are out of scope for vendor editing,
 * creating and retiring here. Since AECI-1092 each delivered pair the vendor does
 * not own carries "Contest a field" (`VendorContestForm` with `anchor =
 * 'evidenced_pair'`), because a contest is not an edit (§11b.13). The read is `GET /api/vendor/products/:id/connectors`,
 * fetched once per product in the browser and never polled. Nothing a vendor
 * does moves it, so it has no `GET /api/vendor/updates` scope
 * (`STAGE_2_REALTIME_SPEC.md` §2.3).
 *
 * No outbound links to a connector's own pages: most reachable pairs are
 * `derived`, and a `derived` pair has no vendor page to cite (§13.7).
 */
@Component({
  selector: 'aec-vendor-product-connectors',
  imports: [LogoOrInitial, VendorContestForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    @if (state() === 'failed') {
      <div class="space-y-2" data-connectors-failed>
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.connectors.failed">
          Could not load the connectors that reach this product.
        </p>
        <button
          type="button"
          [class]="retryClass"
          (click)="retry()"
          i18n="@@vendor.connectors.retry"
        >
          Try again
        </button>
      </div>
    } @else if (connectors().length > 0) {
      <section class="space-y-4" aria-labelledby="vendor-connectors-heading">
        <div class="space-y-2">
          <h2 id="vendor-connectors-heading" class="m-0">
            <!-- The size lives on the span: styles.css sizes h2 outside any cascade
                 layer, so a text utility on the h2 itself is dead. -->
            <span
              class="block font-display text-xl font-semibold text-(--text-primary)"
              i18n="@@vendor.connectors.heading"
              >Connectors</span
            >
          </h2>
          <p class="max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.connectors.intro">
            Integration platforms that list this product. AEC Integrations maintains this list from
            each platform's published catalogue, so it is read-only here.
          </p>
        </div>

        <ul class="m-0 list-none space-y-4 p-0">
          @for (group of connectors(); track group.connector.id) {
            <li
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
              data-connector
            >
              <div class="flex items-center gap-3 px-4 py-3">
                <aec-logo-or-initial
                  [src]="group.connector.logo_url"
                  [name]="group.connector.name"
                  size="sm"
                />
                <h3 class="m-0 min-w-0">
                  <span
                    class="block truncate font-display text-lg font-semibold text-(--text-primary)"
                    >{{ group.connector.name }}</span
                  >
                </h3>
              </div>

              @if (group.delivered.length > 0) {
                <div class="border-t border-(--border-default) px-4 py-3" data-tier="delivered">
                  <p
                    class="aec-overline text-(--text-secondary)"
                    i18n="@@vendor.connectors.delivered.label"
                  >
                    Delivered
                  </p>
                  <p
                    class="mt-1 max-w-prose text-sm text-(--text-secondary)"
                    i18n="@@vendor.connectors.delivered.explain"
                  >
                    {{ group.connector.name }} ships a listing that connects this product with:
                  </p>
                  <ul class="mt-2 list-disc space-y-1 ps-5 text-sm text-(--text-primary)">
                    @for (item of group.delivered; track item.id) {
                      <li>{{ partnerName(item) }}</li>
                    }
                  </ul>
                  @for (target of contestable(group); track target.id) {
                    <div
                      class="mt-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base)"
                      data-contest-target
                    >
                      <p
                        class="px-5 pt-3 text-sm text-(--text-secondary)"
                        i18n="@@vendor.connectors.contest.intro"
                      >
                        {{ target.other_product.name }}, through {{ group.connector.name }}. Offered
                        by {{ ownerName(target) }}.
                      </p>
                      <aec-vendor-contest-form [integration]="target" anchor="evidenced_pair" />
                    </div>
                  }
                </div>
              }

              @if (group.reachable.length > 0) {
                <details class="group border-t border-(--border-default)" data-tier="reachable">
                  <summary
                    class="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 px-4 py-3 text-sm text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary) [&::-webkit-details-marker]:hidden"
                  >
                    <svg
                      aria-hidden="true"
                      class="h-3.5 w-3.5 shrink-0 self-center text-(--text-secondary) transition-transform group-open:rotate-90"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m9 6 6 6-6 6" /></svg
                    ><span
                      class="aec-overline text-(--text-secondary)"
                      i18n="@@vendor.connectors.reachable.label"
                      >Reachable</span
                    >&ngsp;<span
                      i18n="@@vendor.connectors.reachable.count"
                      >{group.reachable.length, plural,
                        =1 {1 product}
                        other {{{ group.reachable.length }} products}
                      }</span
                    >&ngsp;<span class="text-(--text-secondary)">{{ asOfLabel(group) }}</span>
                  </summary>
                  <div class="px-4 pb-4">
                    <p
                      class="max-w-prose text-sm text-(--text-secondary)"
                      i18n="@@vendor.connectors.reachable.explain"
                    >
                      These products appear in {{ group.connector.name }}'s catalogue alongside
                      yours. That means {{ group.connector.name }} could connect them. Nobody has
                      confirmed a working integration, so we do not count these as integrations.
                    </p>
                    <ul
                      class="mt-2 list-disc space-y-1 ps-5 text-sm text-(--text-primary) sm:columns-2"
                    >
                      @for (partner of group.reachable; track partner.id) {
                        <li>{{ partner.name }}</li>
                      }
                    </ul>
                  </div>
                </details>
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class VendorProductConnectors {
  /** The owned product this section is about. Empty while the product context
   *  resolves, and nothing is fetched until it is set. */
  readonly productId = input.required<string>();

  private readonly api = inject(VendorApi);
  private readonly locale = inject(LOCALE_ID);

  protected readonly state = signal<LoadState>('idle');
  protected readonly connectors = signal<readonly VendorProductConnector[]>([]);

  /** Browser-only: the read carries the session cookie and must never run during
   *  SSR. The effect below waits on this, then re-runs on every product switch,
   *  which is a same-route navigation that keeps this component alive. */
  private readonly rendered = signal(false);

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => this.rendered.set(true));
    effect(() => {
      if (!this.rendered()) return;
      const id = this.productId();
      if (!id) return;
      void this.load(id);
    });
  }

  protected retry(): void {
    const id = this.productId();
    if (id) void this.load(id);
  }

  /**
   * AECI-1092: the delivered pairs this vendor may contest. Not its own (the owner
   * edits instead, §11b.2), and not a retired one (a retired row takes no contest).
   * An API older than AECI-1092 sends no targets, so nothing renders.
   */
  protected contestable(group: VendorProductConnector): readonly EvidencedPairContestTarget[] {
    return (group.delivered_contest_targets ?? []).filter((t) => !t.is_owner && !t.retired);
  }

  protected ownerName(target: EvidencedPairContestTarget): string {
    return target.owner?.name ?? $localize`:@@vendor.connectors.contest.noOwner:nobody on record`;
  }

  protected partnerName(item: VendorProductConnector['delivered'][number]): string {
    return item.source.id === this.productId() ? item.target.name : item.source.name;
  }

  protected asOfLabel(group: VendorProductConnector): string {
    if (group.catalog_as_of === null) {
      return $localize`:@@vendor.connectors.reachable.undated:catalogue date not recorded`;
    }
    const date = formatDate(group.catalog_as_of, 'MMMM d, y', this.locale, 'UTC');
    return $localize`:@@vendor.connectors.reachable.asOf:as of ${date}:date:`;
  }

  private async load(productId: string): Promise<void> {
    this.state.set('loading');
    // Clear first so a product switch never shows the previous product's
    // connectors under the new product's tab.
    this.connectors.set([]);
    try {
      const res = await this.api.listProductConnectors(productId);
      // A newer product switch won the race; its own load owns the state.
      if (this.productId() !== productId) return;
      this.connectors.set(res.connectors);
      this.state.set('loaded');
    } catch {
      if (this.productId() !== productId) return;
      this.state.set('failed');
    }
  }
}
