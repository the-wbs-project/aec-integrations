/**
 * `GET /api/slug-redirects` + `GET /api/slug-redirects/:entity/:fromSlug`
 * (AECI-978 / `STAGE_3_SPEC.md` §2.6 option B) against the in-memory D1 harness.
 *
 * The harness applies every committed migration, and `0039` SEEDS the two
 * production rows — so an "empty" database here already holds them. That is
 * deliberate (they have to reach production, and `seed/*.sql` is local-only), and
 * the first test below is what fails if a regeneration ever drops them.
 */

import { SlugRedirectSchema, SlugRedirectsListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { slugRedirects } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createSlugRedirectResolveHandler, createSlugRedirectsListHandler } from './slug-redirects';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const listApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/slug-redirects',
    handler: createSlugRedirectsListHandler(t.factory),
  });
const resolveApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/slug-redirects/:entity/:fromSlug',
    handler: createSlugRedirectResolveHandler(t.factory),
  });
const get = (app: ReturnType<typeof listApp>, url: string) =>
  app.request(url, {}, TEST_ENV, fakeExecutionContext());

describe('GET /api/slug-redirects', () => {
  it('serves the rows migrations 0039 and 0112 seed, in a schema-valid envelope', async () => {
    const res = await get(listApp(), 'http://api/api/slug-redirects');
    expect(res.status).toBe(200);
    const body = SlugRedirectsListResponseSchema.parse(await res.json());
    // The two cases AECI-978 exists for, plus AECI-926's category (0112, AECI-979).
    // Asserted by value, not by count: this is the only automated check that the
    // seeds reach a migrated database.
    expect(body.redirects).toEqual([
      {
        entity: 'category',
        from_slug: 'reality-capture-scan-to-bim',
        to_slug: 'reality-capture',
      },
      {
        entity: 'product',
        from_slug: 'autodesk-construction-cloud',
        to_slug: 'autodesk-forma',
      },
      { entity: 'vendor', from_slug: 'bluebeam', to_slug: 'nemetschek-group' },
    ]);
  });
});

describe('GET /api/slug-redirects/:entity/:fromSlug', () => {
  it('resolves a seeded product mapping', async () => {
    const res = await get(
      resolveApp(),
      'http://api/api/slug-redirects/product/autodesk-construction-cloud',
    );
    expect(res.status).toBe(200);
    expect(SlugRedirectSchema.parse(await res.json())).toEqual({
      entity: 'product',
      from_slug: 'autodesk-construction-cloud',
      to_slug: 'autodesk-forma',
    });
  });

  it('404s an unmapped slug with the canonical NOT_FOUND envelope', async () => {
    const res = await get(resolveApp(), 'http://api/api/slug-redirects/product/never-existed');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('does not cross entity kinds', async () => {
    // `bluebeam` is mapped as a VENDOR. Asking about a product of that slug must
    // miss — the PK is `(entity, from_slug)` and the query pairs both.
    const res = await get(resolveApp(), 'http://api/api/slug-redirects/product/bluebeam');
    expect(res.status).toBe(404);
  });

  it('404s an unknown entity kind rather than 500ing', async () => {
    const res = await get(resolveApp(), 'http://api/api/slug-redirects/integration/anything');
    expect(res.status).toBe(404);
  });

  it('resolves the seeded category mapping (AECI-979)', async () => {
    const res = await get(
      resolveApp(),
      'http://api/api/slug-redirects/category/reality-capture-scan-to-bim',
    );
    expect(res.status).toBe(200);
    expect(SlugRedirectSchema.parse(await res.json())).toEqual({
      entity: 'category',
      from_slug: 'reality-capture-scan-to-bim',
      to_slug: 'reality-capture',
    });
  });

  it('resolves a trade mapping, so every taxonomy kind is wired (AECI-979)', async () => {
    await t.db.insert(slugRedirects).values({
      entity: 'trade',
      fromSlug: 'old-trade',
      toSlug: 'new-trade',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const res = await get(resolveApp(), 'http://api/api/slug-redirects/trade/old-trade');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ entity: 'trade', to_slug: 'new-trade' });
  });

  it('follows a chain to its terminal slug, in one answer', async () => {
    // `a` -> `b` -> `c`. A reader on `/products/a` must land on `c` directly; two
    // hops would be two round trips for them and two 301s for a crawler.
    await t.db.insert(slugRedirects).values([
      { entity: 'product', fromSlug: 'a', toSlug: 'b', createdAt: '2026-01-01T00:00:00.000Z' },
      { entity: 'product', fromSlug: 'b', toSlug: 'c', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const res = await get(resolveApp(), 'http://api/api/slug-redirects/product/a');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ to_slug: 'c' });
  });

  it('answers nothing at all on a cycle', async () => {
    // The `from_slug <> to_slug` CHECK cannot catch a two-row cycle. Returning the
    // last link before the loop would 301 into a redirect loop the edge caches.
    await t.db.insert(slugRedirects).values([
      { entity: 'product', fromSlug: 'x', toSlug: 'y', createdAt: '2026-01-01T00:00:00.000Z' },
      { entity: 'product', fromSlug: 'y', toSlug: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const res = await get(resolveApp(), 'http://api/api/slug-redirects/product/x');
    expect(res.status).toBe(404);
  });

  it('rejects a self-redirect at the database, not at the reader', async () => {
    await expect(
      t.db.insert(slugRedirects).values({
        entity: 'product',
        fromSlug: 'loop',
        toSlug: 'loop',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();
  });

  it('rejects an entity kind nothing is wired to read', async () => {
    // The CHECK admits only what a resolver reads. An `integration` row would be
    // silently inert, which is worse than a rejected insert.
    await expect(
      t.db.insert(slugRedirects).values({
        entity: 'integration',
        fromSlug: 'old',
        toSlug: 'new',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow();
  });
});
