import { formatDate } from '@angular/common';
import { Component, LOCALE_ID, afterNextRender, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import { canonicalPairIds, distinctDataObjectSlugs, isHttpUrl } from '@aeci/shared';
import type {
  ContextDirection,
  FieldCorrection,
  ProductLink,
  ProductPairClaim,
  ProductPairMechanism,
  ProductPairResponse,
  VendorLink,
} from '@aeci/shared';
import { CONTEXT_VERSION_PARAM, OTHER_VERSION_PARAM } from '@aeci/shared/version-diff';

import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { NotFound } from '../not-found/not-found';
import {
  contextDirectionLabel,
  dataObjectCountLabel,
  mechanismKindLabel,
  type ContextDirectionLabel,
} from '../search/mechanism-labels';
import { correctionLabel } from '../shared/field-caption/correction-labels';
import type { FieldCaptionPage } from '../shared/field-caption/field-caption';
import { correctionsInSlots, isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import {
  ListingProvenance,
  type ProvenanceCorrection,
  type ProvenanceGroup,
} from '../shared/listing-provenance/listing-provenance';
import { Analytics } from '../analytics/analytics';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

import { AgreementBadge } from './agreement-badge';
import { ClaimProvenance } from './claim-provenance';
import { DIRECTION_ORDER, directionGlyph, directionHeading } from './pair-direction-labels';
import type { PairPageData } from '../core/api/product-pairs';
import { PairEmptyAlternatives } from './pair-empty-alternatives';
import { PairEmptySections, emptyPairProvenance } from './pair-empty-sections';
import { PairEmptyStage } from './pair-empty-stage';
import { RequestDrawer } from '../requests/request-drawer';
import { RequestTrigger } from '../requests/request-trigger';
import { AecButton } from '../shared/button/button';
import { PairVersionSelect } from './pair-version-select';
import { Chip } from '../shared/chip/chip';
import { AecBreadcrumb, homeCrumb, type BreadcrumbItem } from '../shared/breadcrumb/breadcrumb';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { AecCard } from '../shared/card/card';
import { HeroBand } from '../shared/hero-band/hero-band';
import { AecIcon } from '../shared/icon/icon';

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
 * on the correct edge under RTL. The edge colour is an unlayered class in styles.css
 * (`.aec-diff-added`, `.aec-diff-removed`). It was written while a border-colour utility
 * lost to the then-unlayered `* { border-color }` rule (AECI-1798 review; the rule moved
 * to `@layer base` in AECI-2088).
 */
const DIFF_ADDED_ROW = 'border-s-2 aec-diff-added';
const DIFF_REMOVED_ROW = 'border-s-2 aec-diff-removed';
const DIFF_NAME_DEFAULT = 'text-(--text-primary)';
const DIFF_NAME_REMOVED = 'text-(--text-secondary) line-through';

/** One direction lane of a mechanism's claims — heading/glyph/aria resolved,
 *  empty lanes dropped. Mirrors the AECI-289 prototype's `renderedGroups`. */
interface ClaimGroup {
  readonly direction: ContextDirection;
  readonly heading: string;
  readonly glyph: string;
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

/** Sync-headline breadth line (§3.5), pluralised. Reader wording since
 *  AECI-1142: "types of data shared", not the model's "data objects sync". */
function syncHeadlineText(total: number): string {
  return total === 1
    ? $localize`:@@pair.dataflow.headline.one:1 type of data shared`
    : $localize`:@@pair.dataflow.headline.other:${total}:count: types of data shared`;
}

/**
 * The data section heading and subline when the pair has no claims yet (AECI-919
 * picks between the two forks). Resolved in TypeScript so the template holds one
 * heading element for both the counted and the empty state.
 */
function emptyBandCopy(
  directional: boolean,
  refutedOnly: boolean,
): { headline: string; subline: string } {
  // AECI-1140: every listed claim is one a company says no to, so none is counted.
  // "Haven't listed" would deny the rows below it. Wins over the directional fork,
  // which is only reached when a mechanism has no claims.
  if (refutedOnly) {
    return {
      headline: $localize`:@@pair.dataflow.empty.refuted:No type of data is confirmed`,
      subline: $localize`:@@pair.dataflow.empty.subline.refuted:A company says the types of data listed for these products aren’t shared.`,
    };
  }
  return directional
    ? {
        headline: $localize`:@@pair.dataflow.empty.directional:We haven’t listed the types of data yet`,
        subline: $localize`:@@pair.dataflow.empty.subline.directional:The direction is shown below. The types of data aren’t listed yet.`,
      }
    : {
        headline: $localize`:@@pair.dataflow.empty:We haven’t listed what’s shared yet`,
        subline: $localize`:@@pair.dataflow.empty.subline.cataloguing:We’re listing what each integration shares.`,
      };
}

/** "How you get it": the delivery kind, and who offers it or which connector
 *  carries it. Links stay links, so this is structured rather than one string. */
interface GlanceHow {
  /** `''` when the kind is absent, or already the card's h2 (no mechanism name). */
  readonly kind: string;
  /** Stage 1 §4.4 "Offered by": the vendor that OWNS the integration (the one a
   *  customer pays for it or gets it from), not whoever wrote the code. The
   *  `built_by_vendor_id` column name predates that ruling (AECI-1021). */
  readonly offeredBy: VendorLink | null;
  /** The connector that carries it: the UNION of `via` and `powered_by_product`
   *  (AECI-721), the same fact on rows in the two delivered-tier tables, never
   *  both set. Linked so the reader can reach the connector's own page. */
  readonly through: ProductLink | null;
  /** AECI-1011: a vendor created this row in its portal (`origin: 'vendor'`). */
  readonly vendorAdded: boolean;
}

/**
 * One card's "At a glance" facts (AECI-1142). Per card, not per
 * page: price, release stage, delivery and review date are columns of ONE
 * integration row, so a pair with a native connector and a Zapier app has two
 * of each. A fact is `null` when its source is empty; the row hides when all are.
 */
interface GlanceFacts {
  readonly price: string | null;
  /** AECI-1158: the owner's pricing page (`pricing_url`), http(s) only. It links
   *  the price text, or stands alone as "See pricing" when there is no price. */
  readonly priceUrl: string | null;
  /** AECI-933: ownership facts for the price link click. The owner's own page, so
   *  it is the row's `built_by_vendor`. `null` exactly when `priceUrl` is. */
  readonly priceLinkContext: ExternalLinkContext | null;
  readonly stage: string | null;
  readonly how: GlanceHow | null;
  readonly lastChecked: string | null;
}

/** One external link on a mechanism card, label already localized. */
interface MechanismLink {
  readonly href: string;
  readonly label: string;
  /** AECI-933: whose link it is and whose site it leads to, for the click event. */
  readonly context: ExternalLinkContext;
  /** AECI-1614: "Link from {vendor}" on an endpoint vendor's own link. Since AECI-1666
   *  it always shows there: the card no longer carries a caption naming the vendor. */
  readonly linkFrom: string | null;
}

/**
 * The page-level facts every outbound click on the pair page carries (AECI-933).
 * Each side's owner is that product's primary vendor. `pairKey` is the canonical
 * pair id, the same from either URL orientation.
 */
interface PairLinkOwners {
  readonly context: string | null;
  readonly other: string | null;
  readonly contextName: string | null;
  readonly otherName: string | null;
  readonly pairKey: string;
}

/** A pair page click's context, from its owner, origin and purpose. */
function pairLinkContext(
  owners: PairLinkOwners,
  owner: string | null,
  origin: ExternalLinkContext['link_origin'],
  purpose: ExternalLinkContext['link_purpose'],
): ExternalLinkContext {
  return {
    owner_vendor_id: owner,
    link_origin: origin,
    source_entity_type: 'pair',
    source_entity_id: owners.pairKey,
    link_purpose: purpose,
  };
}

/** Whose name labels a side's own link: its product. The link is stored per
 *  product, and one company can own both sides (AECI-1141). */
interface PairSideNames {
  readonly context: string;
  readonly other: string;
}

/**
 * Whether an endpoint vendor's own link of this kind shows on the card, in place of AECi's
 * curated one (AECI-1007). `mechanismLinks` renders by it, and the panel's correction
 * slots read it, so a replaced curated link never takes a line (§4.5.8).
 */
function vendorLinkFillsSlot(m: ProductPairMechanism, kind: 'listing_url' | 'docs_url'): boolean {
  return !!m.vendor_links?.context?.[kind] || !!m.vendor_links?.other?.[kind];
}

/**
 * The mechanism card's external links (AECI-1007). Per kind, each endpoint vendor's
 * OWN link wins and is labelled with that side's product name, context side first. Only
 * when neither side has set that kind does the card fall back to AECi's curated
 * `listing_url` / `docs_url`, under the unlabelled copy it always had. Listing links
 * come before docs links, as they did before.
 */
function mechanismLinks(
  m: ProductPairMechanism,
  names: PairSideNames,
  owners: PairLinkOwners,
): MechanismLink[] {
  // `?.` because the SSR Worker may read an API that predates the field, and the
  // response is not re-parsed through the schema default on every path.
  const sides = [
    {
      links: m.vendor_links?.context ?? null,
      name: names.context,
      owner: owners.context,
      vendor: owners.contextName,
    },
    {
      links: m.vendor_links?.other ?? null,
      name: names.other,
      owner: owners.other,
      vendor: owners.otherName,
    },
  ];
  const linkFrom = (vendor: string | null): string | null =>
    vendor ? $localize`:@@pair.mechanism.linkFrom:Link from ${vendor}:VENDOR:` : null;
  // AECI-933: a curated link leads to whoever built the row, else the connector's
  // vendor. `connector_vendor_id` is absent on an older API, which reads as unknown.
  const curatedOwner = m.built_by_vendor?.id ?? m.connector_vendor_id ?? null;
  const out: MechanismLink[] = [];
  if (vendorLinkFillsSlot(m, 'listing_url')) {
    for (const side of sides.filter((s) => s.links?.listing_url)) {
      out.push({
        href: side.links!.listing_url!,
        label: $localize`:@@pair.mechanism.listingBy:${side.name}:product: listing`,
        context: pairLinkContext(owners, side.owner, 'vendor', 'listing'),
        linkFrom: linkFrom(side.vendor),
      });
    }
  } else if (m.listing_url) {
    out.push({
      href: m.listing_url,
      label: $localize`:@@pair.mechanism.listing:View listing`,
      context: pairLinkContext(owners, curatedOwner, 'aeci', 'listing'),
      linkFrom: null,
    });
  }
  if (vendorLinkFillsSlot(m, 'docs_url')) {
    for (const side of sides.filter((s) => s.links?.docs_url)) {
      out.push({
        href: side.links!.docs_url!,
        label: $localize`:@@pair.mechanism.docsBy:${side.name}:product: documentation`,
        context: pairLinkContext(owners, side.owner, 'vendor', 'docs'),
        linkFrom: linkFrom(side.vendor),
      });
    }
  } else if (m.docs_url) {
    out.push({
      href: m.docs_url,
      label: $localize`:@@pair.mechanism.docs:Documentation`,
      context: pairLinkContext(owners, curatedOwner, 'aeci', 'docs'),
      linkFrom: null,
    });
  }
  return out;
}

/**
 * What "About this listing" holds on a pair page (AECI-1666). Every caption on every
 * mechanism, and each card's corrections that point at something it renders
 * (`MechanismView.corrections`), since the cards no longer carry them. The under-review
 * count is the card's own markers. With more than one
 * mechanism each line is prefixed with the card's heading, so a reader can tell which card
 * it speaks for. With one, the field name alone.
 *
 * `claimed`: a pair is claimed when either product is. Only an endpoint vendor or the
 * integration's owner can make a pair row vendor-maintained, and a vendor that holds
 * neither product holds no listing here.
 */
function pairProvenance(
  pair: ProductPairResponse,
  mechanisms: readonly MechanismView[],
): PairProvenance {
  const several = pair.mechanisms.length > 1;
  const groups: ProvenanceGroup[] = [];
  const corrections: ProvenanceCorrection[] = [];
  pair.mechanisms.forEach((m, index) => {
    const view = mechanisms[index];
    const heading =
      view?.name || view?.kindLabel || $localize`:@@pair.provenance.untitled:Integration`;
    if (m.caption) groups.push({ label: several ? heading : null, caption: m.caption });
    for (const correction of view?.corrections ?? []) {
      const field = correctionLabel(correction.field);
      corrections.push({
        correction,
        label: several
          ? $localize`:@@pair.provenance.mechanismField:${heading}:MECHANISM:, ${field}:FIELD:`
          : field,
      });
    }
  });
  return {
    claimed:
      pair.context_product.claim_status !== 'unclaimed' ||
      pair.other_product.claim_status !== 'unclaimed',
    groups,
    corrections,
    // The card's own markers: the description's, then one per other hidden value.
    underReviewCount: mechanisms.reduce(
      (n, view) => n + (view.descriptionUnderReview ? 1 : 0) + view.underReview.length,
      0,
    ),
  };
}

/** One mechanism with its direction copy resolved against the `other` product. */
interface MechanismView {
  readonly id: string;
  readonly kindLabel: string;
  readonly name: string | null;
  readonly description: string | null;
  /** Listing and docs links, vendor-own first per kind, AECi-curated as fallback. */
  readonly links: readonly MechanismLink[];
  readonly direction: ContextDirection | null;
  readonly glyph: string;
  readonly directionLabel: string;
  /**
   * AECI-711 depth axis, rendered in the card header beside the mechanism badge.
   * `depthDirection` is the claims-aware `effective_direction` (the product row's
   * rule), with a `null` token when there is neither claim nor stored direction.
   * `dataObjectLabel` is `''` when the mechanism has no claims. Each chip renders
   * only when present (the 2026-09-22 ruling: no "not specified" marker).
   */
  readonly depthDirection: ContextDirectionLabel;
  readonly dataObjectLabel: string;
  /** Data-object claim lanes (§8). Empty when the mechanism has no claims yet. */
  readonly claimGroups: readonly ClaimGroup[];
  readonly hasClaims: boolean;
  /** AECI-1142 "At a glance" facts, or `null` when every fact is empty. */
  readonly glance: GlanceFacts | null;
  /** The mechanism's corrections that point at something the card renders (§4.5.8). */
  readonly corrections: readonly FieldCorrection[];
  /** AECI-1238 (§11d.7): AECi hid the description while it checks it. */
  readonly descriptionUnderReview: boolean;
  /** AECI-1238: the card's other values AECi hid, each named, since its slot is gone. */
  readonly underReview: readonly { field: string; label: string }[];
}

/** What the pair page's "About this listing" panel holds (AECI-1666). */
interface PairProvenance {
  readonly claimed: boolean;
  readonly groups: readonly ProvenanceGroup[];
  readonly corrections: readonly ProvenanceCorrection[];
  readonly underReviewCount: number;
}

interface PairView {
  readonly pair: ProductPairResponse;
  /** The page, for a correction's source link click. */
  readonly captionPage: FieldCaptionPage;
  readonly provenance: PairProvenance;
  readonly mechanisms: readonly MechanismView[];
  /** Distinct data objects across the pair (§3.5). Drives the section heading. */
  readonly syncTotal: number;
  readonly syncHeadline: string;
  /** The two vendor names attestations are attributed to (§4.3). */
  readonly vendorNames: PairVendorNames;
  /** True when some mechanism carries a Layer-B claim lane or a Layer-A direction
   *  arrow — i.e. there is detail for the Basic view to hide. Gates the toggle so
   *  a pair with nothing to collapse doesn't show a no-op control. */
  readonly hasDetail: boolean;
  /** True when some mechanism renders a **standalone Layer-A direction arrow** —
   *  the `!hasClaims && direction` condition the per-mechanism card applies. The
   *  narrower sibling of `hasDetail`, which also counts Layer-B claim lanes.
   *
   *  It exists to pick the empty section heading's copy (AECI-919): the heading
   *  counts Layer-B claims, so it goes empty while a direction is plainly
   *  documented just below it, and the original "Data flows aren't documented yet"
   *  contradicted the arrow it sat above. Keep it distinct from `hasDetail`: a pair
   *  whose only detail is claim lanes never shows the empty copy (`syncTotal > 0`). */
  readonly hasLayerADirection: boolean;
  /** True when the heading counts nothing but some claim still renders, because
   *  every one a company says no to (AECI-1140). Picks the refuted empty copy, so
   *  the heading never says "haven't listed" above listed rows. */
  readonly hasRefutedOnly: boolean;
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
 * direction lanes with neutral "Listed by AEC Integrations" badges + a "Sources"
 * popover, under an "N types of data shared" heading (§3.5 as amended by
 * AECI-1142). Each card carries an "At a glance" strip. A mechanism with no claims
 * yet (or a pair with none) falls back to the Layer-A arrow + the empty heading.
 *
 * Since AECI-1798 (mock-up 12) the page opens on the shared Forest hero band: the
 * statement h1 and the two products as its diagram. The data band below holds the h2,
 * the toggle and the cards (h3), whose lanes and At a glance strips are h4.
 *
 * A **Basic/Detailed** disclosure toggle sits beside the data h2 (URL `?view=`, default
 * `detailed`). Basic (Overview) keeps the rail, sync headline, and each
 * mechanism's kind/name/description/links; it hides the Layer-B claim lanes and
 * the standalone Layer-A arrow (the granular data transfers). `view` is
 * content-affecting and forked in the edge cache key (mirrors AECI-190's
 * `/products ?view=table`); the toggle is suppressed when there's no detail to hide.
 *
 * Data comes from `productsPairResolver` via `route.data['pair']`:
 *   - `null` → the global `aec-not-found` shell (the resolver set
 *     `RESPONSE_INIT.status = 404` + `setNotFoundMeta`).
 *   - set → the rail + section heading + mechanism cards.
 *
 * No JSON-LD (§9.2 defers integration structured data to Stage 2). Cache tags
 * are written by the SSR runtime (the path matcher emits `route:detail` +
 * `pair:{min}__{max}` + both `product:` tags; the resolver pushes per-mechanism
 * vendor / connector tags).
 */
@Component({
  selector: 'aec-products-pair',
  imports: [
    AecBreadcrumb,
    AecCard,
    AecIcon,
    HeroBand,
    UnderReviewMarker,
    AgreementBadge,
    ClaimProvenance,
    ExternalLinkTracker,
    LogoOrInitial,
    UnclaimedNote,
    ListingProvenance,
    MailingListSignup,
    NewTabIcon,
    NotFound,
    PairVersionSelect,
    RouterLink,
    Chip,
    PairEmptySections,
    PairEmptyAlternatives,
    PairEmptyStage,
    AecButton,
    RequestTrigger,
    RequestDrawer,
  ],
  template: `
    @let v = view();
    @if (v === null) {
      <aec-not-found />
    } @else {
      @let context = v.pair.context_product;
      @let other = v.pair.other_product;
      <!-- AECI-1798: mock-up 12. The Forest hero carries the statement and the two products
           as its diagram. The data band is white, and the mailing list is the page's one
           Bone band (ruling 12 of 2026-11-16). The pair page keeps its own shell: it is not
           on DetailLayout, which has a facts card the pair page does not. -->
      <aec-hero-band
        [titleSize]="v.mechanisms.length > 0 ? 'statement' : 'statement-wide'"
        panel="bare"
        [panelFrom]="v.mechanisms.length > 0 ? 'lg' : 'wide'"
        [bottom]="v.mechanisms.length > 0 ? 'overlap' : 'band'"
      >
        <aec-breadcrumb heroCrumbs tone="on-brand" [items]="crumbs()" />

        <div heroKicker class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <!-- AECI-1827, ruling 98: the empty pair drops the word, so "Integration" never
               sits directly above "We have no integration". -->
          @if (v.mechanisms.length > 0) {
            <p class="aec-overline text-(--text-on-brand-secondary)" i18n="@@pair.eyebrow">
              Integration
            </p>
          } @else {
            <!-- AECI-1835: mock-up 5's status pill, above the statement it summarises. -->
            <span
              class="inline-flex items-center gap-3 rounded-pill bg-(--surface-on-brand-wash) py-2 ps-2 pe-4 text-t-14 font-semibold text-(--text-on-brand)"
              data-testid="pair-empty-status"
            >
              <span
                class="grid size-6.5 place-items-center rounded-full bg-(--surface-on-brand-wash-hover)"
                ><aec-icon name="unlink" decorative [size]="4"
              /></span>
              <span i18n="@@pair.empty.status">Not on record</span>
            </span>
          }
          <!-- AECI-1666: the header's maintenance chip is retired. Its words open "About
               this listing" after the cards, or at the end of an empty pair's body. -->
        </div>

        <!-- The h1 keeps its words (ruling 8). The names are Bone at 600, the rest of the
             statement at 400. The band puts the Statement size on its inner span. -->
        @if (v.mechanisms.length > 0) {
          <span heroTitle i18n="@@pair.heading"
            >How <span class="font-semibold">{{ context.name }}</span> and
            <span class="font-semibold">{{ other.name }}</span> exchange data</span
          >
        } @else {
          <!-- AECI-1827: the empty pair (STAGE_1_5_SPEC.md section 11.4). The statement is
               the legal-reviewed string, used exactly, and the caveat always follows it. -->
          <span heroTitle data-testid="pair-empty-statement" i18n="@@pair.empty.statement"
            >We have no integration between
            <span [class]="statementName(context.name)">{{ context.name }}</span> and
            <span [class]="statementName(other.name)">{{ other.name }}</span> on record.</span
          >
        }
        <!-- The caveat, in the band's default slot directly under the statement. Its own
             block: content projection matches only a control-flow block with one root. -->
        @if (caveatShown()) {
          <div data-testid="pair-empty-lede">
            <!-- The caveat, word for word. The first sentence is the mock-up's strong. -->
            <p
              class="max-w-[36em] text-t-16 leading-normal text-(--text-on-brand-secondary) md:text-t-20"
            >
              <span data-testid="pair-empty-caveat" i18n="@@pair.empty.caveat"
                ><strong class="font-semibold text-(--text-on-brand)"
                  >Not on record means we have not found one.</strong
                >
                It is not proof that none exists.</span
              >
              <!-- Mock-up 5's continuation, only while the sections it names are on the page. -->
              @if (alternatives()) {
                &ngsp;<span data-testid="pair-empty-lede-more" i18n="@@pair.empty.ledeMore"
                  >Below are the closest pairs we do have, what you would be moving, and where to
                  look yourself.</span
                >
              }
            </p>
            <!-- AECI-1835: the correction entry (STAGE_1_5_SPEC.md 11.4, ruling R6), the
                 inline strip. The words are the product page zero state's, from the same
                 message ids. The button opens the existing correction request. -->
            <div
              class="mt-8 flex max-w-[640px] items-center gap-6 rounded-panel bg-(--surface-hero-panel) py-4 ps-6 pe-4 ring-1 ring-(--border-on-brand-subtle) ring-inset max-md:flex-wrap max-md:gap-4 max-md:p-4"
              data-testid="pair-empty-know"
            >
              <span
                class="grid size-11.5 shrink-0 place-items-center rounded-control bg-(--surface-on-brand-wash) text-(--text-on-brand)"
                ><aec-icon name="flag" decorative [size]="5"
              /></span>
              <div class="min-w-0 flex-1">
                <p
                  class="m-0 font-display text-t-20 font-semibold text-(--text-on-brand)"
                  i18n="@@products.detail.body.integrations.zero.knowHeading"
                >
                  Know of one?
                </p>
                <p
                  id="pair-empty-know-line"
                  class="m-0 text-t-16 text-(--text-on-brand-secondary)"
                  i18n="@@products.detail.body.integrations.zero.knowLine"
                >
                  Tell us where you saw it and we will look at it.
                </p>
              </div>
              <a
                aecButton
                variant="on-brand"
                class="max-md:w-full"
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'correction'"
                [slug]="context.slug"
                [pairSlug]="other.slug"
                [bodyPrefill]="knowPrefill()"
                [href]="'/products/' + context.slug + '/correction'"
                aria-describedby="pair-empty-know-line"
                data-testid="pair-empty-correction"
              >
                <ng-container i18n="@@products.detail.body.integrations.zero.exists"
                  >It does exist</ng-container
                >
                <aec-icon name="arrow-right" class="rtl:-scale-x-100" decorative [size]="4" />
              </a>
            </div>
          </div>
        }

        <!-- The diagram (ruling 8): the two products as white cards, context first, joined
             by a Clay ribbon. The ribbon draws no arrow and no direction glyph (DESIGN.md
             "The Arrow Rule"): an arrow means data-flow direction, and the hero states
             none. Its badge repeats the data heading's count under the h2's own
             condition, a counted heading, and is aria-hidden so a screen reader hears it
             once (ruling 9). A pair with no integration draws no ribbon. -->
        @if (v.mechanisms.length > 0) {
          <div heroPanel class="grid" data-testid="pair-rail">
            @for (side of sides(); track side.key) {
              @if (side.key === 'other') {
                @if (v.mechanisms.length > 0) {
                  <div
                    class="relative flex min-h-28 items-center justify-center"
                    aria-hidden="true"
                    data-testid="pair-ribbon"
                  >
                    <span
                      class="absolute inset-y-0 start-1/2 w-1.5 -translate-x-1/2 rounded-pill bg-(--accent-secondary) rtl:translate-x-1/2"
                    ></span>
                    @if (v.syncTotal > 0) {
                      <span
                        class="relative rounded-pill bg-(--accent-primary) px-4 py-2 text-t-14 font-semibold whitespace-nowrap text-(--text-on-brand) ring-1 ring-(--border-on-brand-strong)"
                        data-testid="pair-hero-badge"
                        >{{ v.syncHeadline }}</span
                      >
                    }
                  </div>
                } @else {
                  <div class="h-4" aria-hidden="true"></div>
                }
              }
              <div [class]="side.offsetClass">
                <div
                  aecCard
                  class="p-6 text-(--text-primary)"
                  [attr.data-testid]="'pair-side-' + side.key"
                >
                  <div class="flex min-w-0 items-center gap-4">
                    <!-- The logo rule decides the mark (AECI-1769): a claimed product's
                       logo, or the initial tile. At 64px an unclaimed product is the tile
                       whatever the payload holds. -->
                    <aec-logo-or-initial
                      [name]="side.product.name"
                      [src]="side.product.logo_url"
                      [alt]="logoAlt(side.product.name)"
                      [claimStatus]="side.product.claim_status"
                      size="lg"
                    />
                    <div class="min-w-0">
                      <p class="m-0 font-display text-t-24 leading-tight font-semibold break-words">
                        <a
                          [routerLink]="['/products', side.product.slug]"
                          class="text-(--text-primary) no-underline underline-offset-3 hover:text-(--accent-primary) hover:underline focus-visible:outline-(--accent-primary)"
                          >{{ side.product.name }}</a
                        >
                      </p>
                      @if (side.product.vendor) {
                        <p class="m-0 text-t-14 text-(--text-secondary)">
                          {{ side.product.vendor.name }}
                        </p>
                      }
                    </div>
                  </div>
                  <!-- AECI-1618: an unclaimed product keeps its small sourced logo with
                     counsel's wording directly beside it, as on the product hero. -->
                  @if (side.product.claim_status === 'unclaimed') {
                    <div class="mt-3 flex items-center gap-2">
                      <aec-logo-or-initial
                        [name]="side.product.name"
                        [src]="side.product.logo_url"
                        [alt]="logoAlt(side.product.name)"
                        [claimStatus]="side.product.claim_status"
                        [ownPage]="true"
                        size="sm"
                      />
                      <aec-unclaimed-note />
                    </div>
                  }
                  @if (side.product.rating_overall_avg !== null) {
                    <!-- The same span and accessible name as before AECI-1798. -->
                    <span
                      class="mt-2 flex w-fit items-center gap-1 text-xs text-(--text-secondary)"
                      [attr.aria-label]="ratingAria(side.product)"
                    >
                      <span aria-hidden="true" class="text-(--accent-rating)">★</span>
                      <span class="tabular-nums">{{
                        side.product.rating_overall_avg.toFixed(1)
                      }}</span>
                      <span
                        >· {{ side.product.review_count }}
                        <ng-container i18n="@@pair.reviews.count">reviews</ng-container></span
                      >
                    </span>
                  }
                  <!-- AECI-303 (§9.1): the side's version selector, under its own product.
                     Only the name is a link, so the combobox is not inside an anchor.
                     Renders nothing when the diff does not apply (a null versionView),
                     or when the side has fewer than two releases. -->
                  @if (side.version; as sv) {
                    <aec-pair-version-select
                      class="mt-4 block"
                      [side]="side.key"
                      [label]="versionLabelFor(side.product.name)"
                      [options]="sv.options"
                      [value]="sv.selected"
                      (changed)="setVersion(side.key, $event)"
                    />
                  }
                </div>
              </div>
            }
          </div>
        } @else {
          <!-- AECI-1835: mock-up 5's diagram, two cards, ribbons and the medallion. -->
          <aec-pair-empty-stage heroPanel [context]="context" [other]="other" />
        }
      </aec-hero-band>

      @if (v.mechanisms.length === 0) {
        <!-- AECI-1830 and AECI-1829: "What you would be moving" (the page's one Bone band)
             and the closest matches, where mock-up 5 has them (ruling R6). Absent when the
             alternatives read failed: the rest of the page stands on its own. -->
        @if (alternatives(); as alt) {
          <aec-pair-empty-alternatives [context]="context" [other]="other" [alternatives]="alt" />
        }
        <!-- AECI-1827, AECI-1835: the empty pair's body, its own two bands. Exactly when the
             pair has no integration and no connector-evidenced pair (the API returns both
             as mechanisms). -->
        <aec-pair-empty-sections data-testid="page-canvas" [context]="context" [other]="other">
          <!-- AECI-1666: "About this listing". Every listing shows the panel, and no page
               hides it (STAGE_2_VENDOR_PORTAL_SPEC.md 4.5.8, ruled 2026-11-17). With no
               card to follow, both copies end the page body's last band, as on the
               redesigned product and vendor pages. -->
          @let pv = v.provenance;
          <aec-listing-provenance
            class="mt-12 block"
            data-testid="listing-provenance"
            variant="card"
            [maintainedBy]="v.pair.maintenance.maintained_by"
            [reviewedAt]="null"
            [claimed]="pv.claimed"
            [groups]="pv.groups"
            [corrections]="pv.corrections"
            [underReviewCount]="pv.underReviewCount"
            [page]="v.captionPage"
          />
          <aec-listing-provenance
            class="mt-12 block"
            variant="disclosure"
            [maintainedBy]="v.pair.maintenance.maintained_by"
            [reviewedAt]="null"
            [claimed]="pv.claimed"
            [groups]="pv.groups"
            [corrections]="pv.corrections"
            [underReviewCount]="pv.underReviewCount"
            [page]="v.captionPage"
          />
        </aec-pair-empty-sections>
      } @else {
        <section class="bg-(--surface-base) text-(--text-primary)">
          <div [class]="bandWrap" data-testid="page-canvas">
            <div class="mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
              <!-- The data section heading (§3.5 as amended by AECI-1142). Ruling
                 2026-09-28 (Chris): the summary band and ratio line are replaced by
                 the per-card At a glance row. The count is a plain h2 for the cards
                 below; the per-row badges already say who confirmed what. The size is
                 on an inner span: the unlayered h2 rule beats a size utility. -->
              <div class="min-w-0" data-testid="pair-data-heading">
                @if (v.syncTotal > 0) {
                  <h2 class="m-0">
                    <span class="font-display text-t-36 leading-[1.1] tracking-[-0.02em]">{{
                      v.syncHeadline
                    }}</span>
                  </h2>
                } @else {
                  <!-- AECI-919: two copies, picked by emptyCopy(). The directional one
                     applies when a Layer-A arrow renders under this heading (Detailed
                     view only), so the page never denies a direction it documents. -->
                  <h2 class="m-0">
                    <span class="font-display text-t-36 leading-[1.1] tracking-[-0.02em]">{{
                      emptyCopy().headline
                    }}</span>
                  </h2>
                  <p class="mt-2 text-t-14 text-(--text-secondary)">{{ emptyCopy().subline }}</p>
                }

                <!-- AECI-303 (§9.1): what the selected version pair changed. Lives
                   under the heading because the heading owns "what is shared"; the
                   per-row markers below say which types of data. Only rendered when
                   there IS a previous pair to compare against; the earliest pair is
                   a baseline, not a diff. -->
                @if (versionView(); as vv) {
                  @if (vv.previousSummary) {
                    <p class="mt-2 text-xs text-(--text-secondary)">
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
                      class="mt-3 inline-flex min-h-6 items-center rounded-mark text-xs font-semibold
                      text-(--accent-primary) underline underline-offset-2 focus-visible:outline-3
                      focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                      i18n="@@pair.version.showLatest"
                    >
                      Show the latest versions
                    </button>
                  }
                }
              </div>

              <!-- Basic/Detailed disclosure toggle (§8), beside the heading it governs
                 (ruling 11). The pressed-toggle recipe of the cards/table toggle. Shown
                 only when a mechanism carries claim lanes or a direction arrow;
                 otherwise the two views are identical, so the control would be a no-op. -->
              @if (v.hasDetail) {
                <div
                  role="group"
                  class="aec-field-control inline-flex shrink-0 gap-0.5 border bg-(--surface-base) p-[3px]"
                  i18n-aria-label="@@pair.view.aria"
                  aria-label="Choose a view"
                >
                  <button
                    type="button"
                    [class]="viewBtnClass('basic')"
                    [attr.aria-pressed]="viewMode() === 'basic'"
                    (click)="setView('basic')"
                  >
                    @if (viewMode() === 'basic') {
                      <aec-icon name="check" decorative [size]="4" />
                    }
                    <span i18n="@@pair.view.basic">Basic</span>
                  </button>
                  <button
                    type="button"
                    [class]="viewBtnClass('detailed')"
                    [attr.aria-pressed]="viewMode() === 'detailed'"
                    (click)="setView('detailed')"
                  >
                    @if (viewMode() === 'detailed') {
                      <aec-icon name="check" decorative [size]="4" />
                    }
                    <span i18n="@@pair.view.detailed">Detailed</span>
                  </button>
                </div>
              }
            </div>
            <!-- Per-mechanism cards with the context-relative direction arrow, in the
               API's order: integrations first, then evidenced pairs (ruling R1). Each is
               the shared card (ruling A7). Headings nest h2, h3, h4 (ruling 10). -->
            <div class="grid gap-8">
              @for (m of v.mechanisms; track m.id) {
                <article aecCard class="space-y-4 p-6 md:p-8">
                  <header class="flex flex-wrap items-center gap-x-3 gap-y-2">
                    @if (m.name) {
                      <!-- AECI-1142: the kind lives in "How you get it" when a name
                         heads the card, so it is not stated twice. -->
                      @if (m.kindLabel && !m.glance?.how?.kind) {
                        <aec-chip tone="quiet">{{ m.kindLabel }}</aec-chip>
                      }
                      <h3 class="m-0">
                        <span class="font-display text-t-24 leading-tight text-(--text-primary)">{{
                          m.name
                        }}</span>
                      </h3>
                    } @else {
                      <!-- No mechanism name: promote the kind label to the card
                         heading so the Layer-B lane h4s below never skip from the
                         data h2 straight to h4. Falls back to a generic title when
                         the kind enum is also absent/unknown (kindLabel === ''). -->
                      <h3 class="m-0 inline-flex">
                        <aec-chip tone="quiet">
                          @if (m.kindLabel) {
                            {{ m.kindLabel }}
                          } @else {
                            <ng-container i18n="@@pair.mechanism.untitled"
                              >Integration</ng-container
                            >
                          }
                        </aec-chip>
                      </h3>
                    }
                    <!-- AECI-711 depth axis: direction and object coverage at the
                       mechanism badge's weight, in Basic and Detailed alike. Depth
                       is orthogonal to mechanism: a one-way read of one object and
                       a two-way sync of twelve used to render identically here.
                       Each chip renders only when present; a mechanism with no
                       stored direction and no claims renders exactly as it did
                       before (depth-axis-null.component.spec.ts). The glyph comes
                       from contextDirectionLabel, one of the Arrow Rule's three
                       emitters, and is aria-hidden behind an sr-only prefix. -->
                    <!-- Not where the Layer-A line below already states the same
                       direction (Detailed, no claims): one card, one statement. -->
                    @if (m.depthDirection.token && !(viewMode() === 'detailed' && !m.hasClaims)) {
                      <aec-chip tone="quiet" data-testid="pair-depth-direction">
                        <span class="sr-only" i18n="@@pair.depth.direction.srLabel"
                          >Direction:</span
                        >
                        <span
                          class="leading-none text-(--accent-primary) rtl:-scale-x-100"
                          aria-hidden="true"
                          >{{ m.depthDirection.glyph }}</span
                        >
                        <span>{{ m.depthDirection.label }}</span>
                      </aec-chip>
                    }
                    <!-- Ruled 2026-09-23: with one mechanism the section heading
                       already says "N types of data shared", so the card chip
                       would only repeat it. -->
                    @if (m.dataObjectLabel && !(v.mechanisms.length === 1 && v.syncTotal > 0)) {
                      <aec-chip tone="quiet" data-testid="pair-depth-objects">{{
                        m.dataObjectLabel
                      }}</aec-chip>
                    }
                  </header>

                  <!-- The Stage 1 §4.4 "Offered by" / "Powered by" byline lives in the
                     At a glance strip's "How you get it" since AECI-1142, so the
                     card states delivery once. -->

                  <!-- Layer-A mechanism arrow: a Detailed-view detail, shown only when
                     this mechanism has no claims. When claims exist the per-lane
                     arrows below carry the direction, so the standalone arrow would
                     be redundant (§8). Hidden in Basic (Overview). -->
                  @if (viewMode() === 'detailed' && !m.hasClaims && m.direction) {
                    <p class="flex items-center gap-2 text-sm text-(--text-secondary)">
                      <span
                        class="font-display text-xl text-(--accent-primary)"
                        aria-hidden="true"
                        >{{ m.glyph }}</span
                      >
                      <span>{{ m.directionLabel }}</span>
                    </p>
                  }

                  @if (m.description) {
                    <p class="max-w-prose text-sm leading-relaxed text-(--text-secondary)">
                      {{ m.description }}
                    </p>
                  } @else if (m.descriptionUnderReview) {
                    <aec-under-review data-testid="mechanism-description-under-review" />
                  }
                  <!-- AECI-1238 (§11d.7): the card's other values AECi hid while it checks
                     them. Their slots render nothing, so each line names its field. -->
                  @if (m.underReview.length > 0) {
                    <div class="space-y-1" data-testid="mechanism-under-review">
                      @for (entry of m.underReview; track entry.field) {
                        <aec-under-review [label]="entry.label" />
                      }
                    </div>
                  }

                  <!-- AECI-1142 "At a glance". Per card: each fact is a column of this
                     one integration row. A fact with no value is left out, and the
                     whole strip is left out when none has a value. Identity rather
                     than detail, so it renders in Basic view too.

                     Tinted Bone (--accent-warm), the ground of the summary band it
                     replaced (ruled 2026-09-28). A nested fill, not a band (mock-up 12):
                     the panel radius, no border, no shadow. Labels stay text-secondary:
                     tertiary fails AA on Bone. -->
                  @if (m.glance; as g) {
                    <div
                      class="rounded-panel bg-(--accent-warm) px-6 py-4"
                      data-testid="pair-glance"
                    >
                      <h4 class="aec-overline text-(--text-secondary)" i18n="@@pair.glance.title">
                        At a glance
                      </h4>
                      <!-- auto-fit, not a fixed 4 columns: a card with one or two facts
                         gives them the full width instead of a quarter. -->
                      <dl
                        class="mt-2 grid gap-x-8 gap-y-3 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]"
                      >
                        @if (g.price || g.priceUrl) {
                          <div>
                            <dt class="text-xs text-(--text-secondary)" i18n="@@pair.glance.price">
                              Price
                            </dt>
                            <dd class="mt-1 text-sm text-(--text-primary)">
                              <!-- AECI-1158 (§6.17.11): the owner's pricing page links the
                                 price, or reads "See pricing" when there is no price. A
                                 vendor-controlled destination, so the card links' rel. -->
                              @if (g.priceUrl; as href) {
                                <a
                                  [href]="href"
                                  target="_blank"
                                  rel="noopener nofollow"
                                  aecTrackExternalLink="pair_detail"
                                  [aecLinkContext]="g.priceLinkContext!"
                                  class="inline-flex items-center gap-1 text-(--accent-primary) underline underline-offset-2"
                                  data-testid="pair-glance-price-link"
                                >
                                  @if (g.price) {
                                    <span>{{ g.price }}</span>
                                  } @else {
                                    <span i18n="@@pair.glance.seePricing">See pricing</span>
                                  }
                                  <aec-new-tab-icon />
                                </a>
                              } @else {
                                {{ g.price }}
                              }
                            </dd>
                          </div>
                        }
                        @if (g.stage) {
                          <div>
                            <dt class="text-xs text-(--text-secondary)" i18n="@@pair.glance.stage">
                              Release stage
                            </dt>
                            <dd class="mt-1 text-sm text-(--text-primary)">
                              {{ g.stage }}
                            </dd>
                          </div>
                        }
                        @if (g.how; as how) {
                          <div>
                            <dt class="text-xs text-(--text-secondary)" i18n="@@pair.glance.how">
                              How you get it
                            </dt>
                            <dd class="mt-1 text-sm text-(--text-primary)">
                              @if (how.kind) {
                                <span class="block">{{ how.kind }}</span>
                              }
                              @if (how.offeredBy || how.through) {
                                <span class="block text-(--text-secondary)">
                                  @if (how.offeredBy; as bv) {
                                    <ng-container i18n="@@pair.mechanism.builtBy"
                                      >Offered by</ng-container
                                    >&ngsp;<a
                                      [routerLink]="['/vendors', bv.slug]"
                                      class="text-(--accent-primary) underline underline-offset-2"
                                      >{{ bv.name }}</a
                                    >
                                  }
                                  <!-- The link sits inside each branch, right after
                                     &ngsp;: a space placed after the control-flow
                                     block is stripped as inter-block whitespace. -->
                                  @if (how.through; as pb) {
                                    @if (how.offeredBy) {
                                      <ng-container i18n="@@pair.glance.throughJoin"
                                        >, through</ng-container
                                      >&ngsp;<a
                                        [routerLink]="['/products', pb.slug]"
                                        class="text-(--accent-primary) underline underline-offset-2"
                                        >{{ pb.name }}</a
                                      >
                                    } @else {
                                      <ng-container i18n="@@pair.glance.through"
                                        >Through</ng-container
                                      >&ngsp;<a
                                        [routerLink]="['/products', pb.slug]"
                                        class="text-(--accent-primary) underline underline-offset-2"
                                        >{{ pb.name }}</a
                                      >
                                    }
                                  }
                                </span>
                              }
                              <!-- AECI-1011: a vendor-created row says so. Name-free on
                                 purpose: an AECi owner reassignment can change "Offered
                                 by" after the create, so naming the owner could be false. -->
                              @if (how.vendorAdded) {
                                <span
                                  class="block text-xs text-(--text-secondary)"
                                  data-testid="pair-vendor-added"
                                  i18n="@@pair.mechanism.vendorAdded"
                                  >Added by the vendor</span
                                >
                              }
                            </dd>
                          </div>
                        }
                        @if (g.lastChecked) {
                          <div>
                            <dt
                              class="text-xs text-(--text-secondary)"
                              i18n="@@pair.glance.lastChecked"
                            >
                              Last checked
                            </dt>
                            <dd class="mt-1 text-sm tabular-nums text-(--text-primary)">
                              {{ g.lastChecked }}
                            </dd>
                          </div>
                        }
                      </dl>
                    </div>
                  }

                  <!-- Layer B (§8): data_object claim rows, grouped into direction
                     lanes, each with a neutral agreement badge + AECi provenance.
                     The "data transfers back and forth", shown in Detailed only;
                     Basic (Overview) collapses to the description + sync headline. -->
                  @if (viewMode() === 'detailed' && m.claimGroups.length > 0) {
                    <!-- Lanes in DIRECTION_ORDER. Nested Forest-soft panels; two or more sit
                       side by side from lg, in the same reading order (mock-up 12). -->
                    <div
                      class="grid items-start gap-4"
                      [class.lg:grid-cols-2]="m.claimGroups.length > 1"
                      data-testid="pair-lanes"
                    >
                      @for (g of m.claimGroups; track g.direction) {
                        <div aecCard nested class="p-4">
                          <div class="flex items-center gap-3">
                            <!-- The lane heading beside it says the same words, so the glyph
                               is decorative. An aria-label on a plain span is not reliably
                               read (records/11 §8). -->
                            <span
                              class="font-display text-t-24 leading-none text-(--accent-primary)"
                              aria-hidden="true"
                              >{{ g.glyph }}</span
                            >
                            <h4 class="aec-overline text-(--text-secondary)">{{ g.heading }}</h4>
                          </div>
                          <!-- One row per line, the full lane wide (mock-up 12, .rows): the
                             data type on the left, its agreement label on the right. -->
                          <ul class="mt-3 grid gap-2" data-testid="pair-lane-rows">
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
                                class="flex min-h-13 flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-control border bg-(--surface-base) py-1 ps-4 pe-1"
                                [class]="r.rowClass"
                              >
                                <span class="flex min-w-0 flex-col gap-1">
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
                                <span class="ms-auto flex items-center gap-1">
                                  <aec-agreement-badge
                                    [agreement]="r.claim.agreement"
                                    [attributedTo]="r.attributedTo"
                                    [refuted]="r.claim.refuted ?? false"
                                  />
                                  <aec-claim-provenance
                                    [claim]="r.claim"
                                    [contextVendorName]="v.vendorNames.context"
                                    [otherVendorName]="v.vendorNames.other"
                                  />
                                </span>
                              </li>
                            }
                          </ul>
                        </div>
                      }
                    </div>
                  }

                  <!-- Standalone-link role (DESIGN.md, "The Link Treatment Rule").
                     AECI-980 pulled these two off accent and off the arrow glyph.
                     Off accent because a second accent-coloured thing competes
                     with the one primary action on the page. Off the glyph
                     because this card also renders a real direction arrow, so two
                     arrow characters sat in one card meaning two unrelated things
                     (the Arrow Rule). The rel gained nofollow because these are
                     vendor-controlled destinations. AECI-1640 dropped noreferrer
                     so the vendor sees AECi as the referrer. -->
                  @if (m.links.length > 0) {
                    <!-- AECI-1007: each endpoint vendor's own links carry its name, and
                       AECi's curated link is the fallback per kind. -->
                    <ul class="-mx-3 flex flex-wrap gap-1">
                      @for (link of m.links; track $index) {
                        <li>
                          <a
                            [href]="link.href"
                            target="_blank"
                            rel="noopener nofollow"
                            aecTrackExternalLink="pair_detail"
                            [aecLinkContext]="link.context"
                            class="inline-flex items-center gap-1.5 rounded-(--radius-md) px-3 py-1.5
                            text-xs font-semibold text-(--text-secondary) underline
                            decoration-(--border-strong) underline-offset-4 transition-colors
                            hover:text-(--text-primary) focus-visible:outline-2
                            focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          >
                            <span>{{ link.label }}</span>
                            <aec-new-tab-icon />
                          </a>
                          @if (link.linkFrom; as from) {
                            <span
                              class="block px-3 text-xs leading-5 text-(--text-secondary)"
                              data-testid="pair-link-from"
                              >{{ from }}</span
                            >
                          }
                        </li>
                      }
                    </ul>
                  }
                </article>
              }
            </div>

            <!-- AECI-1666: "About this listing", the page's one provenance panel, after the
               cards (ruling 4: this page has no sidebar). A card from lg, a closed
               disclosure below it. Only the card copy carries the test id. -->
            @let pv = v.provenance;
            <aec-listing-provenance
              class="mt-8"
              data-testid="listing-provenance"
              variant="card"
              [maintainedBy]="v.pair.maintenance.maintained_by"
              [reviewedAt]="null"
              [claimed]="pv.claimed"
              [groups]="pv.groups"
              [corrections]="pv.corrections"
              [underReviewCount]="pv.underReviewCount"
              [page]="v.captionPage"
            />
            <aec-listing-provenance
              class="mt-8"
              variant="disclosure"
              [maintainedBy]="v.pair.maintenance.maintained_by"
              [reviewedAt]="null"
              [claimed]="pv.claimed"
              [groups]="pv.groups"
              [corrections]="pv.corrections"
              [underReviewCount]="pv.underReviewCount"
              [page]="v.captionPage"
            />
          </div>
        </section>
      }

      <!-- The page's one Bone band (ruling 12 of 2026-11-16). On an empty pair with its
           alternatives, "What you would be moving" is that band, as in mock-up 5, which has
           no mailing list. -->
      @if (v.mechanisms.length > 0 || !alternatives()) {
        <aec-mailing-list-signup />
      }

      <!-- The in-place correction drawer (AECI-128) that the empty pair's "It does exist"
           trigger opens, as on the product page. Without it the trigger cancels the click
           and nothing opens. Renders nothing until opened. -->
      @if (v.mechanisms.length === 0) {
        <aec-request-drawer />
      }
    }
  `,
})
export class ProductsPairPage {
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(Analytics);
  private readonly router = inject(Router);
  private readonly locale = inject(LOCALE_ID);

  /**
   * The trail is Home, the context product, Integrations, then the other product.
   * Without "Integrations" the last two read as a parent and child, which says the
   * other product belongs to the context product. The crumb deep-links to that
   * list's section anchor on the context product's page.
   */
  protected readonly crumbs = computed<BreadcrumbItem[]>(() => {
    const v = this.view();
    if (v === null) return [];
    const context = v.pair.context_product;
    return [
      homeCrumb(),
      { label: context.name, link: ['/products', context.slug] },
      {
        label: $localize`:@@pair.breadcrumb.integrations:Integrations`,
        link: ['/products', context.slug],
        fragment: 'integrations',
      },
      { label: v.pair.other_product.name },
    ];
  });
  protected readonly logoAlt = logoAlt;
  /** AECI-1835: the correction request's opening text names both products (§11.5). */
  protected readonly knowPrefill = computed(() => {
    const pair = this.pair();
    if (!pair) return null;
    const a = pair.context_product.name;
    const b = pair.other_product.name;
    return $localize`:@@pair.empty.know.prefill:An integration between ${a}:A: and ${b}:B:. Where I saw it: `;
  });
  /** Whether the caveat shows: exactly when the statement does (no mechanism). */
  protected readonly caveatShown = computed(() => this.pair()?.mechanisms.length === 0);

  /** Resolved pair (or `null` on NOT_FOUND); SSR-hydrated from `TransferState`. */
  private readonly pair = toSignal<PairPageData | null, PairPageData | null>(
    this.route.data.pipe(map((d) => (d['pair'] ?? null) as PairPageData | null)),
    { initialValue: (this.route.snapshot.data['pair'] ?? null) as PairPageData | null },
  );

  /** AECI-1829 / AECI-1830: the empty pair's alternatives, when the read returned them. */
  protected readonly alternatives = computed(() => this.pair()?.alternatives ?? null);

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
    // AECI-935: browser-only `integration_viewed`, mirroring `product_viewed`.
    // Canonical id order (the AECI-933 `pairKey` order), so both URL
    // orientations emit the same pair. One component instance per pair route,
    // and a version-selector change keeps the instance, so one event per page.
    afterNextRender(() => {
      const p = this.pair();
      if (!p) return;
      const [a, b] = canonicalPairIds(p.context_product.id, p.other_product.id);
      if (a && b) this.analytics.integrationViewed(a, b);
    });
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

  /** The empty heading's copy (AECI-919). The directional fork needs a Layer-A arrow
   *  to point at, and Basic hides that arrow, so it applies in Detailed only. The
   *  refuted fork (AECI-1140) applies in both views and wins. */
  protected readonly emptyCopy = computed(() =>
    emptyBandCopy(
      this.viewMode() === 'detailed' && (this.view()?.hasLayerADirection ?? false),
      this.view()?.hasRefutedOnly ?? false,
    ),
  );

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

  /** The pressed-toggle recipe of the cards/table toggle (`listing-view-toggle.ts`): the
   *  same class names, so `.aec-view-toggle-btn` gives the pressed one the system
   *  selection pair in forced-colours mode. The pressed one also shows a tick, so the
   *  state is never colour alone (clash 5). */
  protected viewBtnClass(mode: PairViewMode): string {
    const base =
      'aec-view-toggle-btn inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-mark px-3.5 text-t-14 font-semibold transition-colors duration-fast ease-standard focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
    return this.viewMode() === mode
      ? `${base} bg-(--accent-primary) text-(--surface-base)`
      : `${base} text-(--text-primary) hover:bg-(--surface-sunken)`;
  }

  /** The data band's wrap: the 1328px page wrap with mock-up 12's band padding. */
  protected readonly bandWrap = `${BAND_WRAP_CLASS} py-16 md:py-24`;

  /**
   * The hero diagram's two sides, context first (AECI-1798). Each carries its own
   * version selector, or `null` when the §9 diff does not apply or the side has fewer
   * than two releases (the rule the second rail row applied before). From `lg` the
   * cards step apart, context to the start, other to the end (mock-up 12).
   */
  protected readonly sides = computed(() => {
    const pair = this.pair();
    if (!pair) return [];
    const vv = this.versionView();
    const side = (key: 'context' | 'other') => {
      const options = vv ? (key === 'context' ? vv.contextOptions : vv.otherOptions) : [];
      return {
        key,
        product: key === 'context' ? pair.context_product : pair.other_product,
        offsetClass: key === 'context' ? 'min-w-0 lg:me-16' : 'min-w-0 lg:ms-16',
        version:
          vv && options.length > 1
            ? { options, selected: key === 'context' ? vv.selectedContext : vv.selectedOther }
            : null,
      };
    };
    return [side('context'), side('other')];
  });

  /** View-model: mechanisms with their direction copy + claim lanes resolved once. */
  /**
   * A product name in the empty pair statement. From `md` a name stays on one line, as
   * mock-up 5's `.pn` does, while it is short enough to fit the text column at its
   * narrowest: 16 characters, about 345px at 43px type in the 372px column at 1040px. A
   * longer name may break, so it never pushes the page sideways.
   */
  protected statementName(name: string): string {
    return name.length <= 16 ? 'font-semibold md:whitespace-nowrap' : 'font-semibold';
  }

  protected readonly view = computed<PairView | null>(() => {
    const pair = this.pair();
    if (!pair) return null;
    const otherName = pair.other_product.name;
    // Only `total` renders since AECI-1142 (ruling 2026-09-28): the ratio line that
    // read `confirmed` and `single_source` was removed with the summary band.
    const { total } = pair.sync_headline;
    const vendorNames: PairVendorNames = {
      context: pair.context_product.vendor?.name ?? null,
      other: pair.other_product.vendor?.name ?? null,
    };
    const sideNames: PairSideNames = {
      context: pair.context_product.name,
      other: otherName,
    };
    // AECI-933: computed once per page. The canonical key is what AECI-929 stores
    // for pair page views, so both URL orientations report one pair.
    const owners: PairLinkOwners = {
      context: pair.context_product.vendor?.id ?? null,
      other: pair.other_product.vendor?.id ?? null,
      contextName: pair.context_product.vendor?.name ?? null,
      otherName: pair.other_product.vendor?.name ?? null,
      pairKey: canonicalPairIds(pair.context_product.id, pair.other_product.id).join(':'),
    };
    const mechanisms = pair.mechanisms.map((m) =>
      this.toMechanismView(m, otherName, vendorNames, sideNames, owners),
    );
    return {
      pair,
      captionPage: { surface: 'pair_detail', entityType: 'pair', entityId: owners.pairKey },
      provenance:
        pair.mechanisms.length === 0
          ? emptyPairProvenance(pair.context_product, pair.other_product)
          : pairProvenance(pair, mechanisms),
      mechanisms,
      syncTotal: total,
      syncHeadline: syncHeadlineText(total),
      vendorNames,
      hasDetail: mechanisms.some(
        (m) => m.claimGroups.length > 0 || (m.direction !== null && !m.hasClaims),
      ),
      // Deliberately the SAME predicate the per-mechanism card gates its
      // standalone arrow on (see the template). If the two drift, the heading
      // promises a direction "below" that no card renders — which is the defect
      // AECI-919 fixed, just inverted.
      hasLayerADirection: mechanisms.some((m) => m.direction !== null && !m.hasClaims),
      // AECI-1140: nothing counts, yet a refuted claim still renders.
      hasRefutedOnly:
        total === 0 &&
        pair.mechanisms.some((m) =>
          m.claims.some((c) => c.version_status !== 'removed' && c.refuted === true),
        ),
    };
  });

  private toMechanismView(
    m: ProductPairMechanism,
    otherName: string,
    vendorNames: PairVendorNames,
    sideNames: PairSideNames,
    owners: PairLinkOwners,
  ): MechanismView {
    return {
      id: m.id,
      kindLabel: mechanismKindLabel(m.mechanism_kind),
      name: m.mechanism_name,
      description: m.description,
      links: mechanismLinks(m, sideNames, owners),
      direction: m.direction,
      glyph: m.direction ? directionGlyph(m.direction) : '',
      directionLabel: m.direction ? directionHeading(m.direction, otherName) : '',
      // The claims-aware direction, never the stored one: the stored arrow is
      // exactly what this page hides once claims exist, and the product row reads
      // the claims-aware value, so a stored-direction chip would contradict both.
      depthDirection: contextDirectionLabel(m.effective_direction, otherName),
      // The headline's rule, scoped to one mechanism: distinct objects
      // (AECI-1042). A `removed` claim does not count: it still renders, struck
      // through, but "N data objects" may not include a flow that stopped. A
      // refuted claim does not count either (AECI-1140): it still renders, under
      // "A company says no".
      dataObjectLabel: dataObjectCountLabel(
        distinctDataObjectSlugs(
          m.claims.filter((c) => c.version_status !== 'removed' && !c.refuted),
        ).length,
      ),
      claimGroups: buildClaimGroups(
        m.claims,
        otherName,
        vendorNames,
        this.pair()?.version_diff?.selected ?? null,
      ),
      hasClaims: m.claims.length > 0,
      glance: this.glanceFacts(m, owners),
      corrections: correctionsInSlots(m.corrections, this.correctionSlots(m)),
      descriptionUnderReview: isUnderReview(m.under_review, 'description'),
      underReview: (m.under_review ?? [])
        .filter((field) => field !== 'description')
        .map((field) => ({ field, label: correctionLabel(field) })),
    };
  }

  /**
   * The fields a mechanism card renders a slot for, and whether each value shows
   * (AECI-1666, §4.5.8), for {@link correctionsInSlots}. `name` and `mechanism_name` both
   * feed the heading. A curated link's slot exists only while no vendor link of that kind
   * fills it (`vendorLinkFillsSlot`, the test `mechanismLinks` applies), so a correction or
   * removal on a replaced curated link gets no line. `website` and `mechanism_url` never
   * render on the card, so they have no slot.
   */
  private correctionSlots(m: ProductPairMechanism): Record<string, boolean> {
    const slots: Record<string, boolean> = {
      name: !!m.mechanism_name,
      mechanism_name: !!m.mechanism_name,
      mechanism_kind: !!m.mechanism_kind,
      direction: !!m.direction,
      description: !!m.description,
      pricing_model: !!m.pricing_model?.trim(),
      pricing_url: !!this.pricingHref(m.pricing_url),
      maturity: !!m.maturity?.trim(),
    };
    if (!vendorLinkFillsSlot(m, 'listing_url')) slots['listing_url'] = !!m.listing_url;
    if (!vendorLinkFillsSlot(m, 'docs_url')) slots['docs_url'] = !!m.docs_url;
    return slots;
  }

  /**
   * The card's "At a glance" facts (AECI-1142). `pricing_model` and `maturity` are
   * free text and render verbatim. `pricing_url` (AECI-1158) is re-checked for an
   * http(s) scheme behind the API's own check, so no other scheme reaches `href`. `?? null` because the web never Zod-parses the
   * pair response, so an older API Worker leaves the fields absent.
   */
  private glanceFacts(m: ProductPairMechanism, owners: PairLinkOwners): GlanceFacts | null {
    const offeredBy = m.built_by_vendor;
    const through = m.via ?? m.powered_by_product;
    // With no mechanism name the kind label is already the card's h2.
    const kind = m.mechanism_name ? mechanismKindLabel(m.mechanism_kind) : '';
    const how: GlanceHow | null =
      kind || offeredBy || through
        ? { kind, offeredBy, through, vendorAdded: m.origin === 'vendor' && offeredBy !== null }
        : null;
    const priceUrl = this.pricingHref(m.pricing_url);
    const facts: GlanceFacts = {
      price: m.pricing_model?.trim() || null,
      priceUrl,
      priceLinkContext: priceUrl
        ? pairLinkContext(owners, m.built_by_vendor?.id ?? null, 'vendor', 'pricing')
        : null,
      stage: m.maturity?.trim() || null,
      how,
      lastChecked: this.formatReviewDate(m.last_reviewed_at ?? null),
    };
    return facts.price || facts.priceUrl || facts.stage || facts.how || facts.lastChecked
      ? facts
      : null;
  }

  private pricingHref(url: string | null | undefined): string | null {
    const trimmed = url?.trim();
    return trimmed && isHttpUrl(trimmed) ? trimmed : null;
  }

  /** Same format and zone as `MaintenanceMarker`: UTC, so SSR (UTC) and the
   *  browser agree either side of midnight and hydration does not mismatch. */
  private formatReviewDate(at: string | null): string | null {
    if (!at) return null;
    const parsed = new Date(at);
    if (Number.isNaN(parsed.getTime())) return null;
    return formatDate(parsed, 'MMMM d, y', this.locale, 'UTC');
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
