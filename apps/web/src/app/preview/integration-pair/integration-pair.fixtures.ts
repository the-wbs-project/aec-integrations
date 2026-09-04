/**
 * Fixtures + view-model for the AECI-289 integration-pair prototype
 * (`/preview/integration-pair`). Pure TypeScript — no Angular — so the three
 * concept components and the host share ONE fixture, ONE direction-mirror
 * helper, and ONE copy set (so spec-faithful strings can't drift between
 * concepts).
 *
 * Everything here is prototype-local and deliberately NOT imported from
 * `@aeci/shared`: the real claim/attestation contracts are net-new work in
 * sibling issues (`packages/shared` claim types — AECI-291; `computeAgreement`
 * / `defaultIntegrationContext` — AECI-300/294). The shapes below mirror those
 * contracts closely so the prototype reads true, but the preview depends on no
 * schema that doesn't exist yet.
 *
 * Spec: `docs/STAGE_1_5_SPEC.md` §3.2 (stored vs context-relative direction),
 * §3.4 (computed agreement / AECi-never-red), §3.5 (confirmed/total sync
 * headline), §7/§8 (the pair page + claim rendering this prototype gates).
 * Vocabulary slugs are from the frozen `docs/DATA_OBJECT_VOCABULARY.md` §4.
 */

// ---------------------------------------------------------------------------
// Types (prototype-local; shaped like the eventual @aeci/shared contracts)
// ---------------------------------------------------------------------------

/** Stored on the integration row, relative to its own endpoints (§3.2). A = source, B = target. */
export type StoredDirection = 'a_to_b' | 'b_to_a' | 'both';

/** Exposed relative to the page's context product (§3.2). */
export type ContextDirection = 'outbound' | 'inbound' | 'both';

/** The §7.1 integration mechanism enum (mirrors `@aeci/shared` `IntegrationMechanismKind`). */
export type MechanismKind = 'native' | 'iPaaS' | 'marketplace-app' | 'api' | 'webhook' | 'partner';

/**
 * The only 1.5-reachable agreement value; `confirmed`/`conflict` arrive with the Stage 2 portal (§3.4).
 *
 * **Superseded — do not copy from here.** The shipped engine
 * (`packages/shared/src/agreement.ts`) now has FOUR states: AECI-605 added
 * `single_source` and narrowed `confirmed` to two *distinct* vendor identities
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §4). This prototype is frozen at the AECI-289
 * concept and is deliberately not kept in lockstep — it exists to show the PO
 * the visual direction, not to be a second implementation.
 */
export type AgreementState = 'unverified' | 'confirmed' | 'conflict';

/** A product endpoint, shaped like `@aeci/shared` `ProductLink` plus two prototype conveniences. */
export interface ProductRef {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly logo_url: string | null;
  /** Rendered in the hero eyebrow ("by Autodesk"). */
  readonly vendorName: string;
  /** Reviews are per-product; the pair has no reviews of its own (§8 reviews link-out). */
  readonly reviewsPath: string;
  /** Per-product rating recap (§5.5 gates display at ≥5 reviews; both fixtures clear it). */
  readonly rating: number;
  readonly reviewCount: number;
}

/** Who asserts a claim (§3.3). In Stage 1.5 only `aeci` is ever written. */
export interface Attestation {
  readonly source: 'aeci' | 'vendor_a' | 'vendor_b';
  readonly asserted: boolean;
  readonly note: string | null;
  /** Dormant in 1.5 — version stamps for the Stage 2 timeline (AECI-303). */
  readonly introducedAt: null;
  readonly deprecatedAt: null;
}

/** Identity triple = (mechanism, dataObject, direction) — the integration row is the anchor (§3.1). */
export interface Claim {
  readonly dataObjectSlug: string;
  readonly dataObjectName: string;
  readonly direction: StoredDirection;
  readonly attestations: readonly Attestation[];
}

/** One integration (mechanism) row between the pair. */
export interface Mechanism {
  readonly id: string;
  readonly kind: MechanismKind;
  readonly name: string;
  /** Editorial "About this integration" copy (mirrors `IntegrationDetail.description`). */
  readonly description: string;
  readonly claims: readonly Claim[];
}

export interface PairFixture {
  /** Endpoint A = the integration's `source_product_id` (§3.2). */
  readonly productA: ProductRef;
  /** Endpoint B = the integration's `target_product_id`. */
  readonly productB: ProductRef;
  readonly mechanisms: readonly Mechanism[];
}

// ---------------------------------------------------------------------------
// Pure logic (mirrors the spec so the eventual @aeci/shared code is proven)
// ---------------------------------------------------------------------------

/**
 * Translate a stored direction into the visitor's frame (§3.2 table). The
 * stored value is never rewritten — only the exposure flips. When the context
 * product is endpoint A, `a_to_b` reads "outbound"; when it is endpoint B, the
 * same claim reads "inbound".
 */
export function contextRelativeDirection(
  stored: StoredDirection,
  contextIsA: boolean,
): ContextDirection {
  if (stored === 'both') return 'both';
  return (stored === 'a_to_b') === contextIsA ? 'outbound' : 'inbound';
}

/**
 * Compute agreement from the attestation set — never stored (§3.4). Only vendor
 * attestations vote; the AECi attestation is the baseline and is excluded, so
 * an AECi-only claim can never be `conflict` (AECi-never-red). With no vendor
 * votes — the Stage 1.5 reality — every claim resolves to `unverified`. The
 * confirmed/conflict branches are implemented so the logic is proven now.
 */
export function computeAgreement(attestations: readonly Attestation[]): AgreementState {
  const votes = attestations.filter((a) => a.source !== 'aeci');
  if (votes.length === 0) return 'unverified';
  const affirms = votes.some((v) => v.asserted);
  const denies = votes.some((v) => !v.asserted);
  if (affirms && denies) return 'conflict';
  return affirms ? 'confirmed' : 'unverified';
}

// ---------------------------------------------------------------------------
// Derived view-model — the single shape all three concepts read
// ---------------------------------------------------------------------------

export interface ClaimView {
  readonly dataObjectSlug: string;
  readonly dataObjectName: string;
  /** Already translated to the context product's frame. */
  readonly direction: ContextDirection;
  readonly agreement: AgreementState;
  /** The single AECi attestation (1.5); source of the provenance note. */
  readonly attestation: Attestation;
}

export interface DirectionGroups {
  readonly outbound: readonly ClaimView[];
  readonly inbound: readonly ClaimView[];
  readonly both: readonly ClaimView[];
}

export interface MechanismView {
  readonly id: string;
  readonly kind: MechanismKind;
  readonly name: string;
  readonly description: string;
  readonly claims: readonly ClaimView[];
  readonly groups: DirectionGroups;
}

export interface PairView {
  /** = productA or productB depending on the orientation toggle. */
  readonly context: ProductRef;
  readonly other: ProductRef;
  /** `['Home', context.name, other.name]`. */
  readonly breadcrumb: readonly string[];
  readonly mechanisms: readonly MechanismView[];
  /** Distinct claims across all mechanisms (all directions). */
  readonly total: number;
  /** Vendor-confirmed claims — 0 in Stage 1.5. */
  readonly confirmed: number;
}

/** Whether the data-flow section has claims (Layer A ships before Layer B seeds — AECI-294). */
export type PairState = 'populated' | 'empty';

/**
 * The single place the mirror + grouping live. Swaps context/other on the
 * orientation, translates every claim's direction, groups by context-relative
 * direction inside each mechanism, and totals. `state: 'empty'` drops the
 * claims (Layer-A-only) so the PO can see the pre-seed state.
 */
export function buildPairView(
  fixture: PairFixture,
  contextIsA: boolean,
  state: PairState = 'populated',
): PairView {
  const context = contextIsA ? fixture.productA : fixture.productB;
  const other = contextIsA ? fixture.productB : fixture.productA;

  const mechanisms: MechanismView[] = fixture.mechanisms.map((m) => {
    const claims: ClaimView[] =
      state === 'empty'
        ? []
        : m.claims.map((c) => ({
            dataObjectSlug: c.dataObjectSlug,
            dataObjectName: c.dataObjectName,
            direction: contextRelativeDirection(c.direction, contextIsA),
            agreement: computeAgreement(c.attestations),
            attestation: c.attestations[0],
          }));

    return {
      id: m.id,
      kind: m.kind,
      name: m.name,
      description: m.description,
      claims,
      groups: {
        outbound: claims.filter((c) => c.direction === 'outbound'),
        inbound: claims.filter((c) => c.direction === 'inbound'),
        both: claims.filter((c) => c.direction === 'both'),
      },
    };
  });

  const total = mechanisms.reduce((n, m) => n + m.claims.length, 0);

  return {
    context,
    other,
    breadcrumb: ['Home', context.name, other.name],
    mechanisms,
    total,
    confirmed: 0,
  };
}

// ---------------------------------------------------------------------------
// Copy — spec-faithful, honest-not-fake. Owned here so no concept can drift it.
// ---------------------------------------------------------------------------

/** Order the three direction groups render in, with their glyph + heading builders. */
export const DIRECTION_ORDER = ['outbound', 'inbound', 'both'] as const;

/** Decorative glyph for a context-relative direction (always paired with text + aria). */
export function directionGlyph(direction: ContextDirection): string {
  return direction === 'outbound' ? '→' : direction === 'inbound' ? '←' : '⇄';
}

/** Visible group heading, e.g. "Sends to Procore" / "Receives from Procore" / "Syncs both ways". */
export function directionHeading(direction: ContextDirection, otherName: string): string {
  switch (direction) {
    case 'outbound':
      return `Sends to ${otherName}`;
    case 'inbound':
      return `Receives from ${otherName}`;
    case 'both':
      return 'Syncs both ways';
  }
}

/** Screen-reader label for a direction (the glyph is `aria-hidden`). */
export function directionAria(direction: ContextDirection, otherName: string): string {
  switch (direction) {
    case 'outbound':
      return `Outbound to ${otherName}`;
    case 'inbound':
      return `Inbound from ${otherName}`;
    case 'both':
      return 'Bidirectional';
  }
}

/** A direction group ready to render — heading/glyph/aria resolved, empty groups dropped. */
export interface RenderedGroup {
  readonly direction: ContextDirection;
  readonly heading: string;
  readonly glyph: string;
  readonly aria: string;
  readonly claims: readonly ClaimView[];
}

/**
 * The non-empty direction groups of a mechanism, in canonical order, with
 * heading/glyph/aria resolved against the context's `other` product. Shared by
 * all three concepts so the §8 grouping display can't drift between them.
 */
export function renderedGroups(mechanism: MechanismView, otherName: string): RenderedGroup[] {
  return DIRECTION_ORDER.map((direction) => ({
    direction,
    heading: directionHeading(direction, otherName),
    glyph: directionGlyph(direction),
    aria: directionAria(direction, otherName),
    claims: mechanism.groups[direction],
  })).filter((g) => g.claims.length > 0);
}

export const COPY = {
  /** Sync headline — breadth first (§3.5). */
  syncHeadline: (total: number): string =>
    total === 1 ? '1 data object syncs' : `${total} data objects sync`,
  /** Who asserted the flows — never a trust checkmark. The confirmation count is
   *  the ratio line's job. (Brand rule: no em dashes.) */
  syncSubline: 'These flows are asserted by AECi.',
  /** Muted metadata, never a red/green hero stat (§3.5). */
  confirmedRatio: (confirmed: number, total: number): string =>
    `${confirmed} of ${total} vendor-confirmed`,
  /** Data-flow section, empty state — Layer A ships before Layer B seeds. */
  emptyHeadline: 'No data flows documented yet',
  /** Neutral agreement badge (§3.4 — never red). */
  badgeLabel: 'Unverified · AECi',
  badgeAria: 'Unverified. Asserted by AECi, not yet vendor-confirmed.',
  /** Provenance affordance (§8). */
  provenanceTitle: 'Provenance',
  provenancePrimary: 'Asserted by AECi',
  provenanceClosing: 'No vendor has confirmed this flow.',
  provenanceAria: (dataObjectName: string): string =>
    `Provenance for ${dataObjectName}: asserted by AECi`,
} as const;

// ---------------------------------------------------------------------------
// Fixture content — real seed pair (Revit ⇄ Procore) + frozen-vocab data objects
// ---------------------------------------------------------------------------

/** Single AECi attestation — the only source written in Stage 1.5 (§3.3). */
function aeci(note: string): Attestation {
  return { source: 'aeci', asserted: true, note, introducedAt: null, deprecatedAt: null };
}

const REVIT: ProductRef = {
  id: 'b0000000-0000-4000-8000-000000000001',
  slug: 'revit',
  name: 'Revit',
  logo_url: null,
  vendorName: 'Autodesk',
  reviewsPath: '/products/revit#reviews',
  rating: 4.3,
  reviewCount: 128,
};

const PROCORE: ProductRef = {
  id: 'b0000000-0000-4000-8000-000000000004',
  slug: 'procore',
  name: 'Procore',
  logo_url: null,
  vendorName: 'Procore',
  reviewsPath: '/products/procore#reviews',
  rating: 4.6,
  reviewCount: 342,
};

/**
 * Revit ⇄ Procore, connected by two mechanisms. RFIs deliberately appears on
 * BOTH mechanisms in opposite directions — the §3.1 "two claims, one per row"
 * case: it must render as two distinct rows, never de-duplicated. total = 8
 * distinct claims → the headline reads "8 data objects sync"; confirmed = 0.
 */
export const PAIR_FIXTURE: PairFixture = {
  productA: REVIT,
  productB: PROCORE,
  mechanisms: [
    {
      id: 'c0000000-0000-4000-8000-000000000001',
      kind: 'marketplace-app',
      name: 'Procore + Autodesk Construction Cloud',
      description:
        'The marketplace connector links published Revit models and drawings into Procore, and brings field-raised RFIs and submittals back to the design team. Configured per project from the Autodesk Construction Cloud side.',
      claims: [
        {
          dataObjectSlug: 'models',
          dataObjectName: 'Models',
          direction: 'a_to_b',
          attestations: [
            aeci('Curated from the Autodesk Construction Cloud marketplace listing, June 2026.'),
          ],
        },
        {
          dataObjectSlug: 'drawings',
          dataObjectName: 'Drawings',
          direction: 'a_to_b',
          attestations: [aeci('Published Revit sheet sets sync into Procore drawings.')],
        },
        {
          dataObjectSlug: 'rfis',
          dataObjectName: 'RFIs',
          direction: 'b_to_a',
          attestations: [aeci('RFIs raised in Procore surface against the Revit model.')],
        },
        {
          dataObjectSlug: 'submittals',
          dataObjectName: 'Submittals',
          direction: 'b_to_a',
          attestations: [aeci('Submittal packages flow from Procore back to the design team.')],
        },
        {
          dataObjectSlug: 'schedules',
          dataObjectName: 'Schedules',
          direction: 'both',
          attestations: [aeci('Project schedule kept in sync in both directions.')],
        },
      ],
    },
    {
      id: 'c0000000-0000-4000-8000-000000000099',
      kind: 'partner',
      name: 'Autodesk to Procore data connector',
      description:
        'A partner-built connector that keeps budgets, change orders, and model-linked RFIs flowing between the two platforms on a scheduled sync. Runs independently of the marketplace app.',
      claims: [
        {
          dataObjectSlug: 'budgets',
          dataObjectName: 'Budgets',
          direction: 'b_to_a',
          attestations: [aeci('Budget data flows from Procore into the model environment.')],
        },
        {
          dataObjectSlug: 'change-orders',
          dataObjectName: 'Change Orders',
          direction: 'b_to_a',
          attestations: [aeci('Change orders originate in Procore.')],
        },
        {
          dataObjectSlug: 'rfis',
          dataObjectName: 'RFIs',
          direction: 'a_to_b',
          attestations: [aeci('The connector also pushes model-linked RFIs to Procore.')],
        },
      ],
    },
  ],
};
