import { z } from 'zod';

import { CONNECTOR_MANAGED_BY } from './promote-connector';

/**
 * The per-iPaaS management cutoff (AECI-720 — `docs/DATABASE_SCHEMA.md` §9a.1).
 *
 *   PATCH /api/admin/connector-catalogs/:id — flip `connector_catalogs.managed_by`
 *
 * behind `requireAdmin()`. Flipping a catalogue to `vendor` freezes the review lane for
 * that iPaaS and no other: from then on `POST /api/promote/connector-catalog` refuses
 * every page for it with `CATALOG_VENDOR_MANAGED`.
 *
 * ── WHY THE FLAG IS NOT ON THE PROMOTE WIRE ─────────────────────────────────────
 * It is held AND enforced on this side because the review app is the component being
 * decommissioned, so the surviving system owns who-controls-what. `managedBy` was
 * therefore removed from `PromoteConnectorCatalogSchema`: a catalogue starts `review` by
 * column default, and this endpoint is the only thing that ever moves it.
 *
 * ── THE FLAG IS REVERSIBLE; THE DATA DIRECTION IS NOT ───────────────────────────
 * "One-way forever" governs the DATA — the review app never writes over AECi's copy, and
 * the promote rejection delivers that unconditionally while the flag reads `vendor`.
 * The flag itself is an operator control that moves both ways, because
 * `STAGE_2_SPEC.md` §8.9(4) makes this cutoff the mechanism that answers "is the feed
 * still arriving?" for a connector seat that carries no `vendor_entitlements` row and so
 * has no expiry cron to sweep it. That duty is only actionable if a lane can be
 * reclaimed when a vendor stops feeding. Reversing the flag re-opens the promote lane
 * going forward and does nothing else — it reconciles nothing the vendor wrote.
 *
 * ── NO SEAT IS GRANTED HERE ─────────────────────────────────────────────────────
 * `vendorId` records WHO the catalogue was handed to, in the audit row. It grants
 * nothing: §8.9(2) fences the connector seat off from `vendor_entitlements` entirely
 * ("no row, no tier, no capability id, no migration"), and §8.9(3) leaves provisioning
 * — no route writes `profiles.role = 'vendor_admin'` today — to AECI-722 / AECI-724.
 */

/** Who authors a catalogue. Lockstep with `connector_catalogs_managed_by_check`. */
export const ConnectorManagedBySchema = z.enum(CONNECTOR_MANAGED_BY);
export type ConnectorManagedBy = z.infer<typeof ConnectorManagedBySchema>;

export const SetConnectorCatalogManagementSchema = z.object({
  /** The state to move TO. A request naming the current state is a 422, not a no-op. */
  managedBy: ConnectorManagedBySchema,
  /**
   * The vendor taking the catalogue over. Optional because reclaiming a lane
   * (`vendor` → `review`) has no vendor to name, and because the partnership track may
   * settle before the vendor has a catalogue record. Validated against `vendors` in the
   * preload gate rather than trusted: a typo would otherwise park a dangling id in the
   * audit metadata for AECI-722's screen to render.
   */
  vendorId: z.string().uuid().optional(),
  reason: z.string().max(500).optional(),
});
export type SetConnectorCatalogManagementInput = z.infer<
  typeof SetConnectorCatalogManagementSchema
>;

/**
 * The readout after the flip.
 *
 * Nullable, not optional, on everything that can genuinely be absent — the R10 rule from
 * `./admin-entitlements`: a required field shipping as `undefined` from a missed
 * construction site is exactly what `validateResponseInDev` exists to catch, and
 * `.optional()` would hide it.
 */
export const ConnectorCatalogManagementResponseSchema = z.object({
  id: z.string(),
  connector_product_id: z.string().uuid(),
  managed_by: ConnectorManagedBySchema,
  /** Echoed from the request, recorded in the audit row. Not persisted on the row. */
  managed_by_vendor_id: z.string().uuid().nullable(),
  updated_at: z.string(),
});
export type ConnectorCatalogManagementResponse = z.infer<
  typeof ConnectorCatalogManagementResponseSchema
>;
