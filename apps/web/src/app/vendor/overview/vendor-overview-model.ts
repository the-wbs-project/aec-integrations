/**
 * The rules behind the vendor overview's "What needs you" list and glance band
 * (AECI-983 / `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.10).
 *
 * Pure functions over payloads the portal store already holds: no DI, no
 * `$localize`, no browser globals. Every counting rule lives here so it can be
 * pinned by a plain Vitest spec, and the section only turns the result into copy.
 *
 * ── THE DOUBLE-COUNT TRAP (AECI-993) ────────────────────────────────────────
 * `VendorIntegration.id` is NOT unique in `GET /api/vendor/integrations`: an
 * integration whose endpoints the vendor owns BOTH is listed once per frame, with
 * identical claims. A vendor-wide count is therefore the size of a set of CLAIM
 * ids, never a `flatMap(...).length` and never a sum of per-product counts.
 */
import type {
  VendorAccount,
  VendorIntegration,
  VendorMeResponse,
  VendorProduct,
  VendorRequestSummary,
} from '@aeci/shared';

/** One product with a count of distinct claims that meet a rule. */
export interface ProductClaimCount {
  readonly product: { readonly id: string; readonly slug: string; readonly name: string };
  readonly count: number;
}

/** A vendor-wide claim tally: the deduped total and its per-product breakdown. */
export interface ClaimTally {
  /** Distinct claim ids across the whole surface. */
  readonly total: number;
  /** Per context product, in first-seen order. An owns-both claim counts once
   *  under EACH product it is filed under, which is right for a per-product row
   *  and is why {@link total} is not their sum. */
  readonly byProduct: readonly ProductClaimCount[];
}

function tally(
  integrations: readonly VendorIntegration[],
  include: (integration: VendorIntegration) => boolean,
  match: (claim: VendorIntegration['claims'][number]) => boolean,
): ClaimTally {
  const all = new Set<string>();
  const perProduct = new Map<string, { product: ProductClaimCount['product']; ids: Set<string> }>();
  for (const integration of integrations) {
    if (!include(integration)) continue;
    for (const claim of integration.claims) {
      if (!match(claim)) continue;
      all.add(claim.id);
      const ctx = integration.context_product;
      let entry = perProduct.get(ctx.id);
      if (!entry) {
        entry = { product: { id: ctx.id, slug: ctx.slug, name: ctx.name }, ids: new Set() };
        perProduct.set(ctx.id, entry);
      }
      entry.ids.add(claim.id);
    }
  }
  return {
    total: all.size,
    byProduct: [...perProduct.values()].map((e) => ({ product: e.product, count: e.ids.size })),
  };
}

/** Every claim on record, deduped by claim id. The Integrations tab's summary
 *  total (`vendor-integrations-section.ts`), which is vendor-wide on the
 *  single-page concept. */
export function claimsOnRecord(integrations: readonly VendorIntegration[]): ClaimTally {
  return tally(
    integrations,
    () => true,
    () => true,
  );
}

/** Claims whose agreement state is `conflict`, deduped by claim id. */
export function conflictsByProduct(integrations: readonly VendorIntegration[]): ClaimTally {
  return tally(
    integrations,
    () => true,
    (claim) => claim.agreement === 'conflict',
  );
}

/**
 * Claims waiting on the vendor's position: on an ATTESTABLE edge, with no live
 * attestation of the vendor's own. The same predicate as the Integrations tab's
 * summary line (`vendor-integrations-section.ts`). A connector-powered edge is
 * never waiting, because the vendor did not build that plumbing (AECI-705).
 */
export function waitingByProduct(integrations: readonly VendorIntegration[]): ClaimTally {
  return tally(
    integrations,
    (integration) => integration.attestable,
    (claim) => claim.mine.length === 0,
  );
}

export interface OpenCorrections {
  readonly items: readonly VendorRequestSummary[];
  /** `created_at` of the newest open correction, or `null` when there is none. */
  readonly newestCreatedAt: string | null;
}

/**
 * Corrections that are still open or in review, newest first. Claims are
 * deliberately excluded: a claim is someone asking for the account, not a
 * comment on the listing, and Messages already shows it.
 */
export function openCorrections(requests: readonly VendorRequestSummary[]): OpenCorrections {
  const items = requests
    .filter((r) => r.kind === 'correction' && (r.status === 'open' || r.status === 'in_review'))
    .slice()
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return { items, newestCreatedAt: items[0]?.created_at ?? null };
}

export type ProductGapField = 'description' | 'website' | 'logo' | 'categories';
export type ProfileGapField = 'description' | 'website' | 'logo' | 'headquarters';

const blank = (value: string | null): boolean => value === null || value.trim() === '';

/**
 * The product fields whose absence is a real gap.
 *
 * Never `trade_slugs`: trades are sparse BY DESIGN (`TRADES_VOCABULARY.md` §1.1),
 * so an empty list is usually the correct answer. Never audiences or phases
 * either. Those are optional refinements, and flagging them would nag a vendor
 * about data that is not wrong.
 */
export function productGaps(product: VendorProduct): readonly ProductGapField[] {
  const gaps: ProductGapField[] = [];
  if (blank(product.description)) gaps.push('description');
  if (blank(product.website)) gaps.push('website');
  if (blank(product.logo_url)) gaps.push('logo');
  if (product.category_slugs.length === 0) gaps.push('categories');
  return gaps;
}

/** The company-profile fields whose absence is a real gap. */
export function profileGaps(vendor: VendorAccount): readonly ProfileGapField[] {
  const gaps: ProfileGapField[] = [];
  if (blank(vendor.description)) gaps.push('description');
  if (blank(vendor.website)) gaps.push('website');
  if (blank(vendor.logo_url)) gaps.push('logo');
  if (blank(vendor.headquarters)) gaps.push('headquarters');
  return gaps;
}

// ─── The list ────────────────────────────────────────────────────────────────

/** How many product rows a "Worth doing" group shows before "and N more". */
export const PRODUCT_ROW_CAP = 3;

/** Route segments, relative to the vendor root (`/vendor/:slug` or the preview). */
export type NeedsItemLink =
  | {
      readonly kind: 'integrations';
      readonly productSlug: string;
      /** Pre-applied status filter on the Integrations tab (AECI-999). */
      readonly status?: 'conflict' | 'needs_you';
    }
  | { readonly kind: 'productProfile'; readonly productSlug: string }
  | { readonly kind: 'productCategories'; readonly productSlug: string }
  | { readonly kind: 'products' }
  | { readonly kind: 'profile' }
  | { readonly kind: 'messages' }
  | { readonly kind: 'seats' };

export type NeedsItem =
  | {
      readonly type: 'conflict';
      readonly key: string;
      readonly product: ProductClaimCount['product'];
      readonly count: number;
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'correction';
      readonly key: string;
      readonly request: VendorRequestSummary;
      /** The product or company name the correction is about, when resolvable. */
      readonly targetName: string | null;
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'waiting';
      readonly key: string;
      readonly product: ProductClaimCount['product'];
      readonly count: number;
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'waitingMore';
      readonly key: string;
      readonly products: number;
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'productGaps';
      readonly key: string;
      readonly product: VendorProduct;
      readonly fields: readonly ProductGapField[];
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'productGapsMore';
      readonly key: string;
      readonly products: number;
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'profileGaps';
      readonly key: string;
      readonly fields: readonly ProfileGapField[];
      readonly link: NeedsItemLink;
    }
  | {
      readonly type: 'seatInvites';
      readonly key: string;
      readonly count: number;
      readonly link: NeedsItemLink;
    };

export interface NeedsInput {
  readonly me: VendorMeResponse;
  readonly integrations: readonly VendorIntegration[];
  /** `false` while the integrations read is loading or has failed: no conflict
   *  or waiting row is claimed from a list we do not hold. */
  readonly integrationsReady: boolean;
  /** Pending invites, only meaningful when {@link canManageSeats}. */
  readonly seatInviteCount: number;
  readonly canManageSeats: boolean;
  /** `vendor.verified`, the gate the Integrations tab uses today (see
   *  `vendor-integrations-page.ts` on why it is not yet `attestation.author`). */
  readonly canAttest: boolean;
  readonly canEditProducts: boolean;
  readonly canEditProfile: boolean;
}

export interface NeedsList {
  readonly now: readonly NeedsItem[];
  readonly worthDoing: readonly NeedsItem[];
  /** No editing capability at all: the section shows the paused notice above
   *  the bands. Worth doing then holds seat invites only, because seat management
   *  is never capability-gated (`STAGE_2_PAID_TIERS_SPEC.md` §4.3). */
  readonly paused: boolean;
}

/**
 * The ordered list. "Needs you now" is conflicts then open corrections. "Worth
 * doing" is waiting positions, product gaps, the company profile, then seat
 * invites, each gated on the capability that would let the vendor act on it.
 */
export function buildNeedsItems(input: NeedsInput): NeedsList {
  const { me } = input;
  const now: NeedsItem[] = [];
  const worthDoing: NeedsItem[] = [];

  if (input.integrationsReady) {
    for (const row of conflictsByProduct(input.integrations).byProduct) {
      now.push({
        type: 'conflict',
        key: `conflict:${row.product.id}`,
        product: row.product,
        count: row.count,
        link: { kind: 'integrations', productSlug: row.product.slug, status: 'conflict' },
      });
    }
  }

  const targetNames = new Map<string, string>([
    [me.vendor.id, me.vendor.company_name],
    ...me.products.map((p) => [p.id, p.name] as const),
  ]);
  for (const request of openCorrections(me.requests).items) {
    now.push({
      type: 'correction',
      key: `correction:${request.id}`,
      request,
      targetName: targetNames.get(request.target_id) ?? null,
      link: { kind: 'messages' },
    });
  }

  const paused = !input.canAttest && !input.canEditProducts && !input.canEditProfile;

  if (input.canAttest && input.integrationsReady) {
    const waiting = waitingByProduct(input.integrations)
      .byProduct.slice()
      .sort((a, b) => b.count - a.count);
    for (const row of waiting.slice(0, PRODUCT_ROW_CAP)) {
      worthDoing.push({
        type: 'waiting',
        key: `waiting:${row.product.id}`,
        product: row.product,
        count: row.count,
        link: { kind: 'integrations', productSlug: row.product.slug, status: 'needs_you' },
      });
    }
    if (waiting.length > PRODUCT_ROW_CAP) {
      worthDoing.push({
        type: 'waitingMore',
        key: 'waiting:more',
        products: waiting.length - PRODUCT_ROW_CAP,
        link: { kind: 'products' },
      });
    }
  }

  if (input.canEditProducts) {
    const incomplete = me.products
      .map((product) => ({ product, fields: productGaps(product) }))
      .filter((p) => p.fields.length > 0);
    for (const { product, fields } of incomplete.slice(0, PRODUCT_ROW_CAP)) {
      worthDoing.push({
        type: 'productGaps',
        key: `product:${product.id}`,
        product,
        fields,
        link: fields.includes('categories')
          ? { kind: 'productCategories', productSlug: product.slug }
          : { kind: 'productProfile', productSlug: product.slug },
      });
    }
    if (incomplete.length > PRODUCT_ROW_CAP) {
      worthDoing.push({
        type: 'productGapsMore',
        key: 'product:more',
        products: incomplete.length - PRODUCT_ROW_CAP,
        link: { kind: 'products' },
      });
    }
  }

  if (input.canEditProfile) {
    const fields = profileGaps(me.vendor);
    if (fields.length > 0) {
      worthDoing.push({ type: 'profileGaps', key: 'profile', fields, link: { kind: 'profile' } });
    }
  }

  if (input.canManageSeats && input.seatInviteCount > 0) {
    worthDoing.push({
      type: 'seatInvites',
      key: 'seats',
      count: input.seatInviteCount,
      link: { kind: 'seats' },
    });
  }

  // No filter when paused: every edit-gated row above is already off, and seat
  // invites stay, because a lapsed owner can still re-send or revoke them.
  return { now, worthDoing, paused };
}

/**
 * Query params for an item's link, or `null`. Integrations rows land on the tab
 * already filtered to the state they count (AECI-999 / `STAGE_2_ATTESTATIONS_SPEC.md`
 * §6.3), so "2 in conflict" opens on the two conflicts, not on every integration.
 */
export function linkQueryParams(link: NeedsItemLink): Readonly<Record<string, string>> | null {
  return link.kind === 'integrations' && link.status ? { status: link.status } : null;
}

/** The relative `routerLink` commands for an item, from the overview route. */
export function linkCommands(link: NeedsItemLink): readonly string[] {
  switch (link.kind) {
    case 'integrations':
      return ['..', 'products', link.productSlug, 'integrations'];
    case 'productProfile':
      return ['..', 'products', link.productSlug, 'profile'];
    case 'productCategories':
      return ['..', 'products', link.productSlug, 'categories'];
    case 'products':
      return ['..', 'products'];
    case 'profile':
      return ['..', 'profile'];
    case 'messages':
      return ['..', 'messages'];
    case 'seats':
      return ['..', 'seats'];
  }
}
