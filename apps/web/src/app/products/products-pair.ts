import { HttpClient } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type {
  ClaimTimeline,
  ContextDirection,
  ProductLink,
  ProductPairClaim,
  ProductPairMechanism,
  ProductPairResponse,
  VendorLink,
} from '@aeci/shared';
import { CONTEXT_VERSION_PARAM, OTHER_VERSION_PARAM } from '@aeci/shared/version-diff';

import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { fetchPairTimeline } from '../core/api/product-pairs';
import { NotFound } from '../not-found/not-found';
import { mechanismKindLabel } from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { MaintenanceMarker } from '../shared/maintenance-marker/maintenance-marker';
import { VerifiedBadge } from '../shared/verified-badge/verified-badge';

import { AgreementBadge } from './agreement-badge';
import { ClaimProvenance } from './claim-provenance';
import {
  DIRECTION_ORDER,
  directionAria,
  directionGlyph,
  directionHeading,
} from './pair-direction-labels';
import { PairVersionSelect } from './pair-version-select';

/** The two vendor names a pair page can attribute an attestation to, keyed by
 *  the context-relative `attestor` the API resolves (§4.3). Either may be `null`
 *  — `ProductListItem.vendor` is nullable. */
interface PairVendorNames {
  readonly context: string | null;
  readonly other: string | null;
}

/** A claim row with its attribution resolved once, so the template never has to
 *  reach back into the response. */
interface ClaimRow {
  readonly claim: ProductPairClaim;
  /** The vendor named on a `single_source` badge; `null` for every other state
   *  (and when the affirming side has no vendor record). */
  readonly attributedTo: string | null;
  /**
   * AECI-303 (§9.1) diff presentation, all resolved here so the template holds no
   * conditionals. `diffLabel` is `null` for `unchanged` — the overwhelming majority
   * state — and a marker on every row would double the row's badge load and break
   * the "renders identically to today" guarantee.
   */
  readonly diffGlyph: string | null;
  readonly diffLabel: string | null;
  readonly rowClass: string;
  readonly nameClass: string;
}

/**
 * The tonal vocabulary for the diff markers (`DESIGN.md` §5). Borders, not fills,
 * and no new colours:
 *
 *   - `added` takes the Forest **start rule**. Not `--accent-primary-soft`: that wash
 *     belongs to the agreement chip's `confirmed` state, and a wash inches from a
 *     neutral chip would read as "confirmed" by proximity. A single vertical mark is
 *     unmistakably structural rather than a badge, and doubles as a scannable gutter
 *     down the lane.
 *   - `removed` takes a neutral strong rule plus a strikethrough and a step down to
 *     `--text-secondary`. **Never `--status-error`**: `conflict` is the only red in
 *     the system, and a second red on the same row would collapse "vendors disagree"
 *     into "no longer supported".
 *   - Clay is excluded on both counts — `added` is not a warning, and the
 *     Clay-Restriction Rule caps that hue at ≤5% of a screen, which a per-row marker
 *     blows instantly.
 *
 * `--text-secondary` only, never `--text-tertiary`: these rows sit on
 * `--surface-base` inside a `--surface-raised` lane, and the tertiary token's own
 * comment forbids it on sunken/muted surfaces. Logical `border-s-2` keeps the mark
 * on the correct edge under RTL.
 */
const DIFF_ADDED_ROW = 'border-s-2 border-s-(--accent-primary)';
const DIFF_REMOVED_ROW = 'border-s-2 border-s-(--border-strong)';
const DIFF_NAME_DEFAULT = 'text-(--text-primary)';
const DIFF_NAME_REMOVED = 'text-(--text-secondary) line-through';

/** One direction lane of a mechanism's claims — heading/glyph/aria resolved,
 *  empty lanes dropped. Mirrors the AECI-289 prototype's `renderedGroups`. */
interface ClaimGroup {
  readonly direction: ContextDirection;
  readonly heading: string;
  readonly glyph: string;
  readonly aria: string;
  readonly rows: readonly ClaimRow[];
}

/**
 * Name the vendor a `single_source` claim is attributed to: the side whose live
 * attestation affirms, mapped through the API's context-relative `attestor`
 * (§4.3). Only meaningful for `single_source` — `confirmed` needs no name (both
 * vendors agree) and `conflict` names both in the provenance popover instead.
 */
function attributedVendorName(claim: ProductPairClaim, vendors: PairVendorNames): string | null {
  if (claim.agreement !== 'single_source') return null;
  const affirming = claim.attestations.find((a) => a.attestor !== 'aeci' && a.asserted);
  if (!affirming) return null;
  return affirming.attestor === 'context' ? vendors.context : vendors.other;
}

/** Group a mechanism's claims by context-relative direction, in canonical order,
 *  dropping empty lanes. Reuses the file's direction copy helpers so the Layer-A
 *  mechanism arrow and the Layer-B lanes can't drift. */
function buildClaimGroups(
  claims: readonly ProductPairClaim[],
  otherName: string,
  vendors: PairVendorNames,
  selectedVersions: { context: string | null; other: string | null } | null,
): ClaimGroup[] {
  return DIRECTION_ORDER.map((direction) => ({
    direction,
    heading: directionHeading(direction, otherName),
    glyph: directionGlyph(direction),
    aria: directionAria(direction, otherName),
    rows: claims
      .filter((c) => c.direction === direction)
      .map((claim) => buildClaimRow(claim, vendors, selectedVersions)),
  })).filter((g) => g.rows.length > 0);
}

/** Resolve one claim row's attribution and diff presentation (§9.1). */
function buildClaimRow(
  claim: ProductPairClaim,
  vendors: PairVendorNames,
  selectedVersions: { context: string | null; other: string | null } | null,
): ClaimRow {
  const base = { claim, attributedTo: attributedVendorName(claim, vendors) };
  // The version the marker names: whichever side's release the reader is looking at.
  // Both selectors move independently, so name the pair rather than guessing a side.
  const at = selectedVersions
    ? [selectedVersions.context, selectedVersions.other].filter((l): l is string => l !== null)
    : [];
  const version = at.join(' · ');
  if (claim.version_status === 'added') {
    return {
      ...base,
      diffGlyph: '+',
      diffLabel: version
        ? $localize`:@@pair.version.added:New in ${version}:version:`
        : $localize`:@@pair.version.added.bare:New in this version`,
      rowClass: DIFF_ADDED_ROW,
      nameClass: DIFF_NAME_DEFAULT,
    };
  }
  if (claim.version_status === 'removed') {
    return {
      ...base,
      diffGlyph: '−',
      diffLabel: version
        ? $localize`:@@pair.version.removed:Removed in ${version}:version:`
        : $localize`:@@pair.version.removed.bare:Removed in this version`,
      rowClass: DIFF_REMOVED_ROW,
      nameClass: DIFF_NAME_REMOVED,
    };
  }
  // `unchanged`, and the no-diff-applies case: render exactly as before AECI-303.
  return {
    ...base,
    diffGlyph: null,
    diffLabel: null,
    rowClass: '',
    nameClass: DIFF_NAME_DEFAULT,
  };
}

/** Sync-headline breadth line (§3.5), pluralised. */
function syncHeadlineText(total: number): string {
  return total === 1
    ? $localize`:@@pair.dataflow.headline.one:1 data object syncs`
    : $localize`:@@pair.dataflow.headline.other:${total}:count: data objects sync`;
}

/**
 * The muted verification ratio (§3.5, widened by §4.3) — never a hero trust
 * stat. Two clauses, because bilateral and one-sided verification must not be
 * added together: folding a lone vendor's affirmation into the "vendor-confirmed"
 * figure is exactly the overstatement `STAGE_2_SPEC.md` §8.1(4) forbids. The
 * second clause is omitted entirely at zero rather than rendered as "0".
 */
function confirmedRatioText(confirmed: number, total: number, singleSource: number): string {
  const bilateral = $localize`:@@pair.dataflow.ratio:${confirmed}:confirmed: of ${total}:total: vendor-confirmed`;
  if (singleSource === 0) return bilateral;
  const oneSided = $localize`:@@pair.dataflow.ratio.singleSource:${singleSource}:count: confirmed by one vendor only`;
  return `${bilateral} · ${oneSided}`;
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
   *  navigates to the connector's own pages instead of being dead text.
   *
   *  `poweredByProduct` is the UNION of the payload's `powered_by_product` and
   *  `via` (AECI-721) — the same fact carried by rows in the two delivered-tier
   *  tables. The view model deliberately collapses them: which table an edge
   *  lives in is a storage question the reader has no stake in. */
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
  /** True while no vendor has said anything about any claim on this pair — the
   *  Stage 1.5 posture, and the only time every attestation on the pair is
   *  AECi's, which is exactly what the "asserted by AECi" subline claims. */
  readonly awaitingVendors: boolean;
  /** The two vendor names attestations are attributed to (§4.3). */
  readonly vendorNames: PairVendorNames;
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
    PairVersionSelect,
    RouterLink,
    VerifiedBadge,
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
              <!-- The trail is Home › {context} › Integrations › {other}. Without the
                   "Integrations" crumb the last two read as a parent/child pair, which
                   says the OTHER product belongs to the context product rather than
                   that this page is one edge in the context product's integration
                   list. The crumb deep-links to that list's section anchor on the
                   context product's detail page. -->
              <li>
                <a
                  [routerLink]="['/products', context.slug]"
                  fragment="integrations"
                  class="no-underline hover:text-(--accent-primary)"
                  i18n="@@pair.breadcrumb.integrations"
                  >Integrations</a
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
                <!-- One header marker for the whole pair; computePairMaintenance
                     folds the N mechanisms server-side (AECI-616). Distinct from the
                     per-claim agreement badge on the mechanism cards below: this says
                     who is on the hook for the page, that says whether the two vendors
                     agree about one data object. -->
                <aec-maintenance-marker
                  [maintainedBy]="v.pair.maintenance.maintained_by"
                  [reviewedAt]="v.pair.maintenance.last_reviewed_at"
                />
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
                <span class="inline-flex items-center gap-1.5 text-xs text-(--text-tertiary)">
                  {{ context.vendor.name }}
                  <aec-verified-badge [verified]="context.vendor.verified" variant="compact" />
                </span>
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
                <span class="inline-flex items-center gap-1.5 text-xs text-(--text-tertiary)">
                  {{ other.vendor.name }}
                  <aec-verified-badge [verified]="other.vendor.verified" variant="compact" />
                </span>
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

            <!-- AECI-303 (§9.1): the two version selectors, as a SECOND grid row so
                 each sits under its own product column, which is what lets the
                 label be the product's own name instead of disambiguating copy.
                 A second row rather than nesting inside the cells above is
                 required, not stylistic: those cells are anchors with routerLink,
                 and an interactive combobox inside an anchor is invalid HTML that
                 would navigate on click. It also keeps the two logos aligned when
                 only one side has a selector. Renders nothing at all when the diff
                 does not apply: the whole suppression rule is a null versionView. -->
            @if (versionView(); as vv) {
              <div class="flex justify-center">
                @if (vv.contextOptions.length > 1) {
                  <aec-pair-version-select
                    side="context"
                    [label]="versionLabelFor(context.name)"
                    [options]="vv.contextOptions"
                    [value]="vv.selectedContext"
                    (changed)="setVersion('context', $event)"
                  />
                }
              </div>
              <span aria-hidden="true"></span>
              <div class="flex justify-center">
                @if (vv.otherOptions.length > 1) {
                  <aec-pair-version-select
                    side="other"
                    [label]="versionLabelFor(other.name)"
                    [options]="vv.otherOptions"
                    [value]="vv.selectedOther"
                    (changed)="setVersion('other', $event)"
                  />
                }
              </div>
            }
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
              <!-- Attribution, not a count: the ratio line below already says how
                   many are vendor-confirmed, so this line says who asserted them.
                   Only true while every attestation on the pair is AECi's. -->
              @if (v.awaitingVendors) {
                <p
                  class="mt-2 text-sm text-(--text-secondary)"
                  i18n="@@pair.dataflow.subline.aeciAsserted"
                >
                  These flows are asserted by AECi.
                </p>
              }
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
              <p
                class="mt-2 text-sm text-(--text-secondary)"
                i18n="@@pair.dataflow.empty.subline.cataloguing"
              >
                We’re cataloguing what each integration syncs.
              </p>
            }

            <!-- AECI-303 (§9.1): what the selected version pair changed. Lives in the
                 band because the band already owns "what syncs"; the per-row markers
                 below say which flows. Only rendered when there IS a previous pair
                 to compare against; the earliest pair is a baseline, not a diff. -->
            @if (versionView(); as vv) {
              @if (vv.previousSummary) {
                <p class="mt-4 text-xs text-(--text-secondary)">
                  <span>{{ vv.previousSummary }}</span>
                  @if (vv.changeSummary) {
                    <span class="tabular-nums"> · {{ vv.changeSummary }}</span>
                  }
                </p>
              }
              <!-- The reader's way home from a deep-linked historical URL. Without
                   it a shared non-default link is a dead end. -->
              @if (!vv.isDefault) {
                <button
                  type="button"
                  (click)="showLatest()"
                  class="mt-3 rounded-(--radius-sm) text-xs font-medium text-(--accent-primary)
                    underline underline-offset-2 focus-visible:outline-2
                    focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@pair.version.showLatest"
                >
                  Show the latest versions
                </button>
              }
            }
          </div>

          <!-- Per-mechanism cards with the context-relative direction arrow. -->
          <div class="mt-8 space-y-6">
            @for (m of v.mechanisms; track m.id) {
              <article
                class="space-y-4 rounded-(--radius-xl) border border-(--border-default) bg-(--surface-base) p-6"
              >
                <header class="flex flex-wrap items-center gap-3">
                  @if (m.name) {
                    @if (m.kindLabel) {
                      <span
                        class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em] text-(--text-secondary)"
                        >{{ m.kindLabel }}</span
                      >
                    }
                    <h2 class="font-display text-xl text-(--text-primary)">{{ m.name }}</h2>
                  } @else {
                    <!-- No mechanism name: promote the kind label to the card
                         heading so the Layer-B lane h3s below never skip from the
                         page h1 straight to h3. Falls back to a generic title when
                         the kind enum is also absent/unknown (kindLabel === ''). -->
                    <h2
                      class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em] text-(--text-secondary)"
                    >
                      @if (m.kindLabel) {
                        {{ m.kindLabel }}
                      } @else {
                        <ng-container i18n="@@pair.mechanism.untitled">Integration</ng-container>
                      }
                    </h2>
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
                        <ng-container i18n="@@pair.mechanism.builtBy">Built by</ng-container>&ngsp;
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
                        <ng-container i18n="@@pair.mechanism.poweredBy">Powered by</ng-container
                        >&ngsp;
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
                        @for (
                          r of g.rows;
                          track r.claim.data_object_slug + '|' + r.claim.direction
                        ) {
                          <!-- AECI-303 (§9.1): the diff marker sits at the row START,
                               never in the right-hand cluster. Separation by POSITION
                               is what keeps it from competing with the agreement
                               badge: left = what changed in this version, right = who
                               agrees about it. Two questions, two zones. -->
                          <li
                            class="flex items-center justify-between gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2"
                            [class]="r.rowClass"
                          >
                            <span class="flex min-w-0 flex-col gap-0.5">
                              <span class="text-sm" [class]="r.nameClass">{{
                                r.claim.data_object_name
                              }}</span>
                              @if (r.diffLabel) {
                                <span class="flex items-center gap-1">
                                  <!-- Glyph AND text AND (for removed) a decoration
                                       change: never colour-only (WCAG 1.4.1). -->
                                  <span
                                    aria-hidden="true"
                                    class="text-xs text-(--text-secondary)"
                                    >{{ r.diffGlyph }}</span
                                  >
                                  <span class="aec-overline text-(--text-secondary)">{{
                                    r.diffLabel
                                  }}</span>
                                </span>
                              }
                            </span>
                            <span class="flex items-center gap-2">
                              <aec-agreement-badge
                                [agreement]="r.claim.agreement"
                                [attributedTo]="r.attributedTo"
                              />
                              <aec-claim-provenance
                                [claim]="r.claim"
                                [contextVendorName]="v.vendorNames.context"
                                [otherVendorName]="v.vendorNames.other"
                                [timeline]="timelineFor(r.claim.id)"
                                (historyRequested)="loadTimeline()"
                              />
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
  private readonly http = inject(HttpClient);

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
    const { total, confirmed, single_source: singleSource } = pair.sync_headline;
    const vendorNames: PairVendorNames = {
      context: pair.context_product.vendor?.name ?? null,
      other: pair.other_product.vendor?.name ?? null,
    };
    const mechanisms = pair.mechanisms.map((m) => this.toMechanismView(m, otherName, vendorNames));
    return {
      pair,
      mechanisms,
      syncTotal: total,
      syncHeadline: syncHeadlineText(total),
      confirmedRatio: confirmedRatioText(confirmed, total, singleSource),
      // Keyed off the presence of a vendor attestation, not off the agreement
      // state: a claim every vendor *denied* is still `unverified`, but a vendor
      // HAS spoken, so "these flows are asserted by AECi" would no longer be the
      // whole provenance of the pair.
      // (AECI-781 replaced the copy; the gate it justifies is unchanged.)
      awaitingVendors: pair.mechanisms.every((m) =>
        m.claims.every((c) => c.attestations.every((a) => a.attestor === 'aeci')),
      ),
      vendorNames,
      hasDetail: mechanisms.some(
        (m) => m.claimGroups.length > 0 || (m.direction !== null && !m.hasClaims),
      ),
    };
  });

  private toMechanismView(
    m: ProductPairMechanism,
    otherName: string,
    vendorNames: PairVendorNames,
  ): MechanismView {
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
      claimGroups: buildClaimGroups(
        m.claims,
        otherName,
        vendorNames,
        this.pair()?.version_diff?.selected ?? null,
      ),
      hasClaims: m.claims.length > 0,
      builtByVendor: m.built_by_vendor,
      // `via` first (AECI-721). The two fields are the same fact about rows in
      // different tables — `powered_by_product` for an `integrations` row that
      // still carries the FK, `via` for a connector-evidenced pair — and they are
      // never both set, so the coalesce is a union, not a precedence rule. Reading
      // only `powered_by_product` would leave the 19 migrated pairs naming no
      // connector at all, on the one surface whose whole subject is the connector.
      poweredByProduct: m.via ?? m.powered_by_product,
    };
  }

  protected ratingAria(product: ProductPairResponse['context_product']): string {
    const avg = product.rating_overall_avg?.toFixed(1) ?? '';
    return $localize`:@@pair.rating.aria:${product.name}:name: rated ${avg}:rating: out of 5 from ${product.review_count}:count: reviews`;
  }

  // ── AECI-303 (§9): the version selectors + the diff summary ────────────────

  /**
   * The selectors' view-model, or `null` when the §9 diff does not apply.
   *
   * The null is the WHOLE suppression rule and it is the API's decision, not a
   * browser derivation: `version_diff` is null unless a release exists AND a live
   * attestation on the pair is version-stamped. That makes "latest × latest renders
   * identically to today for claims with no version data" structural — at launch no
   * pair has releases, so no selector chrome exists to get wrong.
   *
   * A side with fewer than two releases still renders no selector (see the template):
   * a one-option combobox is the no-op control `hasDetail` already exists to
   * suppress, and a *disabled* control is worse than none.
   */
  protected readonly versionView = computed(() => {
    const diff = this.pair()?.version_diff;
    if (!diff) return null;
    const toOptions = (versions: readonly { label: string; released_at: string | null }[]) =>
      versions.map((v) => ({ label: v.label, releasedAt: v.released_at }));
    return {
      contextOptions: toOptions(diff.context_versions),
      otherOptions: toOptions(diff.other_versions),
      // What the server RESOLVED, never the raw query param — a stale label
      // degrades to latest and the control must show what is actually rendered.
      selectedContext: diff.selected.context,
      selectedOther: diff.selected.other,
      isDefault: diff.is_default,
      previousSummary: previousPairSummary(diff.previous),
      changeSummary: changeCountsSummary(diff.counts),
    };
  });

  protected versionLabelFor(productName: string): string {
    return $localize`:@@pair.version.label:${productName}:product: version`;
  }

  /**
   * Write a selector change to the URL, which re-runs the resolver and refetches.
   *
   * Mirrors `setView` minus the cookie — deliberately. `aeci_pair_view` works because
   * Basic/Detailed is a global, product-independent preference; a remembered `2026.1`
   * is meaningless on a different pair, §9.3's invariant is that the reader lands on
   * the LATEST view, and the cookie's cache-safety proof (written on click, read only
   * post-hydration) would mean a content change plus a robots-tag flip *after* the
   * crawler read the head.
   */
  protected setVersion(side: 'context' | 'other', label: string): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        [side === 'context' ? CONTEXT_VERSION_PARAM : OTHER_VERSION_PARAM]: label,
      },
      queryParamsHandling: 'merge',
    });
  }

  /** Clear both selectors — the way home from a deep-linked historical URL. */
  protected showLatest(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [CONTEXT_VERSION_PARAM]: null, [OTHER_VERSION_PARAM]: null },
      queryParamsHandling: 'merge',
    });
  }

  // ── AECI-303 (§9.1): the lazy per-claim history ────────────────────────────

  /**
   * Per-claim attestation history, keyed by claim id. Fetched **once, from the
   * browser only, on the first provenance-popover open** — never during SSR.
   *
   * That is not laziness for its own sake: history is the gateable depth (§9.3), and
   * the pair page is stored in a shared, URL-keyed edge cache. AECI-304 settled the
   * gate on the PAIR'S vendors rather than the reader, so it stays URL-derived and
   * §9.1a holds — but the split is still the right one: `/api/*` responses are
   * `private, no-store`, and this is the only unbounded payload in the system, since
   * the append-only log grows forever.
   */
  private readonly timelines = signal<ReadonlyMap<string, ClaimTimeline> | null>(null);
  private timelineRequested = false;

  protected timelineFor(claimId: string | undefined): ClaimTimeline | null {
    if (!claimId) return null;
    return this.timelines()?.get(claimId) ?? null;
  }

  /**
   * Fetch the pair's histories on the first popover open. One request serves every
   * popover on the page, which is why the endpoint is pair-scoped rather than
   * claim-scoped.
   *
   * Called from a click handler, never an `effect()` — the popover it feeds is a
   * `BrnPopover`, and opening one from a reactive context throws NG0602.
   */
  protected loadTimeline(): void {
    if (this.timelineRequested) return;
    const pair = this.pair();
    if (!pair) return;
    this.timelineRequested = true;
    void fetchPairTimeline(this.http, pair.context_product.slug, pair.other_product.slug).then(
      (response) => {
        if (!response) return;
        this.timelines.set(new Map(response.claims.map((c) => [c.claim_id, c])));
      },
    );
  }
}

/** "Changes from 2026.9 · v4" — the pair the diff is measured against (§9.1).
 *  `null` at the earliest pair, which is a baseline rather than a diff. */
function previousPairSummary(
  previous: { context: string | null; other: string | null } | null,
): string | null {
  if (!previous) return null;
  const labels = [previous.context, previous.other].filter((l): l is string => l !== null);
  if (labels.length === 0) return null;
  const from = labels.join(' · ');
  return $localize`:@@pair.version.changesFrom:Changes from ${from}:from:`;
}

/** "2 added · 1 removed", omitting a zero clause rather than rendering "0". */
function changeCountsSummary(counts: { added: number; removed: number }): string | null {
  const parts: string[] = [];
  if (counts.added > 0) {
    parts.push($localize`:@@pair.version.addedCount:${counts.added}:count: added`);
  }
  if (counts.removed > 0) {
    parts.push($localize`:@@pair.version.removedCount:${counts.removed}:count: removed`);
  }
  return parts.length ? parts.join(' · ') : null;
}
