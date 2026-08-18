import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type {
  ContextDirection,
  ProductLink,
  ProductPairClaim,
  ProductPairMechanism,
  ProductPairResponse,
  VendorLink,
} from '@aeci/shared';

import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { NotFound } from '../not-found/not-found';
import { mechanismKindLabel } from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { MaintenanceMarker } from '../shared/maintenance-marker/maintenance-marker';

import { AgreementBadge } from './agreement-badge';
import { ClaimProvenance } from './claim-provenance';

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

/** The order the three direction lanes render in within a mechanism (§8). */
const DIRECTION_ORDER = ['outbound', 'inbound', 'both'] as const;

/** One direction lane of a mechanism's claims — heading/glyph/aria resolved,
 *  empty lanes dropped. Mirrors the AECI-289 prototype's `renderedGroups`. */
interface ClaimGroup {
  readonly direction: ContextDirection;
  readonly heading: string;
  readonly glyph: string;
  readonly aria: string;
  readonly claims: readonly ProductPairClaim[];
}

/** Group a mechanism's claims by context-relative direction, in canonical order,
 *  dropping empty lanes. Reuses the file's direction copy helpers so the Layer-A
 *  mechanism arrow and the Layer-B lanes can't drift. */
function buildClaimGroups(claims: readonly ProductPairClaim[], otherName: string): ClaimGroup[] {
  return DIRECTION_ORDER.map((direction) => ({
    direction,
    heading: directionHeading(direction, otherName),
    glyph: directionGlyph(direction),
    aria: directionAria(direction, otherName),
    claims: claims.filter((c) => c.direction === direction),
  })).filter((g) => g.claims.length > 0);
}

/** Sync-headline breadth line (§3.5), pluralised. */
function syncHeadlineText(total: number): string {
  return total === 1
    ? $localize`:@@pair.dataflow.headline.one:1 data object syncs`
    : $localize`:@@pair.dataflow.headline.other:${total}:count: data objects sync`;
}

/** The muted verification ratio (§3.5) — never a hero trust stat; `confirmed`
 *  is always 0 in Stage 1.5. */
function confirmedRatioText(confirmed: number, total: number): string {
  return $localize`:@@pair.dataflow.ratio:${confirmed}:confirmed: of ${total}:total: vendor-confirmed`;
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
  /** Data-object claim lanes (§8). Empty when the mechanism has no claims yet. */
  readonly claimGroups: readonly ClaimGroup[];
  readonly hasClaims: boolean;
  /** Stage 1 §4.4 "Built by (vendor) / Powered by (product)" — rendered as a
   *  linked byline so a via-connector mechanism (e.g. "via Agave ERP Sync")
   *  navigates to the connector's own pages instead of being dead text. */
  readonly builtByVendor: VendorLink | null;
  readonly poweredByProduct: ProductLink | null;
}

interface PairView {
  readonly pair: ProductPairResponse;
  readonly mechanisms: readonly MechanismView[];
  /** Distinct claims across the pair (§3.5) — drives the data-flow band. */
  readonly syncTotal: number;
  readonly syncHeadline: string;
  readonly confirmedRatio: string;
  /** True when some mechanism carries a Layer-B claim lane or a Layer-A direction
   *  arrow — i.e. there is detail for the Basic view to hide. Gates the toggle so
   *  a pair with nothing to collapse doesn't show a no-op control. */
  readonly hasDetail: boolean;
}

/** The pair page's two disclosure levels (URL `?view=`). `detailed` (the default,
 *  param-absent) is the full page; `basic` hides the per-direction claim lanes +
 *  standalone direction arrow, keeping the rail, sync headline, and each
 *  mechanism's identity/description/links. Content-affecting → forked in the edge
 *  cache key (see `server-runtime.ts`, mirrors AECI-190's `/products ?view=table`). */
type PairViewMode = 'basic' | 'detailed';

/**
 * Client-only persistence of the reader's last Basic/Detailed choice so it
 * becomes the default on future pair-page visits.
 *
 * CACHE-NEUTRALITY (§9.1a): the cookie is written ONLY on a toggle click and
 * read ONLY post-hydration (`afterNextRender`, browser-only) — SSR never reads
 * it, so it can NOT bake a visitor-specific view into the URL-keyed edge cache.
 * That is exactly why it is deliberately NOT in `VISITOR_STATE_COOKIES`
 * (`server-runtime.ts`), which is reserved for cookies SSR *does* read. The
 * deep-linkable `?view=` URL param — the cache-key fork — remains the source of
 * truth; the cookie only supplies the default when the URL carries no `?view=`.
 * Mirrors `ConsentBanner`'s post-hydration reconciliation of persisted state.
 */
const PAIR_VIEW_COOKIE = 'aeci_pair_view';
const PAIR_VIEW_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function readPairViewCookie(): PairViewMode | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const [name, value] = part.split('=');
    if (name?.trim() === PAIR_VIEW_COOKIE) {
      const v = value?.trim();
      if (v === 'basic' || v === 'detailed') return v;
    }
  }
  return null;
}

function writePairViewCookie(mode: PairViewMode): void {
  if (typeof document === 'undefined') return;
  // `Secure` only over HTTPS so local http dev (jsdom too) still persists it.
  const secure = globalThis.location?.protocol === 'https:' ? '; secure' : '';
  document.cookie = `${PAIR_VIEW_COOKIE}=${mode}; path=/; max-age=${PAIR_VIEW_COOKIE_MAX_AGE}; samesite=lax${secure}`;
}

/**
 * The product-PAIR page at `/products/:contextSlug/integrations/:otherSlug`
 * (Stage 1.5 §7–§8), built against the AECI-289 "flow canvas" prototype.
 *
 * Consolidates every integration between two products into one context-oriented
 * view: the context product is anchored left, the other right, and each
 * integration (mechanism) is a card. **Layer A** (AECI-294) is the shell +
 * mechanisms with a context-relative direction arrow; **Layer B** (AECI-300)
 * adds the data-flow section — the `data_object` claim rows grouped into
 * direction lanes with neutral "Unverified · AECi" badges + AECi provenance, and
 * the `confirmed/total` sync headline (§3.5). A mechanism with no claims yet (or
 * a pair with none) falls back to the Layer-A arrow + empty data-flow band.
 *
 * A **Basic/Detailed** disclosure toggle sits in the header (URL `?view=`, default
 * `detailed`). Basic (Overview) keeps the rail, sync headline, and each
 * mechanism's kind/name/description/links; it hides the Layer-B claim lanes and
 * the standalone Layer-A arrow (the granular data transfers). `view` is
 * content-affecting and forked in the edge cache key (mirrors AECI-190's
 * `/products ?view=table`); the toggle is suppressed when there's no detail to hide.
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
  imports: [
    AgreementBadge,
    ClaimProvenance,
    ExternalLinkTracker,
    LogoOrInitial,
    MailingListSignup,
    MaintenanceMarker,
    NotFound,
    RouterLink,
  ],
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

          <header class="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div class="space-y-3">
              <div class="flex flex-wrap items-center gap-2">
                <p
                  class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
                  i18n="@@pair.eyebrow"
                >
                  Integration
                </p>
                <aec-maintenance-marker />
              </div>
              <h1
                class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) sm:text-4xl"
                i18n="@@pair.heading"
              >
                How {{ context.name }} and {{ other.name }} exchange data
              </h1>
            </div>

            <!-- Basic/Detailed disclosure toggle (§8). Shown only when a mechanism
                 carries claim lanes or a direction arrow; otherwise the two views
                 are identical, so the control would be a no-op. -->
            @if (v.hasDetail) {
              <div
                role="group"
                class="inline-flex shrink-0 gap-1 self-start rounded-(--radius-md) border
                  border-(--border-default) bg-(--surface-raised) p-1"
                i18n-aria-label="@@pair.view.aria"
                aria-label="Choose a view"
              >
                <button
                  type="button"
                  [class]="viewBtnClass('basic')"
                  [attr.aria-pressed]="viewMode() === 'basic'"
                  (click)="setView('basic')"
                >
                  <span i18n="@@pair.view.basic">Basic</span>
                </button>
                <button
                  type="button"
                  [class]="viewBtnClass('detailed')"
                  [attr.aria-pressed]="viewMode() === 'detailed'"
                  (click)="setView('detailed')"
                >
                  <span i18n="@@pair.view.detailed">Detailed</span>
                </button>
              </div>
            }
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

          <!-- Data-flow band (§3.5). Leads with the sync headline once claims are
               seeded (Layer B, AECI-300); otherwise reads the empty state
               (Layer A / pre-seeding). -->
          <div
            class="mt-6 rounded-(--radius-xl) border border-(--border-default) bg-(--accent-warm) p-6 text-center"
          >
            @if (v.syncTotal > 0) {
              <p class="font-display text-2xl leading-tight text-(--text-primary)">
                {{ v.syncHeadline }}
              </p>
              <p class="mt-2 text-sm text-(--text-secondary)" i18n="@@pair.dataflow.subline">
                Unverified. Vendor confirmation arrives with the vendor portal.
              </p>
              <!-- text-secondary (not tertiary): tertiary fails AA contrast on the Bone band. -->
              <p class="mt-2 text-xs tabular-nums text-(--text-secondary)">
                {{ v.confirmedRatio }}
              </p>
            } @else {
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
            }
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

                <!-- Linked provenance byline (Stage 1 §4.4: "Built by" / "Powered
                     by"). Mechanism identity, not detail, so it renders in Basic too.
                     Until the connector FK is backfilled, via-connector rows fall
                     back to the vendor-only "Built by" segment. -->
                @if (m.builtByVendor || m.poweredByProduct) {
                  <p
                    class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-(--text-secondary)"
                  >
                    @if (m.builtByVendor; as bv) {
                      <span>
                        <ng-container i18n="@@pair.mechanism.builtBy">Built by</ng-container>
                        <a
                          [routerLink]="['/vendors', bv.slug]"
                          class="text-(--accent-primary) underline underline-offset-2"
                          >{{ bv.name }}</a
                        >
                      </span>
                    }
                    @if (m.builtByVendor && m.poweredByProduct) {
                      <span aria-hidden="true" class="text-(--text-tertiary)">·</span>
                    }
                    @if (m.poweredByProduct; as pb) {
                      <span>
                        <ng-container i18n="@@pair.mechanism.poweredBy">Powered by</ng-container>
                        <a
                          [routerLink]="['/products', pb.slug]"
                          class="text-(--accent-primary) underline underline-offset-2"
                          >{{ pb.name }}</a
                        >
                      </span>
                    }
                  </p>
                }

                <!-- Layer-A mechanism arrow: a Detailed-view detail, shown only when
                     this mechanism has no claims. When claims exist the per-lane
                     arrows below carry the direction, so the standalone arrow would
                     be redundant (§8). Hidden in Basic (Overview). -->
                @if (viewMode() === 'detailed' && !m.hasClaims && m.direction) {
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

                <!-- Layer B (§8): data_object claim rows, grouped into direction
                     lanes, each with a neutral agreement badge + AECi provenance.
                     The "data transfers back and forth", shown in Detailed only;
                     Basic (Overview) collapses to the description + sync headline. -->
                @if (viewMode() === 'detailed') {
                  @for (g of m.claimGroups; track g.direction) {
                    <div
                      class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-4"
                    >
                      <div class="flex items-center gap-3">
                        <span
                          class="font-display text-2xl text-(--accent-primary)"
                          [attr.aria-label]="g.aria"
                          >{{ g.glyph }}</span
                        >
                        <h3 class="aec-overline text-(--text-secondary)">{{ g.heading }}</h3>
                      </div>
                      <ul class="mt-3 grid gap-2 sm:grid-cols-2">
                        @for (c of g.claims; track c.data_object_slug + '|' + c.direction) {
                          <li
                            class="flex items-center justify-between gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2"
                          >
                            <span class="text-sm text-(--text-primary)">{{
                              c.data_object_name
                            }}</span>
                            <span class="flex items-center gap-2">
                              <aec-agreement-badge [agreement]="c.agreement" />
                              <aec-claim-provenance [claim]="c" />
                            </span>
                          </li>
                        }
                      </ul>
                    </div>
                  }
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

      <aec-mailing-list-signup />
    }
  `,
})
export class ProductsPairPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly breadcrumbAria = $localize`:@@pair.breadcrumb.aria:Breadcrumb`;

  /** Resolved pair (or `null` on NOT_FOUND); SSR-hydrated from `TransferState`. */
  private readonly pair = toSignal<ProductPairResponse | null, ProductPairResponse | null>(
    this.route.data.pipe(map((d) => (d['pair'] ?? null) as ProductPairResponse | null)),
    { initialValue: (this.route.snapshot.data['pair'] ?? null) as ProductPairResponse | null },
  );

  /** The reader's remembered Basic/Detailed choice, or `null` until hydrated.
   *  Populated ONLY post-hydration (see the constructor + the cookie helpers) so
   *  it never influences the cache-shared SSR render — the SSR default stays
   *  `detailed` (param-absent), and the browser reconciles after hydration. */
  private readonly cookieView = signal<PairViewMode | null>(null);

  constructor() {
    // Browser-only (`afterNextRender` never runs during SSR), so reading the
    // persisted view here can't leak a visitor-specific choice into the cached
    // HTML. When the URL carries no `?view=`, `viewMode` defers to this remembered
    // value; an explicit `?view=` in the URL still wins. Mirrors `ConsentBanner`.
    afterNextRender(() => this.cookieView.set(readPairViewCookie()));
  }

  /** Disclosure level from the URL (`?view=basic|detailed`). `requireSync` so SSR
   *  reads it synchronously; the param is in the pair route's cache-key allowlist,
   *  so each render is its own cache entry (mirrors AECI-190). */
  private readonly queryParamMap = toSignal(this.route.queryParamMap, { requireSync: true });
  protected readonly viewMode = computed<PairViewMode>(() => {
    // An explicit URL param wins — it's deep-linkable and cache-key-forked, so the
    // SSR render is already correct. Otherwise fall back to the remembered cookie
    // choice (client-only, applied post-hydration), else the `detailed` default.
    const param = this.queryParamMap().get('view');
    if (param === 'basic' || param === 'detailed') return param;
    return this.cookieView() ?? 'detailed';
  });

  /** Reflect the toggle into the URL (preserving other params) AND remember the
   *  choice in a client-only cookie so it becomes the default on the next visit. */
  protected setView(mode: PairViewMode): void {
    writePairViewCookie(mode);
    // Keep the in-memory mirror in sync so client-side navigations to another pair
    // page (no SSR round-trip) pick up the remembered choice without re-reading.
    this.cookieView.set(mode);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: mode },
      queryParamsHandling: 'merge',
    });
  }

  protected viewBtnClass(mode: PairViewMode): string {
    const base =
      'inline-flex items-center gap-1.5 rounded-(--radius-sm) px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
    return this.viewMode() === mode
      ? `${base} bg-(--accent-primary) text-(--surface-base)`
      : `${base} text-(--text-secondary) hover:text-(--text-primary)`;
  }

  /** View-model: mechanisms with their direction copy + claim lanes resolved once. */
  protected readonly view = computed<PairView | null>(() => {
    const pair = this.pair();
    if (!pair) return null;
    const otherName = pair.other_product.name;
    const { total, confirmed } = pair.sync_headline;
    const mechanisms = pair.mechanisms.map((m) => this.toMechanismView(m, otherName));
    return {
      pair,
      mechanisms,
      syncTotal: total,
      syncHeadline: syncHeadlineText(total),
      confirmedRatio: confirmedRatioText(confirmed, total),
      hasDetail: mechanisms.some(
        (m) => m.claimGroups.length > 0 || (m.direction !== null && !m.hasClaims),
      ),
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
      claimGroups: buildClaimGroups(m.claims, otherName),
      hasClaims: m.claims.length > 0,
      builtByVendor: m.built_by_vendor,
      poweredByProduct: m.powered_by_product,
    };
  }

  protected ratingAria(product: ProductPairResponse['context_product']): string {
    const avg = product.rating_overall_avg?.toFixed(1) ?? '';
    return $localize`:@@pair.rating.aria:${product.name}:name: rated ${avg}:rating: out of 5 from ${product.review_count}:count: reviews`;
  }
}
