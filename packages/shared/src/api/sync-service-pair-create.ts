import { z } from 'zod';

import { INTEGRATION_EDIT_REQUIRED_FIELDS, integrationEditFieldSchema } from './integration-edits';

/**
 * A Sync Service adds its own pair (AECI-2040, rulings 7 and 11 on AECI-2035,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.7).
 *
 *   POST /api/vendor/sync-service-pairs — the caller's Sync Service delivers a new pair (201).
 *
 * A sibling of `POST /api/vendor/integrations` (`./integration-create`), not an
 * extension of it. That route's `.strict()` body refuses a connector by design (ruling
 * 1 of 2026-09-23), and that ruling stands for Integration platforms and unclassified
 * connectors. Keeping the two bodies apart keeps both contracts and their refusals
 * intact.
 *
 * Five rules the shapes encode:
 *
 * 1. **The connector is the caller's Sync Service.** `connector_product_id` must be a
 *    listed product the caller's vendor holds through `product_vendors`, of role
 *    `connector` or `hybrid` and kind `sync_service` (`isSyncService`).
 * 2. **The two endpoints are any two listed products.** Neither needs to be the
 *    caller's, an owned record does not block it, and neither may be the connector.
 * 3. **The row lands in `connector_evidenced_pairs`**, born claimed with `origin =
 *    'vendor'`, so promote never writes it. Nothing in the body says who owns it.
 * 4. **The fields are the nine an owner edits on that table**
 *    (`CONNECTOR_POWERED_EDIT_FIELDS`): the table has no `mechanism_kind`, so the body
 *    has none either. `name` and `direction` are required.
 * 5. **`direction` is framed against `product_id`**, the first product named. The
 *    server stores it in the table's canonical A/B frame.
 *
 * A pair already on record through the same connector, live or retired, is refused
 * with `409 INTEGRATION_ALREADY_ON_RECORD` (the unique index would refuse it anyway).
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are for
 * API consumers and logs; the portal renders its own copy.
 */
/** The fields a new Sync Service pair must carry: the required edit fields this table
 *  has. `mechanism_kind` is the third required edit field, and the table has no column
 *  for it. */
export const SYNC_SERVICE_PAIR_REQUIRED_FIELDS = [...INTEGRATION_EDIT_REQUIRED_FIELDS].filter(
  (field): field is 'name' | 'direction' => field !== 'mechanism_kind',
);

export const CreateSyncServicePairSchema = z
  .object({
    connector_product_id: z.string().uuid(),
    product_id: z.string().uuid(),
    counterpart_product_id: z.string().uuid(),
    name: integrationEditFieldSchema('name'),
    mechanism_name: integrationEditFieldSchema('mechanism_name'),
    direction: integrationEditFieldSchema('direction'),
    description: integrationEditFieldSchema('description'),
    listing_url: integrationEditFieldSchema('listing_url'),
    docs_url: integrationEditFieldSchema('docs_url'),
    pricing_model: integrationEditFieldSchema('pricing_model'),
    maturity: integrationEditFieldSchema('maturity'),
    pricing_url: integrationEditFieldSchema('pricing_url'),
  })
  .strict()
  .superRefine((body, ctx) => {
    for (const field of SYNC_SERVICE_PAIR_REQUIRED_FIELDS) {
      if ((body[field] ?? null) === null) {
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
    for (const field of ['product_id', 'counterpart_product_id'] as const) {
      if (body[field] === body.connector_product_id) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'The Sync Service cannot be one of the two products it connects',
        });
      }
    }
  });
export type CreateSyncServicePairInput = z.input<typeof CreateSyncServicePairSchema>;
export type CreateSyncServicePairParsed = z.output<typeof CreateSyncServicePairSchema>;

/** The pair as the create left it, in the table's canonical frame. ISO-8601 times. */
export const CreatedSyncServicePairSchema = z.object({
  id: z.string().uuid(),
  connector_product_id: z.string().uuid(),
  /** The lower id of the two endpoints (`product_a_id < product_b_id`). */
  product_a_id: z.string().uuid(),
  product_b_id: z.string().uuid(),
  origin: z.literal('vendor'),
  owner_vendor_id: z.string(),
  claimed_at: z.string(),
  maintained_by: z.literal('vendor'),
  last_reviewed_at: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type CreatedSyncServicePair = z.infer<typeof CreatedSyncServicePairSchema>;

export const CreateSyncServicePairResponseSchema = z.object({
  pair: CreatedSyncServicePairSchema,
});
export type CreateSyncServicePairResponse = z.infer<typeof CreateSyncServicePairResponseSchema>;

/**
 * `details` on `409 INTEGRATION_ALREADY_ON_RECORD`: the row that already holds the
 * pair through this connector. `anchor` says which table. `owned_by_caller` and
 * `retired` tell the portal what to offer: open it, claim it, or restore it.
 */
export const SyncServicePairOnRecordDetailsSchema = z.object({
  existing_id: z.string(),
  anchor: z.enum(['integration', 'evidenced_pair']),
  retired: z.boolean(),
  owned_by_caller: z.boolean(),
  claimed: z.boolean(),
});
export type SyncServicePairOnRecordDetails = z.infer<typeof SyncServicePairOnRecordDetailsSchema>;
