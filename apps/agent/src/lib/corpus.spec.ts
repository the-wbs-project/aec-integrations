import { describe, expect, it } from 'vitest';

import {
  buildCorpus,
  CORPUS_METADATA_KEYS,
  CORPUS_PREFIX,
  corpusKey,
  MAX_CUSTOM_METADATA_FIELDS,
} from './corpus';
import { DENIED_COLUMNS, DENIED_TABLES } from './columns';
import {
  addEvidencedPair,
  addIntegration,
  enrichProduct,
  FIXTURE_TIMESTAMP,
  IDS,
  seedCatalog,
} from '../test/catalog-fixture';
import type { ShimHandle } from '../test/d1';

/**
 * The corpus is the largest leak surface in the spike: a document is written
 * once and then served back to the model as a retrieved passage until the next
 * reindex. So the privacy assertions here are the same shape as
 * `tools/index.spec.ts` — data-driven off `DENIED_COLUMNS` and `DENIED_TABLES`
 * — but they run over rendered MARKDOWN rather than a JSON tree, because a
 * document has no keys to walk.
 */

/** Seed a catalog with narrative, taxonomy and edges on BOTH integration tables. */
async function seedRichCatalog(): Promise<ShimHandle> {
  const t = await seedCatalog();
  enrichProduct(t, IDS.zoho, {
    description: 'Zoho is a business suite used on construction back offices.',
    website: 'https://zoho.test',
    apiDocsUrl: 'https://zoho.test/api',
    usefulness: {
      audiences: [
        {
          slug: 'general-contractors',
          name: 'General contractors',
          points: ['Tracks budget changes.', 'Syncs invoices to accounting.'],
        },
      ],
      phases: [{ slug: 'preconstruction', name: 'Preconstruction', points: ['Builds estimates.'] }],
    },
  });
  // Category on zoho so the taxonomy block has a populated facet.
  t.raw
    .prepare(
      `INSERT INTO product_categories (product_id, category_id, created_at) VALUES (?, ?, ?)`,
    )
    .run(IDS.zoho, IDS.categoryEstimating, FIXTURE_TIMESTAMP);

  addIntegration(t, 'i1', IDS.zoho, IDS.esub, 'api');
  addEvidencedPair(t, 'e1', IDS.zoho, IDS.access);
  return t;
}

/** The exact document `seedRichCatalog()` must produce for `zoho`. */
const EXPECTED_ZOHO = [
  '# Zoho',
  '',
  '- Slug: zoho',
  '- Vendor: Acme Software',
  '- Product role: application',
  '- Website: https://zoho.test',
  '- API documentation: https://zoho.test/api',
  `- Catalog record updated: ${FIXTURE_TIMESTAMP}`,
  '',
  '## Description',
  '',
  'Zoho is a business suite used on construction back offices.',
  '',
  '## Taxonomy',
  '',
  '- Categories: Estimating',
  '- Audiences: None on record',
  '- Project phases: None on record',
  '- Trades: None on record',
  '',
  '## How teams use it',
  '',
  '### General contractors',
  '',
  '- Tracks budget changes.',
  '- Syncs invoices to accounting.',
  '',
  '### Preconstruction',
  '',
  '- Builds estimates.',
  '',
  '## Integrations (2)',
  '',
  '- Access Coins Evo (access-coins-evo) — connector-evidenced, via Agave ERP Sync',
  '- eSUB (esub) — api',
  '',
].join('\n');

describe('buildCorpus', () => {
  it('renders one product document byte for byte', async () => {
    // Guards: the whole document contract in one assertion. Anything added,
    // reordered or re-worded shows up here, which is what makes an accidental
    // field addition a test failure rather than a quiet publication.
    const t = await seedRichCatalog();
    const docs = await buildCorpus(t.db);
    const zoho = docs.find((d) => d.slug === 'zoho');
    expect(zoho?.markdown).toBe(EXPECTED_ZOHO);
    t.dispose();
  });

  it('keys each document under the corpus prefix', async () => {
    const t = await seedRichCatalog();
    const docs = await buildCorpus(t.db);
    expect(corpusKey('zoho')).toBe('products/zoho.md');
    for (const doc of docs) expect(doc.key).toBe(`${CORPUS_PREFIX}${doc.slug}.md`);
    t.dispose();
  });

  it('EXCLUDES an unpublished product', async () => {
    // Guards: the published predicate, `promotion_status = 'promoted'`. A corpus
    // that indexes a pending row lets the agent answer from a record the public
    // site does not show, and it keeps doing so until the next reindex.
    const t = await seedRichCatalog();
    const docs = await buildCorpus(t.db);
    expect(docs.map((d) => d.slug)).not.toContain('hidden-product');
    expect(docs.every((d) => !d.markdown.includes('Hidden Product'))).toBe(true);
    t.dispose();
  });

  it('lists integrations from BOTH tables — AECI-721', async () => {
    // Guards: the delivered tier is split across `integrations` and
    // `connector_evidenced_pairs` (STAGE_1_5_SPEC.md §13.1). A single-table
    // version of this query renders a plausible, wrong document for every
    // product that reaches partners only through a connector.
    const t = await seedRichCatalog();
    const zoho = (await buildCorpus(t.db)).find((d) => d.slug === 'zoho');
    expect(zoho?.markdown).toContain('## Integrations (2)');
    expect(zoho?.markdown).toContain('- eSUB (esub) — api');
    expect(zoho?.markdown).toContain(
      '- Access Coins Evo (access-coins-evo) — connector-evidenced, via Agave ERP Sync',
    );
    t.dispose();
  });

  it('lists an edge from BOTH of its endpoints', async () => {
    // Guards: the four-arm UNION. An edge is a fact about both endpoints, so
    // each table contributes a source-side and a target-side row.
    const t = await seedRichCatalog();
    const docs = await buildCorpus(t.db);
    expect(docs.find((d) => d.slug === 'esub')?.markdown).toContain('- Zoho (zoho) — api');
    expect(docs.find((d) => d.slug === 'access-coins-evo')?.markdown).toContain(
      '- Zoho (zoho) — connector-evidenced, via Agave ERP Sync',
    );
    t.dispose();
  });

  it('requires BOTH endpoints promoted for an edge to be listed', async () => {
    const t = await seedCatalog();
    addIntegration(t, 'i1', IDS.zoho, IDS.unpromoted, 'api');
    const zoho = (await buildCorpus(t.db)).find((d) => d.slug === 'zoho');
    expect(zoho?.markdown).toContain('## Integrations (0)');
    expect(zoho?.markdown).toContain('No integrations on record.');
    t.dispose();
  });

  it('orders products and partners case-insensitively with a tiebreaker (AECI-825)', async () => {
    // Guards: under BINARY collation `ADP` beats `Access`, and eSUB / iSqFt /
    // openBIM sort after Zoho. The `id` tiebreaker is what separates the two
    // `adp workforce now` rows, which NOCASE calls EQUAL.
    const t = await seedCatalog();
    const slugs = (await buildCorpus(t.db)).map((d) => d.slug);
    expect(slugs).toEqual([
      'access-coins-evo',
      'adp-workforce-now',
      'adp-workforce-now-eu',
      'agave-erp-sync',
      'esub',
      'isqft',
      'openbim',
      'zoho',
    ]);
    t.dispose();
  });

  it('never names an unpromoted vendor, and says so instead', async () => {
    // Guards: the promoted-vendor join guard. `esub`'s primary vendor is pending,
    // so its company name must not ride out on a published document.
    const t = await seedCatalog();
    const esub = (await buildCorpus(t.db)).find((d) => d.slug === 'esub');
    expect(esub?.markdown).toContain('- Vendor: Not on record');
    expect(esub?.markdown).not.toContain('Hidden Co');
    t.dispose();
  });

  it('drops a malformed usefulness blob rather than the whole document', async () => {
    // Guards: `usefulness` is a JSON text column. A partially-shaped blob must
    // cost the SECTION, never the product.
    const t = await seedCatalog();
    t.raw.prepare(`UPDATE products SET usefulness = ? WHERE id = ?`).run('{not json', IDS.zoho);
    const zoho = (await buildCorpus(t.db)).find((d) => d.slug === 'zoho');
    expect(zoho?.markdown).toContain('# Zoho');
    expect(zoho?.markdown).not.toContain('## How teams use it');
    t.dispose();
  });
});

describe('corpus metadata', () => {
  it('carries EXACTLY the five documented keys', async () => {
    // Guards: AI Search allows a maximum of five custom metadata fields per
    // instance, and changing the schema triggers a full re-index of every
    // document. The budget is fully spent, so a sixth key is a design change.
    expect(CORPUS_METADATA_KEYS).toHaveLength(MAX_CUSTOM_METADATA_FIELDS);
    const t = await seedRichCatalog();
    for (const doc of await buildCorpus(t.db)) {
      expect(Object.keys(doc.metadata).sort()).toEqual([...CORPUS_METADATA_KEYS].sort());
    }
    t.dispose();
  });

  it('fills every key with a filterable string', async () => {
    const t = await seedRichCatalog();
    const zoho = (await buildCorpus(t.db)).find((d) => d.slug === 'zoho');
    expect(zoho?.metadata).toEqual({
      type: 'product',
      slug: 'zoho',
      vendor: 'acme',
      role: 'application',
      updated_at: FIXTURE_TIMESTAMP,
    });
    t.dispose();
  });

  it('falls back to a named value when a product has no promoted vendor', async () => {
    const t = await seedCatalog();
    const esub = (await buildCorpus(t.db)).find((d) => d.slug === 'esub');
    expect(esub?.metadata.vendor).toBe('unknown');
    t.dispose();
  });
});

describe('corpus privacy fence', () => {
  it.each(DENIED_COLUMNS)(
    'no generated document mentions the denied column "%s"',
    async (column) => {
      // Guards: the point of the spike, on the surface where a mistake persists.
      // Data-driven off the denylist, so a new denied name is enforced against the
      // corpus for free.
      const t = await seedRichCatalog();
      for (const doc of await buildCorpus(t.db)) {
        expect(doc.markdown, `document "${doc.slug}" mentions "${column}"`).not.toContain(column);
        expect(JSON.stringify(doc.metadata)).not.toContain(column);
      }
      t.dispose();
    },
  );

  it('leaks none of the fixture DENIED VALUES', async () => {
    // Guards: the complement. A column name can be renamed on the way out, so
    // the fixture plants real internal VALUES on the same rows the corpus reads
    // — operator notes, a contact email, a VQS score, a priority tier and the
    // curation-internal `notes` on both integration tables.
    const t = await seedRichCatalog();
    const deniedValues = [
      'do not show', // products.admin_notes
      'internal', // products.research_notes / vendors.admin_notes
      'ops@acme.test', // vendors.contact_email
      '91.5', // vendors.vqs_total
      'tier_2', // products.priority_tier
      'curation internal', // integrations.notes + connector_evidenced_pairs.notes
    ];
    for (const doc of await buildCorpus(t.db)) {
      for (const value of deniedValues) {
        expect(doc.markdown, `document "${doc.slug}" leaked "${value}"`).not.toContain(value);
      }
    }
    t.dispose();
  });

  it.each(DENIED_TABLES)('does not read the denied table "%s"', async (table) => {
    // Guards: the whole-table ban, checked against the SOURCE — a denied table
    // only shows up in output once someone selects from it, and by then it has
    // shipped into an index.
    const { readSourceWithoutComments } = await import('../test/source-scan');
    const src = readSourceWithoutComments(new URL('./corpus.ts', import.meta.url));
    expect(src).not.toMatch(new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${table}\\b`, 'i'));
  });

  it('never emits SELECT *', async () => {
    const { readSourceWithoutComments } = await import('../test/source-scan');
    const src = readSourceWithoutComments(new URL('./corpus.ts', import.meta.url));
    expect(src).not.toMatch(/SELECT\s+\*/i);
  });
});
