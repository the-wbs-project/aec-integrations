import { z } from 'zod';

import {
  INTEGRATION_EDIT_FIELDS,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
  integrationEditFieldSchema,
} from './integration-edits';
import { IntegrationMechanismKindSchema } from './integrations';

/**
 * A vendor creates an integration (AECI-1011 / ADR 0035 decision 7 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7).
 *
 *   POST /api/vendor/integrations — the caller's vendor lists a new integration (201).
 *
 * Six rules the shapes encode:
 *
 * 1. **The caller owns the new row.** `built_by_vendor_id` is the session's vendor,
 *    `origin` is `'vendor'`, and `claimed_at` is set at once, so promote never
 *    writes it (the AECI-1005 fence). Nothing in the body says who owns it.
 * 2. **One endpoint is the caller's.** `product_id` must be a product the caller's
 *    vendor holds through `product_vendors`; `counterpart_product_id` must be a
 *    promoted product. They must differ. Either miss is the same `404`.
 * 3. **The standard fields are the owner edit's eleven** (AECI-1006), with the same
 *    caps and value rules. `name`, `mechanism_kind` and `direction` are required,
 *    because a pair page cannot render without them.
 * 4. **Never connector-powered** (AECI-1003 decision 9). There is no `powered_by`
 *    field, and `iPaaS` and `integrator` are refused. A vendor cannot create a row
 *    that decision 9 would then freeze against its own owner.
 * 5. **`direction` is framed against `product_id`**, the caller's own endpoint,
 *    which becomes the row's source.
 * 6. **A duplicate is never refused** (decision 10, AECI-1012 ruling 2026-09-22).
 *    The 201 lists the strong matches in `possible_duplicates` as a warning.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * for API consumers and logs; the portal renders its own copy.
 */

/**
 * `POST /api/vendor/integrations`.
 *
 * `.strict()`: an unknown key (`powered_by_product_id`, `built_by_vendor_id`,
 * `origin`, `notes`) is a `400`, never a silently dropped field.
 */
export const CreateVendorIntegrationSchema = z
  .object({
    product_id: z.string().uuid(),
    counterpart_product_id: z.string().uuid(),
    name: integrationEditFieldSchema('name'),
    mechanism_kind: integrationEditFieldSchema('mechanism_kind'),
    mechanism_name: integrationEditFieldSchema('mechanism_name'),
    direction: integrationEditFieldSchema('direction'),
    description: integrationEditFieldSchema('description'),
    listing_url: integrationEditFieldSchema('listing_url'),
    docs_url: integrationEditFieldSchema('docs_url'),
    website: integrationEditFieldSchema('website'),
    mechanism_url: integrationEditFieldSchema('mechanism_url'),
    pricing_model: integrationEditFieldSchema('pricing_model'),
    maturity: integrationEditFieldSchema('maturity'),
  })
  .strict()
  .superRefine((body, ctx) => {
    for (const field of INTEGRATION_EDIT_FIELDS) {
      if (INTEGRATION_EDIT_REQUIRED_FIELDS.has(field) && (body[field] ?? null) === null) {
        ctx.addIssue({ code: 'custom', path: [field], message: 'This field is required' });
      }
    }
    if (body.product_id === body.counterpart_product_id) {
      ctx.addIssue({
        code: 'custom',
        path: ['counterpart_product_id'],
        message: 'An integration needs two different products',
      });
    }
  });
export type CreateVendorIntegrationInput = z.input<typeof CreateVendorIntegrationSchema>;
export type CreateVendorIntegrationParsed = z.output<typeof CreateVendorIntegrationSchema>;

/**
 * An existing integration that strongly matches the one just created (AECI-1012,
 * option 1C): the same two products in either order, the same connector (none),
 * and an owner that is the caller or unknown. Retired rows are included, marked,
 * so a vendor that retired its own row can restore it instead.
 */
export const PossibleDuplicateIntegrationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  /** `same` when the match runs from the caller's product to the counterpart,
   *  `reversed` when it is stored the other way round. */
  orientation: z.enum(['same', 'reversed']),
  /** The recorded owner, or `null` when none is on file. */
  owner: z.object({ id: z.string(), name: z.string() }).nullable(),
  claimed: z.boolean(),
  retired: z.boolean(),
});
export type PossibleDuplicateIntegration = z.infer<typeof PossibleDuplicateIntegrationSchema>;

/** The row as the create left it. Timestamps are ISO-8601. */
export const CreatedVendorIntegrationSchema = z.object({
  id: z.string().uuid(),
  source_product_id: z.string().uuid(),
  target_product_id: z.string().uuid(),
  origin: z.literal('vendor'),
  owner_vendor_id: z.string(),
  claimed_at: z.string(),
  maintained_by: z.literal('vendor'),
  last_reviewed_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CreatedVendorIntegration = z.infer<typeof CreatedVendorIntegrationSchema>;

export const CreateVendorIntegrationResponseSchema = z.object({
  integration: CreatedVendorIntegrationSchema,
  /** Strong matches that already existed when the row was created. A warning,
   *  never a refusal. Empty when there were none. */
  possible_duplicates: z.array(PossibleDuplicateIntegrationSchema),
});
export type CreateVendorIntegrationResponse = z.infer<typeof CreateVendorIntegrationResponseSchema>;

/**
 * One create event addressed to this vendor (`kind: 'integration_create'`) on
 * `GET /api/vendor/notifications`.
 *
 * Written in the SAME batch as the create, as a `notification.sent` audit row, to
 * every vendor of either endpoint product other than the creator. Creates go live
 * with no moderation (decision 8), so this is how the other side learns a new
 * integration now names its product, and a contest is its recourse.
 */
export const VendorIntegrationCreateNotificationSchema = z.object({
  kind: z.literal('integration_create'),
  id: z.string().uuid(),
  integration_id: z.string().uuid(),
  integration_name: z.string().nullable(),
  /** The vendor that created it, by name as it was at create time. */
  owner_name: z.string().nullable(),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorIntegrationCreateNotification = z.infer<
  typeof VendorIntegrationCreateNotificationSchema
>;
