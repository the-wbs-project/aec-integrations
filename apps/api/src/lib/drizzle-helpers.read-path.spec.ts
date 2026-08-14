/**
 * §2.5's structural invariant: **no read path may query `vendor_entitlements`**
 * (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.5).
 *
 * This is an INVARIANT test (§10) — it encodes a decision, not behaviour, and must not
 * be deleted without reopening the spec.
 *
 * `vendors.verified` is a denormalized MIRROR. The whole epic is additive precisely
 * because the five shipped readers (the public `?verified=` filter, `VendorLinkSchema`,
 * `VendorDetail`/`VendorListItem`, the Algolia vendor record, `aec-verified-badge`)
 * keep reading the mirror. The obvious "improvement" — joining `vendor_entitlements`
 * into a read config so it reads the truth rather than the mirror — would defeat the
 * entire denormalization, put an entitlement lookup on every public request, and break
 * the guarantee that this epic touches no reader.
 *
 * Asserted over the module SOURCE rather than over the exported objects, because the
 * read configs are plain `as const` literals that carry no table identity at runtime.
 * A source scan covers three escape hatches in one shot: the config literals, the raw
 * `sql\`\`` correlated subqueries inside `extras` (which name tables as bare text), and
 * the schema import block.
 *
 * The companion structural guarantee lives in `db/schema.ts`: `vendorEntitlements`
 * deliberately has **no `relations()` entry**, so a `with: { entitlement: … }` read
 * cannot even compile. The §4 gate and the `entitlement_mirror_drift` check both use an
 * explicit `leftJoin`, which needs no relation.
 *
 * The behavioural half of this guard is in `routes/vendors.spec.ts` — a deliberately
 * drifted pair proving `?verified=` returns the mirror's answer, not the truth (R9).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const SRC = join(process.cwd(), 'src');

/** Every module that shapes a READ of vendor data. If a new one appears, add it here. */
const READ_PATH_MODULES = [
  'lib/drizzle-helpers.ts',
  'lib/algolia-transforms.ts',
  'routes/vendors.ts',
] as const;

/** Both the Drizzle identifier and the raw table name — `extras` uses raw SQL text. */
const ENTITLEMENT_REFERENCE = /vendorEntitlements|vendor_entitlements/;

describe('§2.5 — no read path queries vendor_entitlements', () => {
  it.each(READ_PATH_MODULES)('%s never references the entitlement table', (relPath) => {
    const source = readFileSync(join(SRC, relPath), 'utf8');
    expect(
      source,
      `${relPath} references vendor_entitlements. Read paths must keep reading the ` +
        '`vendors.verified` MIRROR — joining the entitlement table defeats the ' +
        'denormalization the whole AECI-515 epic rests on (STAGE_2_PAID_TIERS_SPEC.md §2.5).',
    ).not.toMatch(ENTITLEMENT_REFERENCE);
  });

  it('the scan would actually catch a violation (guards against a vacuous regex)', () => {
    // Cheap insurance: if the pattern were mistyped, every assertion above would pass
    // for the wrong reason and the invariant would be silently unguarded.
    expect('db.select().from(vendorEntitlements)').toMatch(ENTITLEMENT_REFERENCE);
    expect('JOIN "vendor_entitlements" e').toMatch(ENTITLEMENT_REFERENCE);
    expect('db.select().from(vendors)').not.toMatch(ENTITLEMENT_REFERENCE);
  });

  it('vendorEntitlements has no relations() entry, so `with:` cannot compile', async () => {
    const schemaSource = readFileSync(join(SRC, 'db/schema.ts'), 'utf8');
    expect(schemaSource).not.toMatch(/vendorEntitlementsRelations/);
    // And the table itself IS exported to the aggregate, or db.query would not see it.
    const { schema } = await import('../db/schema');
    expect(schema).toHaveProperty('vendorEntitlements');
  });
});
