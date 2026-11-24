/**
 * The connector kind's Zod schemas (AECI-2036, `docs/STAGE_1_5_SPEC.md` §13.13).
 * The vocabulary and the pure helpers are in the zod-free `./connector-kind`.
 *
 * `products.connector_kind` has no table-level CHECK (a CHECK recreates `products`
 * on D1, `docs/migrations.md` §0), so this schema is the only validation the value
 * gets.
 */
import { z } from 'zod';

import { CONNECTOR_KINDS, isConnectorKind, type ConnectorKind } from './connector-kind';

export const ConnectorKindSchema = z.enum(CONNECTOR_KINDS);

/**
 * The `connector_kind` listing filter (AECI-1662) on `GET /api/products` and
 * `GET /api/products/facets`: a comma-separated list of kinds, OR within the list,
 * the same shape as the taxonomy `{kind}_id` lists (`uuidList`). Split on `,`, trim,
 * drop empties, at least one value, every value a stored kind. Deduped and returned
 * in vocabulary order, so `sync_service,integration_platform` and its reverse are
 * one filter. An unknown kind is a 400 at the param key, as a bad UUID is.
 */
export const connectorKindList = z.string().transform((raw, ctx): ConnectorKind[] => {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'Expected at least one connector kind' });
    return z.NEVER;
  }
  for (const value of values) {
    if (!isConnectorKind(value)) {
      ctx.addIssue({ code: 'custom', message: `Invalid connector kind: ${value}` });
      return z.NEVER;
    }
  }
  return CONNECTOR_KINDS.filter((kind) => values.includes(kind));
});

/**
 * Body of `PATCH /api/admin/products/:id/connector-kind`. `null` clears the kind,
 * so the product reads as "Connector" again. Strict: an unknown key is a 400.
 */
export const AdminSetConnectorKindSchema = z
  .object({
    connector_kind: ConnectorKindSchema.nullable(),
  })
  .strict();
export type AdminSetConnectorKindInput = z.infer<typeof AdminSetConnectorKindSchema>;

/** Response of the same PATCH. `changed: false` means the value was already set and
 *  nothing was written, audited or purged. */
export const AdminSetConnectorKindResponseSchema = z.object({
  id: z.string().uuid(),
  connector_kind: ConnectorKindSchema.nullable(),
  changed: z.boolean(),
});
export type AdminSetConnectorKindResponse = z.infer<typeof AdminSetConnectorKindResponseSchema>;
