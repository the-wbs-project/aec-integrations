/**
 * The connector admin surface (AECI-722 / `docs/ADMIN_PANEL_SPEC.md` §5.9),
 * against the in-memory D1 harness.
 *
 * The 401/403 matrix is NOT here — it lives in `admin-panel.authz-matrix.spec.ts`,
 * which mounts every read behind the real `requireAdmin()`. This file is the
 * other half: the queries.
 *
 * Five groups earn their keep, and four are regressions against a specific way
 * this surface could lie to an operator rather than happy-path coverage:
 *
 *  1. **"Undecided" is an anti-join, not a status.** §9a.4 is explicit that
 *     "there is no `pending` status — the absence of a row is pending". A stub
 *     with a `ruled_out` mapping is DECIDED; counting it as undecided would
 *     inflate the triage queue with work already done.
 *  2. **The publication gate is provenance, not confidence.** A `high`-confidence
 *     `auto-name-match` row must NOT be publishable, and a `low`-confidence
 *     human decision must be. Gating on confidence would publish hundreds of
 *     machine guesses — the single most valuable assertion in the file.
 *  3. **A reclaimed lane reports no handover.** Flipping back to `review` leaves
 *     the `managed_by_vendor` audit row in place forever; rendering it beside a
 *     review-managed catalogue would tell the operator a vendor still holds a
 *     lane they do not.
 *  4. **The `actions` blob never crosses the wire, and null means NEVER FETCHED.**
 *     §9a.3: a reader treating null as "none" would publish "this connector does
 *     nothing" about most of the catalogue.
 *  5. **A stub with several mappings appears ONCE.** The filters are `EXISTS`
 *     subqueries rather than joins precisely so the many-to-many cannot duplicate
 *     a row and corrupt `total`.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  connectorCatalogSurfaces,
  connectorCatalogs,
  connectorPairs,
  connectorStubMappings,
  connectorStubs,
  products,
  profiles,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthenticatedSession, AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminConnectorAuditHandler,
  createAdminConnectorCatalogDetailHandler,
  createAdminConnectorCatalogsListHandler,
  createAdminConnectorPairsHandler,
  createAdminConnectorStubsHandler,
  type FetchAuthEmails,
} from './admin-connectors';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ADMIN = u(1);
const CONNECTOR = u(10);
const APP_A = u(11);
const APP_B = u(12);
const VENDOR = u(20);
const CATALOG = 'cat-mindcloud';

const ADMIN_SESSION = {
  userId: ADMIN,
  role: 'admin',
  banned: false,
} as unknown as AuthenticatedSession;

const noEmails: FetchAuthEmails = async () => ({
  available: true,
  emails: new Map<string, string>(),
  reason: 'ok' as const,
});

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'mindcloud', companyName: 'MindCloud' });
  await t.db.insert(products).values([
    { id: CONNECTOR, slug: 'mindcloud', name: 'MindCloud', productRole: 'connector' },
    { id: APP_A, slug: 'procore', name: 'Procore' },
    { id: APP_B, slug: 'sage-intacct', name: 'Sage Intacct' },
  ]);
  await t.db
    .insert(connectorCatalogs)
    .values({ id: CATALOG, connectorProductId: CONNECTOR, connectorAuthorship: 'platform' });
});
afterEach(() => t.dispose());

/**
 * Mount one handler on a real Hono app with the shared `errorHandler` and a stub
 * middleware setting the `auth` Variable `requireAdmin()` would.
 *
 * A real app rather than a hand-rolled context: `ApiError` only becomes a 404 by
 * passing through `onError`, so a bare call would just throw and every "404s on
 * an unknown id" test would pass for the wrong reason.
 */
function mount(path: string, handler: (c: never) => Promise<Response>) {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use(path, async (c, next) => {
    c.set('auth', ADMIN_SESSION);
    await next();
  });
  app.get(path, handler as never);
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<any> {
  return res.json();
}

async function seedStub(
  id: string,
  over: Partial<typeof connectorStubs.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(connectorStubs).values({
    id,
    catalogId: CATALOG,
    slug: id,
    label: id.toUpperCase(),
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    lastSeenAt: '2026-08-30T00:00:00.000Z',
    ...over,
  });
}

async function seedMapping(
  id: string,
  stubId: string,
  over: Partial<typeof connectorStubMappings.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(connectorStubMappings).values({
    id,
    stubId,
    catalogId: CATALOG,
    status: 'mapped',
    ...over,
  });
}

describe('GET /api/admin/connector-catalogs', () => {
  it('reports tallies, with undecided as the ABSENCE of a mapping row', async () => {
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedStub('stub-c');
    // stub-b is decided-and-rejected. It is NOT undecided: somebody looked.
    await seedMapping('m1', 'stub-b', {
      status: 'ruled_out',
      productId: APP_A,
      decidedBy: 'chris',
    });
    // stub-c is parked with no product. Also decided.
    await seedMapping('m2', 'stub-c', { status: 'ambiguous_parked', productId: null });

    const app = mount(
      '/api/admin/connector-catalogs',
      createAdminConnectorCatalogsListHandler(t.factory),
    );
    const res = await app.request(
      '/api/admin/connector-catalogs',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);

    const json = await body(res);
    expect(json.total).toBe(1);
    const row = json.data[0];
    expect(row.connector_product.slug).toBe('mindcloud');
    expect(row.managed_by).toBe('review');
    expect(row.counts.stubs_total).toBe(3);
    expect(row.counts.stubs_undecided).toBe(1);
    expect(row.counts.mappings_ruled_out).toBe(1);
    expect(row.counts.mappings_ambiguous_parked).toBe(1);
    expect(row.counts.evidenced_pairs).toBe(0);
  });

  it('reports the newest surface ingest as the catalogue freshness stamp', async () => {
    await t.db.insert(connectorCatalogSurfaces).values([
      {
        id: 's1',
        catalogId: CATALOG,
        surfaceRole: 'apps',
        lastIngestedAt: '2026-08-20T00:00:00.000Z',
      },
      // Never ingested. MAX ignores NULLs, so the catalogue still reports the
      // real stamp — the feed HAS delivered, just not on every surface.
      { id: 's2', catalogId: CATALOG, surfaceRole: 'pairs', lastIngestedAt: null },
    ]);

    const app = mount(
      '/api/admin/connector-catalogs',
      createAdminConnectorCatalogsListHandler(t.factory),
    );
    const json = await body(
      await app.request('/api/admin/connector-catalogs', {}, TEST_ENV, fakeExecutionContext()),
    );
    expect(json.data[0].counts.surfaces).toBe(2);
    expect(json.data[0].last_ingested_at).toBe('2026-08-20T00:00:00.000Z');
  });

  it('filters by managed_by', async () => {
    const app = mount(
      '/api/admin/connector-catalogs',
      createAdminConnectorCatalogsListHandler(t.factory),
    );
    const vendorLane = await body(
      await app.request(
        '/api/admin/connector-catalogs?managed_by=vendor',
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(vendorLane.total).toBe(0);
    const reviewLane = await body(
      await app.request(
        '/api/admin/connector-catalogs?managed_by=review',
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(reviewLane.total).toBe(1);
  });

  it('searches on the connector product name, escaping wildcards', async () => {
    const app = mount(
      '/api/admin/connector-catalogs',
      createAdminConnectorCatalogsListHandler(t.factory),
    );
    const hit = await body(
      await app.request(
        '/api/admin/connector-catalogs?search=mind',
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(hit.total).toBe(1);
    // A literal `%` must match literally — that is what `likeContains`' ESCAPE
    // clause is for. Without it this would match everything.
    const escaped = await body(
      await app.request(
        '/api/admin/connector-catalogs?search=%25',
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(escaped.total).toBe(0);
  });
});

describe('GET /api/admin/connector-catalogs/:id', () => {
  const detail = () =>
    mount(
      '/api/admin/connector-catalogs/:id',
      createAdminConnectorCatalogDetailHandler(t.factory, noEmails),
    );

  it('404s on an unknown catalogue rather than returning an empty bundle', async () => {
    const res = await detail().request(
      '/api/admin/connector-catalogs/nope',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(404);
    const json = await body(res);
    expect(json.error.details.resource).toBe('connector_catalog');
  });

  it('derives the handover from the audit row while the lane is frozen', async () => {
    await t.db
      .update(connectorCatalogs)
      .set({ managedBy: 'vendor' })
      .where(eq(connectorCatalogs.id, CATALOG));
    await t.db.insert(auditLog).values({
      id: u(500),
      actorId: ADMIN,
      actorType: 'admin',
      action: 'connector_catalog.managed_by_vendor',
      entityType: 'connector_catalog',
      entityId: CATALOG,
      metadata: { vendor_id: VENDOR, reason: 'Partnership track', seat_not_granted: true },
      createdAt: '2026-08-30T10:00:00.000Z',
    });

    const json = await body(
      await detail().request(
        `/api/admin/connector-catalogs/${CATALOG}`,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(json.managed_by).toBe('vendor');
    expect(json.handover.vendor.slug).toBe('mindcloud');
    expect(json.handover.reason).toBe('Partnership track');
    expect(json.handover.actor.id).toBe(ADMIN);
    expect(json.handover.at).toBe('2026-08-30T10:00:00.000Z');
  });

  it('reports NO handover once the lane is reclaimed, though the audit row survives', async () => {
    // The flip happened and was then reversed. The `managed_by_vendor` row stays
    // in `audit_log` forever (nothing prunes it), so a naive "latest handover"
    // read would keep claiming a vendor holds this lane.
    await t.db.insert(auditLog).values({
      id: u(501),
      actorId: ADMIN,
      actorType: 'admin',
      action: 'connector_catalog.managed_by_vendor',
      entityType: 'connector_catalog',
      entityId: CATALOG,
      metadata: { vendor_id: VENDOR },
      createdAt: '2026-08-30T10:00:00.000Z',
    });

    const json = await body(
      await detail().request(
        `/api/admin/connector-catalogs/${CATALOG}`,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(json.managed_by).toBe('review');
    expect(json.handover).toBeNull();
  });

  it('carries the empty-delivered-lane advisory rather than an unexplained zero', async () => {
    const json = await body(
      await detail().request(
        `/api/admin/connector-catalogs/${CATALOG}`,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(json.counts.evidenced_pairs).toBe(0);
    expect(json.advisories.map((n: { code: string }) => n.code)).toContain(
      'connector_evidenced_pairs_empty',
    );
  });
});

describe('GET /api/admin/connector-catalogs/:id/stubs', () => {
  const stubs = () =>
    mount('/api/admin/connector-catalogs/:id/stubs', createAdminConnectorStubsHandler(t.factory));

  const fetchStubs = async (qs = '') =>
    body(
      await stubs().request(
        `/api/admin/connector-catalogs/${CATALOG}/stubs${qs}`,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );

  it('gates the publication flag on PROVENANCE, never on confidence', async () => {
    await seedStub('stub-auto');
    await seedStub('stub-human');
    // High confidence, but the machine decided it. Not publishable.
    await seedMapping('m-auto', 'stub-auto', {
      productId: APP_A,
      confidence: 'high',
      decidedBy: 'auto-name-match',
    });
    // Low confidence, but a person decided it. Publishable.
    await seedMapping('m-human', 'stub-human', {
      productId: APP_B,
      confidence: 'low',
      decidedBy: 'chris',
    });

    const json = await fetchStubs();
    const byId = Object.fromEntries(
      json.data.map((s: { id: string; mappings: { publishable: boolean }[] }) => [
        s.id,
        s.mappings[0].publishable,
      ]),
    );
    expect(byId['stub-auto']).toBe(false);
    expect(byId['stub-human']).toBe(true);
  });

  it('never ships the actions blob, and null reads as never-fetched', async () => {
    await seedStub('stub-null', { actions: null, actionCount: null });
    await seedStub('stub-fetched', {
      actions: [{ name: 'create_invoice' }],
      actionCount: 1,
      actionsFetchedAt: '2026-08-20T00:00:00.000Z',
    });

    const json = await fetchStubs();
    const raw = JSON.stringify(json);
    expect(raw).not.toContain('create_invoice');

    const byId = Object.fromEntries(
      json.data.map((s: { id: string; actions_fetched: boolean }) => [s.id, s.actions_fetched]),
    );
    expect(byId['stub-null']).toBe(false);
    expect(byId['stub-fetched']).toBe(true);
  });

  it('filters to undecided stubs — those with NO mapping row at all', async () => {
    await seedStub('stub-open');
    await seedStub('stub-closed');
    await seedMapping('m-closed', 'stub-closed', { productId: APP_A, decidedBy: 'chris' });

    const json = await fetchStubs('?state=undecided');
    expect(json.total).toBe(1);
    expect(json.data[0].id).toBe('stub-open');
  });

  it('filters to auto-pass proposals', async () => {
    await seedStub('stub-auto');
    await seedStub('stub-human');
    await seedMapping('m-auto', 'stub-auto', { productId: APP_A, decidedBy: 'auto-name-match' });
    await seedMapping('m-human', 'stub-human', { productId: APP_B, decidedBy: 'chris' });

    const json = await fetchStubs('?proposals_only=true');
    expect(json.data.map((s: { id: string }) => s.id)).toEqual(['stub-auto']);
  });

  it('returns a multi-mapping stub ONCE, with its total intact', async () => {
    // MindCloud's single `adp` listing is ADP Workforce Now and every edition
    // built within it. A join would return this stub twice and report total: 2.
    await seedStub('stub-adp');
    await seedMapping('m-a', 'stub-adp', { productId: APP_A, decidedBy: 'chris' });
    await seedMapping('m-b', 'stub-adp', { productId: APP_B, decidedBy: 'chris' });

    const json = await fetchStubs('?state=mapped');
    expect(json.total).toBe(1);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].mappings).toHaveLength(2);
  });

  it('hides tombstoned stubs unless asked, and says how many were never fetched', async () => {
    await seedStub('stub-live');
    await seedStub('stub-gone', { removedAt: '2026-08-15T00:00:00.000Z' });

    const hidden = await fetchStubs();
    expect(hidden.data.map((s: { id: string }) => s.id)).toEqual(['stub-live']);
    expect(hidden.advisories.map((n: { code: string }) => n.code)).toContain(
      'stub_actions_never_fetched',
    );

    const shown = await fetchStubs('?include_removed=true');
    expect(shown.total).toBe(2);
  });

  it('404s on an unknown catalogue', async () => {
    const res = await stubs().request(
      '/api/admin/connector-catalogs/nope/stubs',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(404);
  });
});

describe('GET /api/admin/connector-catalogs/:id/pairs', () => {
  const pairs = () =>
    mount('/api/admin/connector-catalogs/:id/pairs', createAdminConnectorPairsHandler(t.factory));

  const fetchPairs = async (qs = '') =>
    body(
      await pairs().request(
        `/api/admin/connector-catalogs/${CATALOG}/pairs${qs}`,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );

  it('renders both sides with their gate inputs, and says it is only the inputs', async () => {
    await seedStub('stub-a');
    await seedStub('stub-b');
    await seedMapping('m-a', 'stub-a', { productId: APP_A, decidedBy: 'chris' });
    // Side B is a machine proposal, so it does NOT clear the gate.
    await seedMapping('m-b', 'stub-b', { productId: APP_B, decidedBy: 'auto-name-match' });
    await t.db.insert(connectorPairs).values({
      id: 'pair-1',
      catalogId: CATALOG,
      stubAId: 'stub-a',
      stubBId: 'stub-b',
      surface: 'curated',
      firstSeenAt: '2026-08-01T00:00:00.000Z',
      lastSeenAt: '2026-08-30T00:00:00.000Z',
    });

    const json = await fetchPairs();
    expect(json.lane).toBe('reachable');
    expect(json.total).toBe(1);
    expect(json.data[0].side_a.product.slug).toBe('procore');
    expect(json.data[0].side_a.publishable).toBe(true);
    expect(json.data[0].side_b.product.slug).toBe('sage-intacct');
    expect(json.data[0].side_b.publishable).toBe(false);
    const codes = json.advisories.map((n: { code: string }) => n.code);
    expect(codes).toContain('publication_gate_inputs_only');
    expect(codes).toContain('reachable_never_counted');
  });

  it('serves the evidenced lane as empty, with the AECI-721 advisory', async () => {
    const json = await fetchPairs('?lane=evidenced');
    expect(json.lane).toBe('evidenced');
    expect(json.total).toBe(0);
    expect(json.data).toEqual([]);
    expect(json.advisories.map((n: { code: string }) => n.code)).toContain(
      'connector_evidenced_pairs_empty',
    );
  });
});

describe('GET /api/admin/connector-catalogs/:id/audit', () => {
  it('returns the flip AND the sync rows, newest first', async () => {
    await t.db.insert(auditLog).values([
      {
        id: u(600),
        actorId: null,
        actorType: 'system',
        action: 'connector_catalog.synced',
        entityType: 'connector_catalog',
        entityId: CATALOG,
        createdAt: '2026-08-29T00:00:00.000Z',
      },
      {
        id: u(601),
        actorId: ADMIN,
        actorType: 'admin',
        action: 'connector_catalog.managed_by_vendor',
        entityType: 'connector_catalog',
        entityId: CATALOG,
        createdAt: '2026-08-30T00:00:00.000Z',
      },
    ]);

    const app = mount(
      '/api/admin/connector-catalogs/:id/audit',
      createAdminConnectorAuditHandler(t.factory, noEmails),
    );
    const json = await body(
      await app.request(
        `/api/admin/connector-catalogs/${CATALOG}/audit`,
        {},
        TEST_ENV,
        fakeExecutionContext(),
      ),
    );
    expect(json.total).toBe(2);
    expect(json.data.map((r: { action: string }) => r.action)).toEqual([
      'connector_catalog.managed_by_vendor',
      'connector_catalog.synced',
    ]);
    // A system row has no actor id at all: `null` means "not a person", never
    // "person unknown".
    expect(json.data[1].actor).toBeNull();
    expect(json.actor_emails_available).toBe(true);
  });
});
