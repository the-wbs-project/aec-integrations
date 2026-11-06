import { z } from 'zod';

/**
 * The public field captions (AECI-1614; Terms "How listings are sourced"; Vendor Terms;
 * Listing Accuracy). A reader sees who wrote a group of fields, that AECi did not verify
 * it, and how fresh it is. The server decides the form (`apps/api/src/lib/field-captions.ts`)
 * and the page renders it verbatim, so a client cannot show a caption the rules forbid.
 *
 * Everything here is a stored fact and a pure function of the record. Product and pair
 * pages are edge-cached, so nothing depends on the visitor or the clock.
 *
 * Additive and `.optional()` on the payloads that carry them, for SSR/API deploy skew:
 * absent reads as no caption. The API always sends them.
 *
 * i18n note: framework-agnostic package (no `$localize`). The page renders the words.
 */

/**
 * `updated`: "Maintained by {vendor} · updated {date}". The group has a vendor write and
 * the vendor can still edit it.
 * `until`: "Maintained by {vendor} until {date}". The vendor wrote it and its plan ended.
 */
export const FIELD_CAPTION_FORMS = ['updated', 'until'] as const;
export type FieldCaptionForm = (typeof FIELD_CAPTION_FORMS)[number];

/**
 * A "Maintained by" caption. `vendor_names` is a list because an unclaimed row can have
 * two attesting vendors. Sorted A to Z, never empty. A product group or a held row names
 * one. `date` is the ISO instant of the vendor write or the plan end.
 */
export const FieldCaptionSchema = z.object({
  form: z.enum(FIELD_CAPTION_FORMS),
  vendor_names: z.array(z.string().min(1)).min(1),
  date: z.string(),
});
export type FieldCaption = z.infer<typeof FieldCaptionSchema>;

/**
 * "Corrected by AEC Integrations on {date}", plus a source link when recorded. Present
 * while the correction's value is still the live value, so it survives a lift (ADR 0039)
 * and goes when the vendor changes the value. `field` is the override's wire name
 * (`field_overrides.field`). `source_url` is `null` on a correction older than AECI-1614.
 * Nothing else of the correction row is public: no reason, note or actor.
 */
export const FieldCorrectionSchema = z.object({
  field: z.string(),
  date: z.string(),
  source_url: z.string().nullable(),
});
export type FieldCorrection = z.infer<typeof FieldCorrectionSchema>;

/** A list of corrections on one record, ordered by field. */
export const FieldCorrectionsSchema = z.array(FieldCorrectionSchema);

/**
 * `ProductDetail.captions`: one caption per product field group, `null` when the group
 * has no vendor write (ruling 2026-11-05). `description` and `profile` never take `until`,
 * because both stay editable on the Free plan. `profile` covers the website and categories.
 * `managed` covers the two doc URLs, trades,
 * audiences and phases.
 */
export const ProductFieldCaptionsSchema = z.object({
  description: FieldCaptionSchema.nullable(),
  profile: FieldCaptionSchema.nullable(),
  usefulness: FieldCaptionSchema.nullable(),
  managed: FieldCaptionSchema.nullable(),
  corrections: FieldCorrectionsSchema,
});
export type ProductFieldCaptions = z.infer<typeof ProductFieldCaptionsSchema>;
