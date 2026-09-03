/**
 * The app-side half of the mechanism-vocabulary lockstep (AECI-735).
 *
 * Five independent lists spell out the same vocabulary and nothing derives one from
 * another — `IntegrationMechanismKindSchema`, `MECHANISM_KINDS`, `MECHANISM_RANK`,
 * `VALID_MECHANISM_KINDS` here, and `MECHANISM_ORDER` in `apps/web`. The three that
 * live in `@aeci/shared` check each other in
 * `packages/shared/src/api/integrations.spec.ts`; this file covers the two that do
 * not, and it is the only one that can cover the sixth spelling — the D1
 * `integrations_mechanism_kind_check` — because that one is SQL, not TypeScript.
 *
 * The CHECK is what makes drift expensive rather than merely wrong: changing it on
 * D1 is a destructive table recreate (`docs/migrations.md` §3.3a). So the failure
 * this file exists to catch is a value added to the TypeScript enums whose migration
 * was forgotten — which passes Zod, reaches the batch, and fails the CHECK at commit
 * time in production. That is exactly the shape AECI-768 reported for `integrator`.
 */

import { describe, expect, it } from 'vitest';

import { IntegrationMechanismKindSchema } from '@aeci/shared';

import { toMechanismKind } from '../lib/drizzle-helpers';
import { integrations, products } from '../db/schema';
import { makeTestDb } from './d1';

const KINDS = IntegrationMechanismKindSchema.options;

describe('mechanism vocabulary — app-side lockstep (AECI-735)', () => {
  it('accepts every kind through `toMechanismKind` — a gap there throws on READ', () => {
    // `VALID_MECHANISM_KINDS` is fail-loud by design: an unlisted value does not
    // degrade to null, it throws, so every read of a surviving row 500s. It is typed
    // to `IntegrationMechanismKind`, but TypeScript cannot catch a MISSING member of
    // a `Set`, only a bogus one.
    for (const kind of KINDS) {
      expect(toMechanismKind(kind, 'i1')).toBe(kind);
    }
  });

  it('still refuses an unknown kind, and passes NULL through', () => {
    expect(() => toMechanismKind('rpa', 'i1')).toThrow(/unknown mechanism_kind/);
    expect(toMechanismKind(null, 'i1')).toBeNull();
  });

  it('accepts every kind at the D1 CHECK — the spelling a migration can forget', async () => {
    const t = await makeTestDb();
    await t.db.insert(products).values([
      { id: 'p1', slug: 'procore', name: 'Procore' },
      { id: 'p2', slug: 'sage', name: 'Sage' },
    ]);

    for (const [i, kind] of KINDS.entries()) {
      await t.db.insert(integrations).values({
        id: `i${i}`,
        sourceProductId: 'p1',
        targetProductId: 'p2',
        mechanismKind: kind,
      });
    }
    const rows = await t.db.query.integrations.findMany();
    expect(rows.map((r) => r.mechanismKind).sort()).toEqual([...KINDS].sort());

    t.dispose();
  });

  it('refuses a non-member at the D1 CHECK, and allows NULL', async () => {
    const t = await makeTestDb();
    await t.db.insert(products).values([
      { id: 'p1', slug: 'procore', name: 'Procore' },
      { id: 'p2', slug: 'sage', name: 'Sage' },
    ]);

    await expect(
      t.db.insert(integrations).values({
        id: 'bad',
        sourceProductId: 'p1',
        targetProductId: 'p2',
        mechanismKind: 'rpa',
      }),
    ).rejects.toThrow(/CHECK constraint failed/);

    // NULL passes: a NULL expression is not FALSE, so SQLite allows it. `unset is
    // not a kind` (AECI-698) is enforced upstream, not here.
    await t.db.insert(integrations).values({
      id: 'null-kind',
      sourceProductId: 'p1',
      targetProductId: 'p2',
      mechanismKind: null,
    });

    t.dispose();
  });

  it('keeps `iPaaS` and `partner` — neither retirement has happened (AECI-735)', () => {
    // An INVARIANT assertion, not a behaviour one. `iPaaS` is PERMANENT: it is the
    // marker behind `isConnectorPoweredEdge` (AECI-705's attestation gate),
    // `routeIntegrationLane` clause (c) (the Via lane) and `MECHANISM_ORDER`, over a
    // population AECI-700 parks indefinitely. `partner` is pending AECI-712's
    // upstream re-key; dropping it before that runs makes `toMechanismKind` throw on
    // every surviving row. Deleting either case means reopening AECI-735.
    expect(KINDS).toContain('iPaaS');
    expect(KINDS).toContain('partner');
  });
});
