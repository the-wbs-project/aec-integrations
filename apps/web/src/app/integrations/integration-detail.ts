import { Component, afterNextRender, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { IntegrationDetail } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';

/**
 * AECI-60 — Integration detail page at `/integrations/:id`.
 *
 * Integrations are keyed by record ID, not slug (Phase 2 Spec §6.5). All data
 * is supplied by `integrationDetailResolver` via `route.data['integration']`:
 *
 *   - `integration === null` → render the global `aec-not-found` shell
 *     (AECI-62); the resolver already set `RESPONSE_INIT.status = 404` and
 *     `MetaService.setNotFoundMeta`. URL stays at /integrations/:id.
 *   - `integration` set → render hero / metadata sidebar / body sections
 *     inside the shared `DetailLayout`.
 *
 * Headline is `"{source} → {target}"` (Phase 2 Spec §6.5), built from the
 * hydrated product names. Both products link to `/products/:slug`; the
 * built-by vendor links to `/vendors/:slug` when set. (`ProductLink` carries
 * no owning-vendor slug, so "both products' vendors" is reached transitively
 * via the product detail pages — same precedent as vendor-detail omitting
 * fields absent from the schema.)
 *
 * No JSON-LD: Phase 2 Spec §9.2 defers integration structured data to Stage 2.
 *
 * Cache discipline: tags are written by the SSR runtime (the path matcher
 * emits `route:detail` + `integration:{id}`; the resolver pushes
 * `product:{slug}` / `vendor:{slug}` for the linked entities). The page-view
 * payload was queued by the resolver. Nothing here triggers HTTP — hydration
 * reads the resolved data out of `route.data`.
 */
@Component({
  selector: 'aec-integration-detail',
  imports: [DetailLayout, ExternalLinkTracker, NotFound, RouterLink],
  template: `
    @let i = integration();
    @if (i === null) {
      <aec-not-found />
    } @else {
      <aec-detail-layout>
        <ol
          slot="breadcrumbs"
          class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)"
        >
          <li>
            <a
              routerLink="/"
              class="text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              i18n="@@integrations.detail.breadcrumbs.home"
            >
              Home
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
            {{ headline() }}
          </li>
        </ol>

        <div slot="hero" class="space-y-5">
          <p
            class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
            i18n="@@integrations.detail.eyebrow"
          >
            Integration
          </p>
          <h1
            class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) break-words sm:text-4xl"
          >
            <a
              [routerLink]="['/products', i.source.slug]"
              class="text-(--text-primary) underline decoration-(--border-strong) decoration-1 underline-offset-4 hover:decoration-(--accent-primary)"
              >{{ i.source.name }}</a
            >
            <span
              class="mx-1 text-(--text-tertiary) inline-block rtl:-scale-x-100"
              aria-hidden="true"
              >→</span
            >
            <a
              [routerLink]="['/products', i.target.slug]"
              class="text-(--text-primary) underline decoration-(--border-strong) decoration-1 underline-offset-4 hover:decoration-(--accent-primary)"
              >{{ i.target.name }}</a
            >
          </h1>

          <div class="flex flex-wrap items-center gap-3">
            @if (mechanismKindLabel(); as label) {
              <span
                class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em]
                  text-(--text-secondary)"
                [attr.aria-label]="mechanismAria()"
              >
                {{ label }}
              </span>
            }
            @if (i.direction) {
              <span
                class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-raised) px-3 py-1 text-[0.8125rem] tracking-[0.01em]
                  text-(--text-secondary)"
                [attr.aria-label]="directionAria()"
              >
                <span aria-hidden="true">{{ directionGlyph() }}</span>
                {{ directionLabel() }}
              </span>
            }
            @if (i.listing_url) {
              <a
                [href]="i.listing_url"
                target="_blank"
                rel="noopener nofollow"
                aecTrackExternalLink="integration_detail"
                class="inline-flex items-center gap-2 rounded-(--radius-md)
                  border border-(--border-strong) bg-(--accent-primary)
                  px-4 py-2 text-sm font-bold text-(--surface-base) no-underline
                  transition-colors hover:bg-(--accent-primary-hover)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <ng-container i18n="@@integrations.detail.viewListing">View listing</ng-container>
                <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
              </a>
            }
          </div>
        </div>

        <div slot="metadata" class="space-y-6">
          <section aria-labelledby="integration-glance-title" class="space-y-3">
            <h2
              id="integration-glance-title"
              class="aec-overline text-(--text-secondary)"
              i18n="@@integrations.detail.metadata.glance"
            >
              At a glance
            </h2>
            <dl
              class="space-y-3 rounded-(--radius-lg) border border-(--border-default)
                bg-(--surface-raised) p-4 text-sm"
            >
              <div class="flex items-baseline justify-between gap-4">
                <dt class="text-(--text-secondary)" i18n="@@integrations.detail.metadata.mechanism">
                  Mechanism
                </dt>
                <dd class="min-w-0 break-words text-end font-medium text-(--text-primary)">
                  @if (i.mechanism_name || mechanismKindLabel(); as mechanism) {
                    {{ mechanism }}
                  } @else {
                    <span
                      class="text-(--text-secondary)"
                      i18n="@@integrations.detail.mechanism.none"
                      i18n-aria-label="@@integrations.detail.mechanism.none.aria"
                      aria-label="Mechanism not listed"
                      >–</span
                    >
                  }
                </dd>
              </div>
              @if (i.direction) {
                <div class="flex items-baseline justify-between gap-4">
                  <dt
                    class="text-(--text-secondary)"
                    i18n="@@integrations.detail.metadata.direction"
                  >
                    Direction
                  </dt>
                  <dd class="min-w-0 break-words text-end font-medium text-(--text-primary)">
                    {{ directionLabel() }}
                  </dd>
                </div>
              }
              @if (i.maturity) {
                <div class="flex items-baseline justify-between gap-4">
                  <dt
                    class="text-(--text-secondary)"
                    i18n="@@integrations.detail.metadata.maturity"
                  >
                    Maturity
                  </dt>
                  <dd class="min-w-0 break-words text-end font-medium text-(--text-primary)">
                    {{ i.maturity }}
                  </dd>
                </div>
              }
              @if (i.pricing_model) {
                <div class="flex items-baseline justify-between gap-4">
                  <dt class="text-(--text-secondary)" i18n="@@integrations.detail.metadata.pricing">
                    Pricing
                  </dt>
                  <dd class="min-w-0 break-words text-end font-medium text-(--text-primary)">
                    {{ i.pricing_model }}
                  </dd>
                </div>
              }
            </dl>
          </section>

          @if (i.built_by_vendor; as vendor) {
            <section aria-labelledby="integration-builtby-title" class="space-y-3">
              <h2
                id="integration-builtby-title"
                class="aec-overline text-(--text-secondary)"
                i18n="@@integrations.detail.metadata.builtBy"
              >
                Built by
              </h2>
              <a
                [routerLink]="['/vendors', vendor.slug]"
                class="flex items-center gap-3 rounded-(--radius-lg) border border-(--border-default)
                  bg-(--surface-raised) p-4 no-underline transition-colors
                  hover:border-(--border-strong)"
              >
                <span class="min-w-0 break-words font-bold text-(--text-primary)">{{
                  vendor.name
                }}</span>
              </a>
            </section>
          }

          @if (i.powered_by_product; as connector) {
            <section aria-labelledby="integration-poweredby-title" class="space-y-3">
              <h2
                id="integration-poweredby-title"
                class="aec-overline text-(--text-secondary)"
                i18n="@@integrations.detail.metadata.poweredBy"
              >
                Powered by
              </h2>
              <a
                [routerLink]="['/products', connector.slug]"
                class="flex items-center gap-3 rounded-(--radius-lg) border border-(--border-default)
                  bg-(--surface-raised) p-4 no-underline transition-colors
                  hover:border-(--border-strong)"
              >
                <span class="min-w-0 break-words font-bold text-(--text-primary)">{{
                  connector.name
                }}</span>
              </a>
            </section>
          }

          @if (hasLinks()) {
            <section aria-labelledby="integration-links-title" class="space-y-3">
              <h2
                id="integration-links-title"
                class="aec-overline text-(--text-secondary)"
                i18n="@@integrations.detail.metadata.links"
              >
                Links
              </h2>
              <ul class="flex flex-col gap-2 text-sm">
                @if (i.listing_url) {
                  <li>
                    <a
                      [href]="i.listing_url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="integration_detail"
                      class="inline-flex items-center gap-1.5 text-(--accent-primary) underline underline-offset-2"
                    >
                      <ng-container i18n="@@integrations.detail.links.listing"
                        >Marketplace listing</ng-container
                      >
                      <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
                    </a>
                  </li>
                }
                @if (i.docs_url) {
                  <li>
                    <a
                      [href]="i.docs_url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="integration_detail"
                      class="inline-flex items-center gap-1.5 text-(--accent-primary) underline underline-offset-2"
                    >
                      <ng-container i18n="@@integrations.detail.links.docs"
                        >Documentation</ng-container
                      >
                      <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
                    </a>
                  </li>
                }
                @if (i.mechanism_url) {
                  <li>
                    <a
                      [href]="i.mechanism_url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="integration_detail"
                      class="inline-flex items-center gap-1.5 text-(--accent-primary) underline underline-offset-2"
                    >
                      <ng-container i18n="@@integrations.detail.links.mechanism"
                        >Connector details</ng-container
                      >
                      <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
                    </a>
                  </li>
                }
              </ul>
            </section>
          }
        </div>

        <div slot="body" class="space-y-12">
          @if (i.description) {
            <section aria-labelledby="integration-description-title" class="space-y-4">
              <h2
                id="integration-description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@integrations.detail.body.description"
              >
                About this integration
              </h2>
              <p class="max-w-prose break-words text-base leading-relaxed text-(--text-secondary)">
                {{ i.description }}
              </p>
            </section>
          }

          <section aria-labelledby="integration-connects-title" class="space-y-4">
            <h2
              id="integration-connects-title"
              class="font-display text-2xl font-semibold text-(--text-primary)"
              i18n="@@integrations.detail.body.connects"
            >
              Connects
            </h2>
            <ul class="grid gap-3 sm:grid-cols-2">
              <li>
                <a
                  [routerLink]="['/products', i.source.slug]"
                  class="flex h-full flex-col gap-1 rounded-(--radius-lg)
                    border border-(--border-default) bg-(--surface-raised) p-4
                    text-(--text-primary) no-underline transition-colors
                    hover:border-(--border-strong)"
                >
                  <span
                    class="text-xs uppercase tracking-[0.08em] text-(--text-secondary)"
                    i18n="@@integrations.detail.connects.source"
                    >Source</span
                  >
                  <span class="break-words text-sm font-bold">{{ i.source.name }}</span>
                </a>
              </li>
              <li>
                <a
                  [routerLink]="['/products', i.target.slug]"
                  class="flex h-full flex-col gap-1 rounded-(--radius-lg)
                    border border-(--border-default) bg-(--surface-raised) p-4
                    text-(--text-primary) no-underline transition-colors
                    hover:border-(--border-strong)"
                >
                  <span
                    class="text-xs uppercase tracking-[0.08em] text-(--text-secondary)"
                    i18n="@@integrations.detail.connects.target"
                    >Target</span
                  >
                  <span class="break-words text-sm font-bold">{{ i.target.name }}</span>
                </a>
              </li>
            </ul>
          </section>
        </div>
      </aec-detail-layout>
    }
  `,
})
export class IntegrationDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(Analytics);

  /**
   * Resolved data. `integrationDetailResolver` runs server-side and on
   * hydration reads from `TransferState`; the snapshot value is the
   * SSR-resolved integration (or null on a NOT_FOUND).
   */
  protected readonly integration = toSignal<IntegrationDetail | null, IntegrationDetail | null>(
    this.route.data.pipe(map((d) => (d['integration'] ?? null) as IntegrationDetail | null)),
    { initialValue: (this.route.snapshot.data['integration'] ?? null) as IntegrationDetail | null },
  );

  constructor() {
    // Browser-only `integration_viewed` (§14.1) — `afterNextRender` keeps it out
    // of SSR; `Analytics` handles consent-gating + fire-and-forget.
    afterNextRender(() => {
      const i = this.integration();
      if (i) this.analytics.integrationViewed(i.id);
    });
  }

  /** `"{source} → {target}"` headline (Phase 2 Spec §6.5). */
  protected readonly headline = computed(() => {
    const i = this.integration();
    return i ? `${i.source.name} → ${i.target.name}` : '';
  });

  protected readonly hasLinks = computed(() => {
    const i = this.integration();
    return !!(i && (i.listing_url || i.docs_url || i.mechanism_url));
  });

  protected readonly mechanismKindLabel = computed(() => {
    switch (this.integration()?.mechanism_kind) {
      case 'native':
        return $localize`:@@integrations.mechanism.native:Native`;
      case 'iPaaS':
        return $localize`:@@integrations.mechanism.ipaas:iPaaS`;
      case 'marketplace-app':
        return $localize`:@@integrations.mechanism.marketplaceApp:Marketplace app`;
      case 'api':
        return $localize`:@@integrations.mechanism.api:API`;
      case 'webhook':
        return $localize`:@@integrations.mechanism.webhook:Webhook`;
      case 'partner':
        return $localize`:@@integrations.mechanism.partner:Partner`;
      default:
        return '';
    }
  });

  protected readonly mechanismAria = computed(() => {
    const kind = this.mechanismKindLabel();
    return $localize`:@@integrations.mechanism.aria:Mechanism: ${kind}:KIND:`;
  });

  protected readonly directionLabel = computed(() => {
    switch (this.integration()?.direction) {
      case 'one-way':
        return $localize`:@@integrations.direction.oneWay:One-way`;
      case 'bidirectional':
        return $localize`:@@integrations.direction.bidirectional:Bidirectional`;
      default:
        return '';
    }
  });

  protected readonly directionGlyph = computed(() =>
    this.integration()?.direction === 'bidirectional' ? '⇄' : '→',
  );

  protected readonly directionAria = computed(() => {
    const dir = this.directionLabel();
    return $localize`:@@integrations.direction.aria:Direction: ${dir}:DIRECTION:`;
  });
}
