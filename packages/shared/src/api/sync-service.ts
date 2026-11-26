/**
 * A Sync Service's "What it syncs" block (AECI-2046, ruling 15 on AECI-2035,
 * `docs/STAGE_1_5_SPEC.md` §13.13).
 *
 * Two parts, both on `ProductDetail`, both `null` unless the product is a Sync
 * Service (`isSyncService`):
 *
 * - `sync_facts`: three short facts AECi curates. How often it syncs, who supports
 *   it, and how setup works. Only an AECi admin writes them
 *   (`PATCH /api/admin/products/:id/sync-facts`). The vendor does not: a
 *   vendor-editable version is a legal `decision` that has not been ruled.
 * - `what_it_syncs`: the record types (`data_object` terms) across the pairs it
 *   delivers, rolled up by the API (`apps/api/src/lib/what-it-syncs.ts`).
 */
import { z } from 'zod';

import { HttpsUrlSchema } from './https-url';

/** The longest value each fact may hold, in characters, after trimming. */
export const SYNC_FACT_MAX_LENGTH = {
  sync_frequency: 120,
  sync_support: 160,
  sync_setup: 280,
} as const;

/** One fact on the write: trimmed, blank reads as `null` (clears it), capped. */
function syncFact(max: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(max))
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();
}

/**
 * Body of `PATCH /api/admin/products/:id/sync-facts`. All four keys are required, so
 * the form always sends the whole set and a missing key is a 400, not a silent clear.
 * `null` or a blank string clears that fact. `source_url` is the https link the facts
 * come from. It is required while any fact is set, because the Terms promise that text
 * we write on a listing a vendor maintains is marked as ours "with its source and date".
 * Clearing every fact clears it too. Strict: an unknown key is a 400.
 */
export const AdminSetSyncFactsSchema = z
  .object({
    sync_frequency: syncFact(SYNC_FACT_MAX_LENGTH.sync_frequency),
    sync_support: syncFact(SYNC_FACT_MAX_LENGTH.sync_support),
    sync_setup: syncFact(SYNC_FACT_MAX_LENGTH.sync_setup),
    source_url: z.union([z.literal('').transform(() => null), HttpsUrlSchema]).nullable(),
  })
  .strict()
  .superRefine((body, ctx) => {
    const anyFact = body.sync_frequency || body.sync_support || body.sync_setup;
    if (anyFact && !body.source_url) {
      ctx.addIssue({
        code: 'custom',
        path: ['source_url'],
        message: 'Give the https link these facts come from.',
      });
    }
  })
  .transform((body) => {
    const anyFact = body.sync_frequency || body.sync_support || body.sync_setup;
    return anyFact ? body : { ...body, source_url: null };
  });
export type AdminSetSyncFactsInput = z.input<typeof AdminSetSyncFactsSchema>;

/**
 * The three facts as stored and read, each `null` when AECi has not recorded it, with
 * their source link and the date they were last recorded. Both `null` with no fact.
 */
export const SyncFactsSchema = z.object({
  sync_frequency: z.string().nullable(),
  sync_support: z.string().nullable(),
  sync_setup: z.string().nullable(),
  source_url: z.string().nullable(),
  recorded_at: z.string().nullable(),
});
export type SyncFacts = z.infer<typeof SyncFactsSchema>;

/** Response of the same PATCH. `changed: false` means nothing was written or purged. */
export const AdminSetSyncFactsResponseSchema = SyncFactsSchema.extend({
  id: z.string().uuid(),
  changed: z.boolean(),
});
export type AdminSetSyncFactsResponse = z.infer<typeof AdminSetSyncFactsResponseSchema>;

/**
 * One record type in the roll-up. `pair_count` is how many of the delivered pairs
 * carry it, `both_ways` how many of those move it both ways, `one_way` how many move
 * it one way. `both_ways + one_way = pair_count`.
 */
export const WhatItSyncsObjectSchema = z.object({
  slug: z.string(),
  /** The controlled `data_object` vocabulary name (`docs/DATA_OBJECT_VOCABULARY.md`). */
  name: z.string(),
  pair_count: z.number().int().min(1),
  both_ways: z.number().int().min(0),
  one_way: z.number().int().min(0),
});
export type WhatItSyncsObject = z.infer<typeof WhatItSyncsObjectSchema>;

/**
 * The roll-up. `pair_count` is the distinct pairs the Sync Service delivers, the same
 * set "Integrations it delivers" counts. `pairs_with_flows` is how many of them list
 * at least one record type. `objects` is A to Z by name (`compareText`), slug on a tie.
 * No plan input moves it.
 */
export const WhatItSyncsSchema = z.object({
  pair_count: z.number().int().min(0),
  pairs_with_flows: z.number().int().min(0),
  objects: z.array(WhatItSyncsObjectSchema),
});
export type WhatItSyncs = z.infer<typeof WhatItSyncsSchema>;
