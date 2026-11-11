/**
 * The public field captions (AECI-1614, `packages/shared/src/api/field-captions.ts`): the
 * ONE place that decides what a reader is told about who wrote a group of fields. Pure:
 * no database, no clock, no visitor, because product and pair pages are edge-cached.
 *
 * The rules (rulings 2026-11-05 on AECI-1614):
 *
 *  - **No vendor write, no caption.** `updated_at` and `last_reviewed_at` move on promote,
 *    overrides and "Looks right", so neither may back a date (`maintenance-marker.ts`).
 *    The stamps do, and {@link productEditStamps} is what keeps them honest.
 *  - **`until` needs the plan to have ended.** Description and the profile group (website
 *    and categories) never take it, because both stay editable on Free. Usefulness and the Managed group take the
 *    product's `managed_ended_at`. No row takes it: every row stays editable on Free.
 *    A connector-powered row took its owner's `plan_ended_at` until AECI-1663 (ruling 14)
 *    made it editable on Free too.
 *  - **A row's holder is named only when it holds the row.** An unheld row names the
 *    vendors that affirm a flow on it, with the date of the latest affirmation. A denial
 *    is not maintenance, so it names nobody.
 *  - **A correction shows while it is still true.** The newest correction per field,
 *    lifted or not (ADR 0039 keeps AECi's value after a lift), and only while its value
 *    equals the live one. The caller supplies the live value. A correction that cleared
 *    the value is marked `cleared` (AECI-1628), and the page says "Removed by".
 */

import type {
  FieldCaption,
  FieldCorrection,
  FieldOverrideValue,
  ProductFieldCaptions,
} from '@aeci/shared';
import { isFacetOverrideField } from '@aeci/shared';
import { isNewerCorrection, scalarCorrectionHolds } from '@aeci/shared/company-facts-display';
import { compareText } from '@aeci/shared/text-sort';

/** The stamps on one product, as the read config selects them. */
export interface ProductCaptionInput {
  /** The primary vendor's name. `null` for a product no vendor is linked to. */
  vendorName: string | null;
  /** Whether the group has anything to caption: a caption under nothing says nothing. */
  hasDescription: boolean;
  hasUsefulness: boolean;
  hasProfile: boolean;
  descriptionEditedAt: string | null;
  profileEditedAt: string | null;
  usefulnessEditedAt: string | null;
  managedEditedAt: string | null;
  managedEndedAt: string | null;
}

/** One Managed-only group: `until` once the plan ended, else `updated`. */
function managedCaption(
  vendorName: string,
  editedAt: string | null,
  endedAt: string | null,
): FieldCaption | null {
  if (!editedAt) return null;
  return endedAt
    ? { form: 'until', vendor_names: [vendorName], date: endedAt }
    : { form: 'updated', vendor_names: [vendorName], date: editedAt };
}

/** The four product group captions. */
export function productGroupCaptions(
  input: ProductCaptionInput,
): Omit<ProductFieldCaptions, 'corrections'> {
  const name = input.vendorName;
  if (!name) return { description: null, profile: null, usefulness: null, managed: null };
  return {
    description:
      input.hasDescription && input.descriptionEditedAt
        ? { form: 'updated', vendor_names: [name], date: input.descriptionEditedAt }
        : null,
    profile:
      input.hasProfile && input.profileEditedAt
        ? { form: 'updated', vendor_names: [name], date: input.profileEditedAt }
        : null,
    usefulness: input.hasUsefulness
      ? managedCaption(name, input.usefulnessEditedAt, input.managedEndedAt)
      : null,
    managed: managedCaption(name, input.managedEditedAt, input.managedEndedAt),
  };
}

/** A vote as the row configs load it. `createdAt` and the name are optional so a
 *  hand-built fixture without them reads as "names nobody". */
export interface CaptionVote {
  source: string;
  asserted: boolean;
  retractedAt: string | null;
  createdAt?: string;
  /** `hiddenAt` (AECI-1238): a hidden company is named on no caption. */
  attestedByVendor?: { companyName: string; hiddenAt?: string | null } | null;
}

/** The inputs of one integration or evidenced-pair row. */
export interface RowCaptionInput {
  /** `isVendorHeld`: claimed, or vendor-created. */
  held: boolean;
  /** The row's `built_by_vendor`. */
  owner: { companyName: string } | null;
  vendorEditedAt: string | null;
  /** The row's PUBLIC claims' live votes. */
  votes: readonly CaptionVote[];
}

/** The vendors that affirm a flow on the row, A to Z, with the latest affirmation. A
 *  re-assertion retracts and inserts, so `created_at` of a live vote is its latest. */
function affirmingVendors(votes: readonly CaptionVote[]): { names: string[]; date: string } | null {
  const names = new Set<string>();
  let date = '';
  for (const vote of votes) {
    if (vote.source === 'aeci' || !vote.asserted || vote.retractedAt !== null) continue;
    if (vote.attestedByVendor?.hiddenAt != null) continue;
    const name = vote.attestedByVendor?.companyName;
    if (!name || !vote.createdAt) continue;
    names.add(name);
    if (vote.createdAt > date) date = vote.createdAt;
  }
  return names.size > 0 ? { names: [...names].sort(compareText), date } : null;
}

/** The "Maintained by" caption of one row, or `null`. */
export function rowCaption(input: RowCaptionInput): FieldCaption | null {
  if (input.held) {
    if (!input.owner || !input.vendorEditedAt) return null;
    return { form: 'updated', vendor_names: [input.owner.companyName], date: input.vendorEditedAt };
  }
  const affirming = affirmingVendors(input.votes);
  return affirming
    ? { form: 'updated', vendor_names: affirming.names, date: affirming.date }
    : null;
}

/** One `field_overrides` row as the public read selects it (`lib/field-corrections.ts`).
 *  `live` is the column's value now. It is `null` for a facet, which has no column. */
export interface CorrectionRow {
  id: string;
  entityId: string;
  field: string;
  value: FieldOverrideValue | null;
  sourceUrl: string | null;
  setAt: string;
  live: string | number | null;
}

/** Whether two slug lists hold the same terms, ignoring order and repeats. */
function sameSlugs(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((slug) => right.has(slug));
}

/**
 * The corrections to show on one record. `facets` is the product's live slugs, keyed by
 * override field (`category_slugs`, ...). A facet with no live set shows nothing, so a
 * caller that did not load them fails closed. Ordered by field, an identifier, so a
 * cached page is byte-stable whatever order the read returned.
 */
export function toFieldCorrections(
  rows: readonly CorrectionRow[],
  facets?: Readonly<Record<string, readonly string[]>>,
): FieldCorrection[] {
  const newest = new Map<string, CorrectionRow>();
  for (const row of rows) {
    const held = newest.get(row.field);
    if (!held || isNewerCorrection(row, held)) {
      newest.set(row.field, row);
    }
  }
  const out: FieldCorrection[] = [];
  for (const row of newest.values()) {
    if (!correctionStillTrue(row, facets)) continue;
    out.push({
      field: row.field,
      date: row.setAt,
      source_url: row.sourceUrl,
      cleared: correctionCleared(row.value),
    });
  }
  return out.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

/** AECI-1628: the correction removed the value: `null`, or an empty facet. */
export function correctionCleared(value: FieldOverrideValue | null | undefined): boolean {
  return value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

function correctionStillTrue(
  row: CorrectionRow,
  facets?: Readonly<Record<string, readonly string[]>>,
): boolean {
  if (isFacetOverrideField(row.field)) {
    const live = facets?.[row.field];
    return live !== undefined && Array.isArray(row.value) && sameSlugs(row.value, live);
  }
  return scalarCorrectionHolds(row.value, row.live);
}

// ─── The write side: when a stamp moves ─────────────────────────────────────────

/** The product columns and facets a vendor PATCH can change, before and after. */
export interface ProductGroupValues {
  description: string | null;
  website: string | null;
  categories: readonly string[];
  usefulness: unknown;
  toolIntegrationsUrl: string | null;
  apiDocsUrl: string | null;
  trades: readonly string[];
  audiences: readonly string[];
  phases: readonly string[];
}

/** Compare two stored JSON values, ignoring key order. `undefined` and `null` agree. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/**
 * The stamp columns a vendor product write earns: each group whose value actually changed.
 * An unchanged resend earns none. Facets compare as sets. The caller keeps these OUT of
 * the audit before/after, as it keeps `updated_at` out.
 */
export function productEditStamps(
  before: ProductGroupValues,
  after: ProductGroupValues,
  now: string,
): {
  descriptionEditedAt?: string;
  profileEditedAt?: string;
  usefulnessEditedAt?: string;
  managedEditedAt?: string;
} {
  const managedMoved =
    (before.toolIntegrationsUrl ?? null) !== (after.toolIntegrationsUrl ?? null) ||
    (before.apiDocsUrl ?? null) !== (after.apiDocsUrl ?? null) ||
    !sameSlugs(before.trades, after.trades) ||
    !sameSlugs(before.audiences, after.audiences) ||
    !sameSlugs(before.phases, after.phases);
  const profileMoved =
    (before.website ?? null) !== (after.website ?? null) ||
    !sameSlugs(before.categories, after.categories);
  return {
    ...((before.description ?? null) !== (after.description ?? null)
      ? { descriptionEditedAt: now }
      : {}),
    ...(profileMoved ? { profileEditedAt: now } : {}),
    ...(canonicalJson(before.usefulness) !== canonicalJson(after.usefulness)
      ? { usefulnessEditedAt: now }
      : {}),
    ...(managedMoved ? { managedEditedAt: now } : {}),
  };
}

/** The stamps a product carries from birth when a vendor write creates it. */
export function newProductEditStamps(
  created: Omit<ProductGroupValues, 'website' | 'toolIntegrationsUrl' | 'apiDocsUrl'> & {
    website?: string | null;
    toolIntegrationsUrl?: string | null;
    apiDocsUrl?: string | null;
  },
  now: string,
): ReturnType<typeof productEditStamps> {
  return productEditStamps(
    {
      description: null,
      website: null,
      categories: [],
      usefulness: null,
      toolIntegrationsUrl: null,
      apiDocsUrl: null,
      trades: [],
      audiences: [],
      phases: [],
    },
    { website: null, toolIntegrationsUrl: null, apiDocsUrl: null, ...created },
    now,
  );
}
