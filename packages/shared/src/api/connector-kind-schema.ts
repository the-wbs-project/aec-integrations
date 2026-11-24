/**
 * The connector kind's Zod schemas (AECI-2036, `docs/STAGE_1_5_SPEC.md` §13.13).
 * The vocabulary and the pure helpers are in the zod-free `./connector-kind`.
 *
 * `products.connector_kind` has no table-level CHECK (a CHECK recreates `products`
 * on D1, `docs/migrations.md` §0), so this schema is the only validation the value
 * gets.
 */
import { z } from 'zod';

import { CONNECTOR_KINDS } from './connector-kind';

export const ConnectorKindSchema = z.enum(CONNECTOR_KINDS);

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
