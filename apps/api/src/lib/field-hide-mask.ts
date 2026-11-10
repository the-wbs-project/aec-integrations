/**
 * The public mask of the value hide (AECI-1238 section B, §11d.7). Pure: it takes a
 * mapped public payload and the active hides (`groupHides` over the `*HidesQuery`
 * reads in `lib/field-hides.ts`, run in the page's own batch), and returns the payload
 * with every hidden value `null`.
 *
 * Three rules, one place:
 *
 *  1. **The value is `null`.** Under the field's own key, and in the company facts.
 *  2. **The field is named in `under_review`**, sorted, on the shapes that carry it, so
 *     the page renders the "Under review" marker in the value's slot. Absent when
 *     nothing is hidden, which the schema reads as none. A list item masks silently: a
 *     card shows no marker.
 *  3. **No caption speaks for a hidden value.** Its "Corrected by" entry goes, and on a
 *     product a hidden description drops the description group's "Maintained by".
 *
 * Nothing of the hide row reaches here but the field name, so the reason, note and
 * source cannot be published by a mapper.
 */

import type {
  CompanyFacts,
  FieldCorrection,
  IntegrationListItem,
  ProductDetail,
  ProductIntegrationItem,
  ProductPairMechanism,
  ProductPairResponse,
  VendorDetail,
  VendorListItem,
} from '@aeci/shared';

import { hiddenOf, maskHiddenFields } from './field-hides';

/** Active hides by entity id (`groupHides`). */
export type HidesByEntity = ReadonlyMap<string, readonly string[]>;

const COMPANY_FACT_KEYS = [
  'headquarters',
  'founded_year',
  'company_size',
  'ownership_type',
  'parent_company',
  'funding_stage',
] as const satisfies readonly (keyof CompanyFacts)[];

function withoutHidden(
  corrections: readonly FieldCorrection[] | undefined,
  hidden: readonly string[],
): FieldCorrection[] | undefined {
  if (!corrections) return corrections;
  return corrections.filter((c) => !hidden.includes(c.field));
}

function maskFacts(facts: CompanyFacts, hidden: readonly string[]): CompanyFacts {
  const next = { ...facts };
  for (const key of COMPANY_FACT_KEYS) if (hidden.includes(key)) next[key] = null;
  return next;
}

/** A vendor list card: the two facts it carries go `null`, no marker. */
export function maskVendorListItem(item: VendorListItem, hides: HidesByEntity): VendorListItem {
  return maskHiddenFields(item, hiddenOf(hides, item.id));
}

/** `GET /api/vendors/:slug`. */
export function maskVendorDetail(body: VendorDetail, hides: HidesByEntity): VendorDetail {
  const hidden = hiddenOf(hides, body.id);
  if (hidden.length === 0) return body;
  return {
    ...maskHiddenFields(body, hidden),
    company_facts: maskFacts(body.company_facts, hidden),
    corrections: withoutHidden(body.corrections, hidden),
    under_review: [...hidden],
  };
}

/** A bare integration list item: only `mechanism_name` is hideable on it. Silent. */
export function maskIntegrationListItem<T extends IntegrationListItem>(
  item: T,
  hides: HidesByEntity,
): T {
  return maskHiddenFields(item, hiddenOf(hides, item.id));
}

/** One endpoint row on a product page. */
export function maskProductIntegrationItem(
  item: ProductIntegrationItem,
  hides: HidesByEntity,
): ProductIntegrationItem {
  const hidden = hiddenOf(hides, item.id);
  if (hidden.length === 0) return item;
  return {
    ...maskHiddenFields(item, hidden),
    corrections: withoutHidden(item.corrections, hidden),
    under_review: [...hidden],
  };
}

/**
 * `GET /api/products/:slug`. The product, its endpoint rows, its powered rows (bare
 * items, silent) and the primary vendor's two facts in `vendor_facts` (silent: the
 * vendor page carries that marker).
 */
export function maskProductDetail(body: ProductDetail, hides: HidesByEntity): ProductDetail {
  const hidden = hiddenOf(hides, body.id);
  const vendorHidden = body.vendor ? hiddenOf(hides, body.vendor.id) : [];
  const masked = hidden.length ? maskHiddenFields(body, hidden) : body;
  return {
    ...masked,
    vendor_facts: vendorHidden.length
      ? maskHiddenFields(body.vendor_facts, vendorHidden)
      : body.vendor_facts,
    integrations_as_source: body.integrations_as_source.map((r) =>
      maskProductIntegrationItem(r, hides),
    ),
    integrations_as_target: body.integrations_as_target.map((r) =>
      maskProductIntegrationItem(r, hides),
    ),
    integrations_as_connector: body.integrations_as_connector.map((r) =>
      maskIntegrationListItem(r, hides),
    ),
    captions:
      body.captions && hidden.length
        ? {
            ...body.captions,
            description: hidden.includes('description') ? null : body.captions.description,
            corrections: withoutHidden(body.captions.corrections, hidden) ?? [],
          }
        : body.captions,
    ...(hidden.length ? { under_review: [...hidden] } : {}),
  };
}

/** One mechanism on a pair page. */
export function maskPairMechanism(
  mechanism: ProductPairMechanism,
  hides: HidesByEntity,
): ProductPairMechanism {
  const hidden = hiddenOf(hides, mechanism.id);
  if (hidden.length === 0) return mechanism;
  return {
    ...maskHiddenFields(mechanism, hidden),
    corrections: withoutHidden(mechanism.corrections, hidden),
    under_review: [...hidden],
  };
}

/** `GET /api/products/:slug/integrations/:otherSlug`. */
export function maskPairResponse(
  body: ProductPairResponse,
  hides: HidesByEntity,
): ProductPairResponse {
  return { ...body, mechanisms: body.mechanisms.map((m) => maskPairMechanism(m, hides)) };
}
