/**
 * Promote never writes `integration_vendor_links` (AECI-1007 / ADR 0035 decision 6).
 *
 * Each endpoint vendor's own listing and docs links belong to that vendor, on a
 * claimed row and an unclaimed one alike. Promote writes AECi's curated
 * `integrations.listing_url` / `docs_url`, and the pair page falls back to those
 * only when a side has set nothing. Three things are pinned here:
 *
 *   1. No promote source file names the table at all.
 *   2. A re-promote of an UNCLAIMED row that rewrites its curated links and swaps
 *      its source and target (AECI-920's bulk direction corrections) leaves every
 *      vendor link exactly as it was. The key is the endpoint product, so the swap
 *      cannot re-attribute one side's link to the other.
 *   3. The one way promote does remove them: a cross-table move of an unclaimed row
 *      into `connector_evidenced_pairs` (the row became connector-powered) deletes
 *      the source row, and its links cascade with it. That is accepted: a
 *      connector-powered row takes no per-side links (decision 9), so there is no
 *      table on the other side to carry them to. A CLAIMED row never moves at all
 *      (`promote-claim-fence.spec.ts`).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  integrations,
  integrationVendorLinks,
  products,
  productVendors,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { runPromoteIngest, type PromoteRunCtx } from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const REVIT = uuid(1);
const NAVIS = uuid(2);
const AGAVE = uuid(3);
const AUTODESK = uuid(10);
const BENTLEY = uuid(11);
const EDGE = uuid(20);

let t: TestDb;

const rc = (): PromoteRunCtx => ({
  env: { ENV: 'preview' } as Env,
  request: new Request('http://localhost:8787/api/promote'),
  waitUntil: () => {},
  bookmark: () => null,
});

const ingest = (body: unknown) =>
  runPromoteIngest(rc(), PromotePayloadSchema.parse(body), {
    dbFor: t.factory,
    syncAlgolia: async () => {},
    notifyIndexNow: async () => {},
    refreshHomeStats: async () => {},
  });

const links = () =>
  t.db
    .select()
    .from(integrationVendorLinks)
    .orderBy(integrationVendorLinks.productId, integrationVendorLinks.kind);

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: AUTODESK, slug: 'autodesk', companyName: 'Autodesk', promotionStatus: 'promoted' },
    { id: BENTLEY, slug: 'bentley', companyName: 'Bentley', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(products).values([
    { id: REVIT, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
    { id: NAVIS, slug: 'navisworks', name: 'Navisworks', promotionStatus: 'promoted' },
    {
      id: AGAVE,
      slug: 'agave',
      name: 'Agave',
      promotionStatus: 'promoted',
      productRole: 'connector',
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: REVIT, vendorId: AUTODESK, isPrimary: true },
    { productId: NAVIS, vendorId: BENTLEY, isPrimary: true },
  ]);
  // Unclaimed: promote is free to write this row.
  await t.db.insert(integrations).values({
    id: EDGE,
    name: 'Revit to Navisworks',
    sourceProductId: REVIT,
    targetProductId: NAVIS,
    mechanismKind: 'native',
    listingUrl: 'https://aeci.example/curated-listing',
    builtByVendorId: AUTODESK,
  });
  await t.db.insert(integrationVendorLinks).values([
    {
      integrationId: EDGE,
      productId: REVIT,
      kind: 'listing',
      url: 'https://autodesk.example/listing',
      vendorId: AUTODESK,
    },
    {
      integrationId: EDGE,
      productId: NAVIS,
      kind: 'docs',
      url: 'https://bentley.example/docs',
      vendorId: BENTLEY,
    },
  ]);
});
afterEach(() => t.dispose());

describe('promote never writes integration_vendor_links (AECI-1007)', () => {
  it('names the table in no promote source file', () => {
    const dir = join(process.cwd(), 'src', 'routes');
    const files = readdirSync(dir).filter(
      (f) => /^promote.*\.ts$/.test(f) && !f.endsWith('.spec.ts'),
    );
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(join(dir, file), 'utf8');
      expect(text, file).not.toMatch(/integrationVendorLinks|integration_vendor_links/);
    }
  });

  it('keeps every vendor link through a re-promote that rewrites the curated links and swaps the endpoints', async () => {
    const before = await links();
    const { response } = await ingest({
      vendors: [],
      product: { ref: 'p1', supabaseId: NAVIS, name: 'Navisworks' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: EDGE,
          // Swapped: Navisworks is now the source.
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: REVIT },
          name: 'Navisworks to Revit',
          listingUrl: 'https://aeci.example/new-curated-listing',
          docsUrl: 'https://aeci.example/new-curated-docs',
          mechanismKind: 'native',
          builtByVendor: { supabaseId: AUTODESK },
          claims: [],
        },
      ],
    });
    expect(response.integrations.map((i) => i.id)).toContain(EDGE);

    const row = (await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) }))!;
    // Promote did write the row: the swap and AECi's own curated links landed.
    expect(row.sourceProductId).toBe(NAVIS);
    expect(row.listingUrl).toBe('https://aeci.example/new-curated-listing');
    // And touched no vendor link: same rows, same product keys, same timestamps.
    expect(await links()).toEqual(before);
  });

  it('loses an unclaimed row’s links only when it moves to connector_evidenced_pairs', async () => {
    await ingest({
      vendors: [],
      product: { ref: 'p1', supabaseId: REVIT, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: EDGE,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: NAVIS },
          name: 'Revit to Navisworks',
          mechanismKind: 'integrator',
          poweredByProduct: { supabaseId: AGAVE },
          builtByVendor: { supabaseId: AUTODESK },
          claims: [],
        },
      ],
    });
    // The edge left `integrations` (AECI-888's cross-table move) ...
    expect(
      await t.db.query.integrations.findFirst({ where: eq(integrations.id, EDGE) }),
    ).toBeUndefined();
    // ... and its links went with it, by cascade. See this file's header.
    expect(await links()).toEqual([]);
  });
});
