import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ContextDirection, ProductPairMechanism, ProductPairResponse } from '@aeci/shared';

import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { NotFound } from '../not-found/not-found';
import { mechanismKindLabel } from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/** Decorative glyph for a context-relative direction (always paired with text + aria). */
function directionGlyph(direction: ContextDirection): string {
  return direction === 'outbound' ? '→' : direction === 'inbound' ? '←' : '⇄';
}

/** Visible heading for a mechanism's direction, relative to the context product. */
function directionHeading(direction: ContextDirection, otherName: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@pair.direction.outbound:Sends to ${otherName}:other:`;
    case 'inbound':
      return $localize`:@@pair.direction.inbound:Receives from ${otherName}:other:`;
    case 'both':
      return $localize`:@@pair.direction.both:Syncs both ways`;
  }
}

/** Screen-reader label for a direction (the glyph is `aria-hidden`). */
function directionAria(direction: ContextDirection, otherName: string): string {
  switch (direction) {
    case 'outbound':
      return $localize`:@@pair.direction.outbound.aria:Outbound to ${otherName}:other:`;
    case 'inbound':
      return $localize`:@@pair.direction.inbound.aria:Inbound from ${otherName}:other:`;
    case 'both':
      return $localize`:@@pair.direction.both.aria:Bidirectional`;
  }
}

/** One mechanism with its direction copy resolved against the `other` product. */
interface MechanismView {
  readonly id: string;
  readonly kindLabel: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly listingUrl: string | null;
  readonly docsUrl: string | null;
  readonly direction: ContextDirection | null;
  readonly glyph: string;
  readonly directionLabel: string;
  readonly directionAria: string;
}

interface PairView {
  readonly pair: ProductPairResponse;
  readonly mechanisms: readonly MechanismView[];
}

/**
 * AECI-294 — the product-PAIR page at
 * `/products/:contextSlug/integrations/:otherSlug` (Stage 1.5 §7, **Layer A**).
 *
 * Consolidates every integration between two products into one context-oriented
 * view, built against the AECI-289 "flow canvas" prototype: the context product
 * is anchored left, the other right, and each integration (mechanism) is a card
 * carrying a context-relative direction arrow. This is Layer A — the shell +
 * mechanisms; the `data_object`-level claim rows and the real `confirmed/total`
 * sync ratio land with Layer B (AECI-300). Until claims are seeded the data-flow
 * band reads its empty state.
 *
 * Data comes from `productsPairResolver` via `route.data['pair']`:
 *   - `null` → the global `aec-not-found` shell (the resolver set
 *     `RESPONSE_INIT.status = 404` + `setNotFoundMeta`).
 *   - set → the rail + sync band + mechanism cards.
 *
 * No JSON-LD (§9.2 defers integration structured data to Stage 2). Cache tags
 * are written by the SSR runtime (the path matcher emits `route:detail` +
 * `pair:{min}__{max}` + both `product:` tags; the resolver pushes per-mechanism
 * vendor / connector tags).
 */
@Component({
  selector: 'aec-products-pair',
  imports: [ExternalLinkTracker, LogoOrInitial, NotFound, RouterLink],
  template: `
    @let v = view();
    @if (v === null) {
      <aec-not-found />
    } @else {
      @let context = v.pair.context_product;
      @let other = v.pair.other_product;
      <div class="bg-(--surface-base) text-(--text-primary)">
        <div class="mx-auto w-full max-w-6xl px-6 py-8 md:px-8 md:py-12">
          <nav [attr.aria-label]="breadcrumbAria" class="mb-6">
            <ol class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)">
              <li>
                <a
                  routerLink="/"
                  class="no-underline hover:text-(--accent-primary)"
                  i18n="@@pair.breadcrumb.home"
                  >Home</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li>
                <a
                  [routerLink]="['/products', context.slug]"
                  class="no-underline hover:text-(--accent-primary)"
                  >{{ context.name }}</a
                >
              </li>
              <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
              <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
                {{ other.name }}
              </li>
            </ol>
          </nav>

          <header class="mb-8 space-y-3">
            <p
              class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
              i18n="@@pair.eyebrow"
            >
              Integration
            </p>
            <h1
              class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) sm:text-4xl"
              i18n="@@pair.heading"
            >
              How {{ context.name }} and {{ other.name }} exchange data
            </h1>
          </header>

          <!-- The rail: context (left) ⇄ other (right). Context is always left;
               the per-mechanism arrows below carry direction. -->
          <div
            class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 rounded-(--radius-xl) border border-(--border-default) bg-(--surface-raised) p-6 md:gap-8 md:p-8"
          >
            <a
              [routerLink]="['/products', context.slug]"
              class="flex flex-col items-center gap-2 rounded-(--radius-lg) p-2 text-center text-(--text-primary) no-underline transition-colors hover:bg-(--surface-base)"
            >
              <aec-logo-or-initial [name]="context.name" [src]="context.logo_url" size="lg" />
              <span class="font-display text-lg text-(--text-primary)">{{ context.name }}</span>
              @if (context.vendor) {
                <span class="text-xs text-(--text-tertiary)">{{ context.vendor.name }}</span>
              }
              @if (context.rating_overall_avg !== null) {
                <span
                  class="inline-flex items-center gap-1 text-xs text-(--text-secondary)"
                  [attr.aria-label]="ratingAria(context)"
                >
                  <span aria-hidden="true" class="text-(--accent-rating)">★</span>
                  <span class="tabular-nums">{{ context.rating_overall_avg.toFixed(1) }}</span>
                  <span class="text-(--text-tertiary)"
                    >· {{ context.review_count }}
                    <ng-container i18n="@@pair.reviews.count">reviews</ng-container></span
                  >
                </span>
              }
            </a>
            <span class="font-display text-3xl text-(--text-tertiary)" aria-hidden="true">⇄</span>
            <a
              [routerLink]="['/products', other.slug]"
              class="flex flex-col items-center gap-2 rounded-(--radius-lg) p-2 text-center text-(--text-primary) no-underline transition-colors hover:bg-(--surface-base)"
            >
              <aec-logo-or-initial [name]="other.name" [src]="other.logo_url" size="lg" />
              <span class="font-display text-lg text-(--text-primary)">{{ other.name }}</span>
              @if (other.vendor) {
                <span class="text-xs text-(--text-tertiary)">{{ other.vendor.name }}</span>
              }
              @if (other.rating_overall_avg !== null) {
                <span
                  class="inline-flex items-center gap-1 text-xs text-(--text-secondary)"
                  [attr.aria-label]="ratingAria(other)"
                >
                  <span aria-hidden="true" class="text-(--accent-rating)">★</span>
                  <span class="tabular-nums">{{ other.rating_overall_avg.toFixed(1) }}</span>
                  <span class="text-(--text-tertiary)"
                    >· {{ other.review_count }}
                    <ng-container i18n="@@pair.reviews.count">reviews</ng-container></span
                  >
                </span>
              }
            </a>
          </div>

          <!-- Data-flow band (§3.5). Layer A has no claims, so it reads its empty
               state; Layer B (AECI-300) fills the confirmed/total headline. -->
          <div
            class="mt-6 rounded-(--radius-xl) border border-(--border-default) bg-(--accent-warm) p-6 text-center"
          >
            <p
              class="font-display text-2xl leading-tight text-(--text-primary)"
              i18n="@@pair.dataflow.empty"
            >
              Data flows aren’t documented yet
            </p>
            <p class="mt-2 text-sm text-(--text-secondary)" i18n="@@pair.dataflow.empty.subline">
              We’re cataloguing what each integration syncs. Vendor confirmation arrives with the
              vendor portal.
            </p>
          </div>

          <!-- Per-mechanism cards with the context-relative direction arrow. -->
          <div class="mt-8 space-y-6">
            @for (m of v.mechanisms; track m.id) {
              <article
                class="space-y-4 rounded-(--radius-xl) border border-(--border-default) bg-(--surface-base) p-6"
              >
                <header class="flex flex-wrap items-center gap-3">
                  @if (m.kindLabel) {
                    <span
                      class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em] text-(--text-secondary)"
                      >{{ m.kindLabel }}</span
                    >
                  }
                  @if (m.name) {
                    <h2 class="font-display text-xl text-(--text-primary)">{{ m.name }}</h2>
                  }
                </header>

                @if (m.direction) {
                  <p class="flex items-center gap-2 text-sm text-(--text-secondary)">
                    <span
                      class="font-display text-xl text-(--accent-primary)"
                      [attr.aria-label]="m.directionAria"
                      >{{ m.glyph }}</span
                    >
                    <span>{{ m.directionLabel }}</span>
                  </p>
                }

                @if (m.description) {
                  <p class="max-w-3xl text-sm leading-relaxed text-(--text-secondary)">
                    {{ m.description }}
                  </p>
                }

                @if (m.listingUrl || m.docsUrl) {
                  <ul class="flex flex-wrap gap-4 text-sm">
                    @if (m.listingUrl) {
                      <li>
                        <a
                          [href]="m.listingUrl"
                          target="_blank"
                          rel="noopener nofollow"
                          aecTrackExternalLink="pair_detail"
                          class="inline-flex items-center gap-1.5 text-(--accent-primary) underline underline-offset-2"
                        >
                          <ng-container i18n="@@pair.mechanism.listing">View listing</ng-container>
                          <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
                        </a>
                      </li>
                    }
                    @if (m.docsUrl) {
                      <li>
                        <a
                          [href]="m.docsUrl"
                          target="_blank"
                          rel="noopener nofollow"
                          aecTrackExternalLink="pair_detail"
                          class="inline-flex items-center gap-1.5 text-(--accent-primary) underline underline-offset-2"
                        >
                          <ng-container i18n="@@pair.mechanism.docs">Documentation</ng-container>
                          <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
                        </a>
                      </li>
                    }
                  </ul>
                }
              </article>
            } @empty {
              <p class="text-sm text-(--text-secondary)" i18n="@@pair.mechanisms.empty">
                We don’t have any integrations documented between these two products yet.
              </p>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class ProductsPairPage {
  private readonly route = inject(ActivatedRoute);

  protected readonly breadcrumbAria = $localize`:@@pair.breadcrumb.aria:Breadcrumb`;

  /** Resolved pair (or `null` on NOT_FOUND); SSR-hydrated from `TransferState`. */
  private readonly pair = toSignal<ProductPairResponse | null, ProductPairResponse | null>(
    this.route.data.pipe(map((d) => (d['pair'] ?? null) as ProductPairResponse | null)),
    { initialValue: (this.route.snapshot.data['pair'] ?? null) as ProductPairResponse | null },
  );

  /** View-model: mechanisms with their direction copy resolved once. */
  protected readonly view = computed<PairView | null>(() => {
    const pair = this.pair();
    if (!pair) return null;
    const otherName = pair.other_product.name;
    return {
      pair,
      mechanisms: pair.mechanisms.map((m) => this.toMechanismView(m, otherName)),
    };
  });

  private toMechanismView(m: ProductPairMechanism, otherName: string): MechanismView {
    return {
      id: m.id,
      kindLabel: mechanismKindLabel(m.mechanism_kind),
      name: m.mechanism_name,
      description: m.description,
      listingUrl: m.listing_url,
      docsUrl: m.docs_url,
      direction: m.direction,
      glyph: m.direction ? directionGlyph(m.direction) : '',
      directionLabel: m.direction ? directionHeading(m.direction, otherName) : '',
      directionAria: m.direction ? directionAria(m.direction, otherName) : '',
    };
  }

  protected ratingAria(product: ProductPairResponse['context_product']): string {
    const avg = product.rating_overall_avg?.toFixed(1) ?? '';
    return $localize`:@@pair.rating.aria:${product.name}:name: rated ${avg}:rating: out of 5 from ${product.review_count}:count: reviews`;
  }
}
