/**
 * §2.5's structural invariant: **no read path may query `vendor_entitlements`**
 * (AECI-609 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.5).
 *
 * This is an INVARIANT test (§10) — it encodes a decision, not behaviour, and must not
 * be deleted without reopening the spec.
 *
 * `vendors.verified` is a denormalized MIRROR. The whole epic was additive precisely
 * because the shipped readers kept reading the mirror. The public ones are gone:
 * AECI-1264 (2026-10-09) deleted `aec-vendor-account-badge`, and AECI-1266
 * (2026-10-12) took the flag off `VendorLinkSchema`, `VendorDetail`/`VendorListItem`,
 * the `?verified=` filter and the Algolia vendor record. The pair version-diff gate
 * still reads the mirror, off the raw vendor row, and the rule below covers it.
 * The obvious "improvement" — joining `vendor_entitlements`
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
 * cannot even compile. The retired `entitlement_mirror_drift` check (AECI-1375) used an
 * explicit `leftJoin`, which needs no relation. The §4 gate read the table the same way until AECI-1355
 * moved it onto `licenses` (the allow-list below).
 *
 * The behavioural half of this guard was a drifted-pair test of `?verified=` in
 * `routes/vendors.spec.ts` (R9). That filter is retired (AECI-1266), so the test
 * went with it. This source scan is the guard that remains.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

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

/**
 * AECI-1350: the same rule for `billing_accounts` and `licenses`. They are the
 * successor to `vendor_entitlements` (E1, `docs/VENDOR_SIGNUP_PROCESS.md` §5), so the
 * catalog read paths stay as blind to them as to the table they replace. Plan
 * resolution reads them in the authz guard with explicit joins (AECI-1355), never in a
 * read config.
 *
 * `licenses` is an ordinary English word, so the pattern matches only the Drizzle
 * identifier used as a value (`licenses.`, `(licenses)`, `licenses,` in an import) and
 * the quoted SQL name, never the word in a comment.
 */
const LICENSING_REFERENCE =
  /\bbillingAccounts\b|\bbilling_accounts\b|\blicenses\s*[.,)}]|\(\s*licenses\b|["'`]licenses["'`]/;

describe('AECI-1350 — no read path queries billing_accounts or licenses', () => {
  it.each(READ_PATH_MODULES)('%s never references either table', (relPath) => {
    const source = readFileSync(join(SRC, relPath), 'utf8');
    expect(
      source,
      `${relPath} references billing_accounts or licenses. Plan state never shapes a ` +
        'catalog read (no pay-for-placement, STAGE_2_PAID_TIERS_SPEC.md §2.5).',
    ).not.toMatch(LICENSING_REFERENCE);
  });

  it('the scan would actually catch a violation, and ignores the plain word', () => {
    expect('db.select().from(licenses)').toMatch(LICENSING_REFERENCE);
    expect('eq(licenses.assignedProductId, id)').toMatch(LICENSING_REFERENCE);
    expect("import { licenses, products } from '../db/schema'").toMatch(LICENSING_REFERENCE);
    expect('LEFT JOIN "licenses" l').toMatch(LICENSING_REFERENCE);
    expect('db.select().from(billingAccounts)').toMatch(LICENSING_REFERENCE);
    expect('JOIN "billing_accounts" b').toMatch(LICENSING_REFERENCE);
    expect('// a vendor buys licenses and assigns them').not.toMatch(LICENSING_REFERENCE);
    expect('licensesByProduct').not.toMatch(LICENSING_REFERENCE);
  });

  it('neither table has a relations() entry, so `with:` cannot compile', async () => {
    const schemaSource = readFileSync(join(SRC, 'db/schema.ts'), 'utf8');
    expect(schemaSource).not.toMatch(/billingAccountsRelations|licensesRelations/);
    const { schema } = await import('../db/schema');
    expect(schema).toHaveProperty('billingAccounts');
    expect(schema).toHaveProperty('licenses');
  });
});

/**
 * AECI-1355 (E1.6): plan resolution reads `licenses`, so `vendor_entitlements` is
 * left to the modules that still WRITE it or that AECi operators read, until E1.9
 * retires the table. The AC: "no read path imports `vendorEntitlements` outside
 * the admin and retirement set".
 *
 * Asserted as an exact set over every non-spec module, so both directions fail: a
 * new reader (a vendor route, a gate, a cron) trips it, and a module that stops
 * referencing the table must be dropped from the list, which keeps the list an
 * honest inventory for E1.9. The pattern is the Drizzle identifier or the quoted
 * SQL name, never the word in prose.
 */
const ENTITLEMENT_CODE_REFERENCE = /\bvendorEntitlements\b|"vendor_entitlements"/;

/** Why each module may still name the table. */
const ENTITLEMENT_TABLE_ALLOWED: Record<string, string> = {
  // The definition.
  'db/schema.ts': 'the table itself',
  // Retirement set: the old writers and checks E1.9 deletes with the table.
  'lib/vendor-entitlement.ts': 'the entitlement writer, dual-writing licenses (AECI-1353)',
  'lib/backfill-entitlements.ts': 'the AECI-609 back-fill',
  'lib/backfill-licenses.ts': 'the AECI-1354 license back-fill (reads the old row to map it)',
  'lib/retract-vendor.ts': 'the vendor-delete refusal count (FK handling)',
  'routes/account.ts': 'account erasure NULLs granted_by (a write, not a plan read)',
  // Admin set: operator surfaces. AECI-1375 removed the set / renew / clear route and
  // the admin vendor list's and claims queue's entitlement reads.
  'routes/admin-users.ts': 'user erasure preview (admin)',
};

function sourceModules(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'test' ? [] : sourceModules(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('AECI-1355 — vendor_entitlements is read only by the admin and retirement set', () => {
  it('the modules naming the table are exactly the allow-list', () => {
    const referencing = sourceModules(SRC)
      .filter((path) => ENTITLEMENT_CODE_REFERENCE.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path).split('\\').join('/'))
      .sort();
    expect(
      referencing,
      'A module outside the admin and retirement set references vendor_entitlements, or ' +
        'one on the list no longer does. Plan resolution reads `licenses` (AECI-1355): ' +
        'read the session (`entitlementTier`, `licensedProductIds`) or `lib/license.ts`.',
    ).toEqual(Object.keys(ENTITLEMENT_TABLE_ALLOWED).sort());
  });

  it('the plan-resolution modules are not on it', () => {
    for (const path of [
      'lib/authz.ts',
      'lib/integration-entitlement.ts',
      'lib/integration-contests.ts',
      'lib/vendor-snapshot.ts',
      'lib/audit-vendor.ts',
      'lib/vendor-handback.ts',
      'routes/vendor.ts',
      'routes/vendor-shared.ts',
      'routes/vendor-updates.ts',
      'routes/seat-invites.ts',
    ]) {
      expect(ENTITLEMENT_TABLE_ALLOWED).not.toHaveProperty(path);
    }
  });

  it('the pattern matches code and skips prose', () => {
    expect('db.select().from(vendorEntitlements)').toMatch(ENTITLEMENT_CODE_REFERENCE);
    expect('SELECT 1 FROM "vendor_entitlements"').toMatch(ENTITLEMENT_CODE_REFERENCE);
    expect('// the old `vendor_entitlements` row').not.toMatch(ENTITLEMENT_CODE_REFERENCE);
  });
});

/**
 * AECI-933: the connector's vendor join is a PAIR-read cost only. The pair configs
 * hydrate the connector's `productVendors` so the mapper can set
 * `connector_vendor_id`. The shared list config, which `/api/integrations`, the
 * powered hub and the product-detail embed all spread, must stay bare.
 */
describe('AECI-933 — connector vendor join stays on the pair read', () => {
  it('the pair configs hydrate the connector product with its vendors', async () => {
    const { integrationPairConfig, connectorEvidencedPairPairConfig } =
      await import('./drizzle-helpers');
    expect(integrationPairConfig.with.poweredByProduct).toHaveProperty('with.productVendors');
    expect(connectorEvidencedPairPairConfig.with.connectorProduct).toHaveProperty(
      'with.productVendors',
    );
  });

  it('the shared list configs do not', async () => {
    const { connectorEvidencedPairListConfig, connectorEvidencedPairDetailConfig } =
      await import('./drizzle-helpers');
    expect(connectorEvidencedPairListConfig.with.connectorProduct).not.toHaveProperty('with');
    expect(connectorEvidencedPairDetailConfig.with.connectorProduct).not.toHaveProperty('with');
  });
});
