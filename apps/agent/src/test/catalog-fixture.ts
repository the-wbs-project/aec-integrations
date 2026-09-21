/**
 * The shared catalog fixture for the agent's tool specs.
 *
 * The product NAMES are chosen, not arbitrary. `ADP Workforce Now` /
 * `Access Coins Evo` / `eSUB` / `iSqFt` / `openBIM` / `Zoho` are the exact set
 * that exposes AECI-825: under SQLite's default `BINARY` collation `ADP` beats
 * `Access` on `D` vs `c`, and the three lowercase-initial names sort after
 * `Zoho`. A fixture of evenly-cased names would let a regression pass.
 *
 * `ADP Workforce Now` and `adp workforce now` are both present, and they are
 * EQUAL under `NOCASE` — that pair is what makes the `id` tiebreaker testable.
 */
import { makeShimDb, type ShimHandle } from './d1';

/** Fixed timestamp: the schema's `created_at`/`updated_at` are NOT NULL with no
 *  SQL-side default (Drizzle supplies them), and this fixture writes raw SQL. */
const NOW = '2026-01-01T00:00:00.000Z';

export const IDS = {
  // Ordered so the id tiebreaker has a deterministic answer for the NOCASE tie.
  adpUpper: 'p-adp-1',
  adpLower: 'p-adp-2',
  access: 'p-access',
  esub: 'p-esub',
  isqft: 'p-isqft',
  openbim: 'p-openbim',
  zoho: 'p-zoho',
  connector: 'p-agave',
  unpromoted: 'p-hidden',
  vendorAcme: 'v-acme',
  vendorHidden: 'v-hidden',
  categoryEstimating: 'c-estimating',
  tradeRoofing: 't-roofing',
} as const;

/** A migrated shim seeded with the catalog above. Caller must `dispose()`. */
export async function seedCatalog(): Promise<ShimHandle> {
  const handle = makeShimDb();
  const { raw } = handle;

  const insertVendor = raw.prepare(
    `INSERT INTO vendors (id, slug, company_name, promotion_status, contact_email, admin_notes, vqs_total, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '${NOW}', '${NOW}')`,
  );
  insertVendor.run(
    IDS.vendorAcme,
    'acme',
    'Acme Software',
    'promoted',
    'ops@acme.test',
    'internal',
    91.5,
  );
  insertVendor.run(IDS.vendorHidden, 'hidden-co', 'Hidden Co', 'pending', null, null, null);

  const insertProduct = raw.prepare(
    `INSERT INTO products (id, slug, name, product_role, has_api_docs, promotion_status, admin_notes, research_notes, priority_tier, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '${NOW}', '${NOW}')`,
  );
  insertProduct.run(
    IDS.adpUpper,
    'adp-workforce-now',
    'ADP Workforce Now',
    'application',
    1,
    'promoted',
    'do not show',
    'internal',
    'tier_2',
  );
  insertProduct.run(
    IDS.adpLower,
    'adp-workforce-now-eu',
    'adp workforce now',
    'application',
    0,
    'promoted',
    null,
    null,
    null,
  );
  insertProduct.run(
    IDS.access,
    'access-coins-evo',
    'Access Coins Evo',
    'application',
    1,
    'promoted',
    null,
    null,
    null,
  );
  insertProduct.run(IDS.esub, 'esub', 'eSUB', 'application', 0, 'promoted', null, null, null);
  insertProduct.run(IDS.isqft, 'isqft', 'iSqFt', 'application', 1, 'promoted', null, null, null);
  insertProduct.run(IDS.openbim, 'openbim', 'openBIM', 'hybrid', 0, 'promoted', null, null, null);
  insertProduct.run(IDS.zoho, 'zoho', 'Zoho', 'application', 1, 'promoted', null, null, null);
  insertProduct.run(
    IDS.connector,
    'agave-erp-sync',
    'Agave ERP Sync',
    'connector',
    1,
    'promoted',
    null,
    null,
    null,
  );
  insertProduct.run(
    IDS.unpromoted,
    'hidden-product',
    'Hidden Product',
    'application',
    1,
    'pending',
    null,
    null,
    null,
  );

  raw
    .prepare(
      `INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at) VALUES (?, ?, 1, '${NOW}')`,
    )
    .run(IDS.zoho, IDS.vendorAcme);
  raw
    .prepare(
      `INSERT INTO product_vendors (product_id, vendor_id, is_primary, created_at) VALUES (?, ?, 1, '${NOW}')`,
    )
    .run(IDS.esub, IDS.vendorHidden);

  raw
    .prepare(
      `INSERT INTO taxonomy_categories (id, slug, name, created_at, updated_at)
       VALUES (?, 'estimating', 'Estimating', '${NOW}', '${NOW}')`,
    )
    .run(IDS.categoryEstimating);
  raw
    .prepare(
      `INSERT INTO product_categories (product_id, category_id, created_at) VALUES (?, ?, '${NOW}')`,
    )
    .run(IDS.isqft, IDS.categoryEstimating);

  raw
    .prepare(
      `INSERT INTO taxonomy_trades (id, slug, name, description, created_at, updated_at)
       VALUES (?, 'roofing', 'Roofing', 'Roofing work.', '${NOW}', '${NOW}')`,
    )
    .run(IDS.tradeRoofing);
  raw
    .prepare(
      `INSERT INTO product_trades (product_id, trade_id, created_at) VALUES (?, ?, '${NOW}')`,
    )
    .run(IDS.esub, IDS.tradeRoofing);

  return handle;
}

/** Add a direct `integrations` edge between two promoted products. */
export function addIntegration(
  handle: ShimHandle,
  id: string,
  sourceId: string,
  targetId: string,
  mechanismKind: string | null,
): void {
  handle.raw
    .prepare(
      `INSERT INTO integrations (id, source_product_id, target_product_id, mechanism_kind, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'curation internal', '${NOW}', '${NOW}')`,
    )
    .run(id, sourceId, targetId, mechanismKind);
}

/** Add a `connector_evidenced_pairs` row. Endpoints are sorted to satisfy the
 *  canonical-order CHECK; the connector must differ from both. */
export function addEvidencedPair(
  handle: ShimHandle,
  id: string,
  endpointOne: string,
  endpointTwo: string,
  connectorId: string = IDS.connector,
): void {
  const [a, b] = [endpointOne, endpointTwo].sort();
  handle.raw
    .prepare(
      `INSERT INTO connector_evidenced_pairs (id, connector_product_id, product_a_id, product_b_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'curation internal', '${NOW}', '${NOW}')`,
    )
    .run(id, connectorId, a, b);
}

/**
 * Fill in the narrative columns `seedCatalog()` leaves NULL, for the corpus
 * specs. Kept out of the base seed deliberately: the tool specs assert over a
 * catalog with empty optional fields, and changing that would rewrite their
 * expectations for no reason.
 *
 * `usefulness` is the STORED shape of the vendor-authored "How teams use it"
 * narrative (AECI-963) — `{ audiences: [...], phases: [...] }`, each group
 * carrying `slug`, the server-resolved `name`, and >= 1 `points` entry.
 */
export function enrichProduct(
  handle: ShimHandle,
  id: string,
  fields: {
    description?: string | null;
    website?: string | null;
    apiDocsUrl?: string | null;
    usefulness?: unknown;
  },
): void {
  handle.raw
    .prepare(
      `UPDATE products
          SET description = COALESCE(?, description),
              website = COALESCE(?, website),
              api_docs_url = COALESCE(?, api_docs_url),
              usefulness = COALESCE(?, usefulness)
        WHERE id = ?`,
    )
    .run(
      fields.description ?? null,
      fields.website ?? null,
      fields.apiDocsUrl ?? null,
      fields.usefulness === undefined ? null : JSON.stringify(fields.usefulness),
      id,
    );
}

/** The fixed `updated_at` every fixture row carries. */
export const FIXTURE_TIMESTAMP = NOW;
