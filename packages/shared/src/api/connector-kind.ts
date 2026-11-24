/**
 * The connector kind vocabulary (AECI-2036, `docs/STAGE_1_5_SPEC.md` §13.13).
 *
 * One `connector` product role covers two public kinds (AECI-2035 ruling 1):
 *
 * - `integration_platform`: the customer builds the connection from a catalogue of
 *   apps (Zapier, Workato, MindCloud).
 * - `sync_service`: the vendor sells, runs and supports a fixed list of finished
 *   pairs (Rivets Sync, Agave, SyncEzy).
 *
 * `products.connector_kind` stores one of these, or NULL. NULL is unclassified and
 * reads as "Connector". An AECi admin sets it (ruling 3). Promote never writes it.
 *
 * Zod-free on purpose (AECI-2033, `packages/shared/README.md` "Zod-free modules"):
 * public pages will import {@link isSyncService}. The Zod schema lives in
 * `./connector-kind-schema`.
 */

/** The stored values, in display order. */
export const CONNECTOR_KINDS = ['integration_platform', 'sync_service'] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

/** The product roles a kind may sit on. `application` never carries one. */
export const CONNECTOR_KIND_ROLES = ['connector', 'hybrid'] as const;

/** True when `value` is a stored connector kind. */
export function isConnectorKind(value: unknown): value is ConnectorKind {
  return (CONNECTOR_KINDS as readonly unknown[]).includes(value);
}

/** True when a product of this role may carry a connector kind. */
export function roleTakesConnectorKind(role: string | null | undefined): boolean {
  return (CONNECTOR_KIND_ROLES as readonly (string | null | undefined)[]).includes(role);
}

/**
 * The kind a reader should see for a product. It is `null` unless the role takes a
 * kind AND the stored value is one this vocabulary knows. So a product moved to
 * `application` by a later promote, or a stray value in the column (it has no CHECK),
 * reads as unclassified rather than as a kind it no longer is.
 */
export function connectorKindFor(
  role: string | null | undefined,
  kind: string | null | undefined,
): ConnectorKind | null {
  return roleTakesConnectorKind(role) && isConnectorKind(kind) ? kind : null;
}

/**
 * May a product of this role and kind hold a Managed subscription? (AECI-2044, ruling 6
 * on AECI-2035, `STAGE_2_SPEC.md` §8.8.)
 *
 * - `application` and `hybrid`: yes. A hybrid is an endpoint as well as a connector.
 * - `connector` whose kind is `sync_service`: yes. It sells finished pairs and promotes
 *   its product on the site, so it may buy the rich-profile plan.
 * - `connector` whose kind is `integration_platform` or blank: no, for now (AECI-1343
 *   stays open for it).
 * - Any other role: no, so an unknown role fails closed.
 *
 * This decides NEW assignments only. A subscription already on a product stays there
 * (`STAGE_2_PAID_TIERS_SPEC.md` §13.14).
 */
export function productTakesSubscription(
  role: string | null | undefined,
  kind: string | null | undefined,
): boolean {
  if (role === 'application' || role === 'hybrid') return true;
  return role === 'connector' && kind === 'sync_service';
}

/** True when the product is a Sync Service: role `connector` or `hybrid`, kind `sync_service`. */
export function isSyncService(
  role: string | null | undefined,
  kind: string | null | undefined,
): boolean {
  return connectorKindFor(role, kind) === 'sync_service';
}
