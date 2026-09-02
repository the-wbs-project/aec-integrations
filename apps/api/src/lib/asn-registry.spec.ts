/**
 * The §7.6 ASN registry (AECI-624) against the in-memory D1 harness.
 *
 * The centre of gravity is the property the whole design rests on — **an
 * annotation feed must never re-verdict, and must never lose what it already
 * knows**. So the load-bearing cases are the negative ones:
 *
 *   - a refresh does not touch a single `page_views.is_bot`, on any path;
 *   - an upstream that 500s, returns garbage, or returns an empty list leaves the
 *     last good rows exactly where they were, rather than emptying the table;
 *   - "the registry has no record" and "the registry has a record with no type"
 *     stay distinguishable end to end, because a quarter of production traffic is
 *     in one of those two states and neither is a finding.
 *
 * The chunking cases exist because D1 caps a query at 100 bound parameters while
 * better-sqlite3 does not: a size-blind implementation passes every spec here and
 * fails in production, which is the same trap `SQLITE_MAX_COMPOUND_SELECT` sets in
 * `routes/admin-system.spec.ts`.
 */

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { asnRegistry, pageViews } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  ASN_REGISTRY_SOURCE,
  READ_ASNS_PER_QUERY,
  UPSERT_ROWS_PER_STATEMENT,
  asnRegistryFreshness,
  distinctPageViewAsns,
  loadAsnAnnotations,
  networkClassOf,
  parsePeeringDbNetworks,
  refreshAsnRegistry,
} from './asn-registry';

const NOW = new Date('2026-08-17T02:00:00.000Z');

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

/** A PeeringDB-shaped response for the given records. */
function feed(
  records: { asn: number; info_type?: string | null; name?: string | null }[],
): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: records }),
  }) as unknown as typeof fetch;
}

/** Seed `page_views` rows carrying the given ASNs. `is_bot` is set explicitly so
 *  the "refresh never re-verdicts" assertions have something to be about. */
async function seenAsns(asns: (number | null)[], isBot = false): Promise<void> {
  await t.db.insert(pageViews).values(
    asns.map((asn, i) => ({
      path: `/products/p${i}`,
      cfAsn: asn,
      isBot,
      createdAt: '2026-08-16T00:00:00.000Z',
    })),
  );
}

async function storedRegistry() {
  return t.db.select().from(asnRegistry);
}

// ---------------------------------------------------------------------------

describe('networkClassOf', () => {
  it('maps every value PeeringDB actually emits', () => {
    expect(networkClassOf('Cable/DSL/ISP')).toBe('eyeball');
    expect(networkClassOf('Enterprise')).toBe('eyeball');
    expect(networkClassOf('Educational/Research')).toBe('eyeball');
    expect(networkClassOf('Non-Profit')).toBe('eyeball');
    expect(networkClassOf('Government')).toBe('eyeball');
    expect(networkClassOf('NSP')).toBe('transit');
    expect(networkClassOf('Content')).toBe('non_eyeball');
    expect(networkClassOf('Network Services')).toBe('non_eyeball');
    expect(networkClassOf('Route Server')).toBe('non_eyeball');
    expect(networkClassOf('Route Collector')).toBe('non_eyeball');
  });

  it('keeps transit OUT of eyeball — a carrier corroborates nothing either way', () => {
    // The distinction is the whole reason there are four members rather than
    // three: NSP carries residential subscribers and scrapers alike, so folding
    // it into `eyeball` would turn "we cannot tell" into "this is a person".
    expect(networkClassOf('NSP')).not.toBe('eyeball');
  });

  it('reads null, blank and unrecognized as unclassified, never as eyeball', () => {
    // ~25% of production traffic lands here. Defaulting any of it to `eyeball`
    // would manufacture a corroboration the registry never gave.
    expect(networkClassOf(null)).toBe('unclassified');
    expect(networkClassOf(undefined)).toBe('unclassified');
    expect(networkClassOf('')).toBe('unclassified');
    expect(networkClassOf('Something New Upstream')).toBe('unclassified');
  });
});

describe('parsePeeringDbNetworks', () => {
  it('keeps well-formed records and normalizes blanks to null', () => {
    expect(
      parsePeeringDbNetworks({
        data: [
          { asn: 30058, info_type: 'Content', name: 'FDCServers.Net' },
          { asn: 64500, info_type: '  ', name: '' },
        ],
      }),
    ).toEqual([
      { asn: 30058, infoType: 'Content', name: 'FDCServers.Net' },
      { asn: 64500, infoType: null, name: null },
    ]);
  });

  it('drops records with no usable ASN rather than storing a lie', () => {
    expect(
      parsePeeringDbNetworks({
        data: [
          { asn: 0, info_type: 'Content' },
          { asn: -1, info_type: 'Content' },
          { asn: '30058', info_type: 'Content' },
          { asn: 1.5, info_type: 'Content' },
          null,
          'nonsense',
          { asn: 20001, info_type: 'Cable/DSL/ISP', name: 'Charter' },
        ],
      }),
    ).toEqual([{ asn: 20001, infoType: 'Cable/DSL/ISP', name: 'Charter' }]);
  });

  it('returns [] for an envelope it does not recognize', () => {
    expect(parsePeeringDbNetworks(null)).toEqual([]);
    expect(parsePeeringDbNetworks({})).toEqual([]);
    expect(parsePeeringDbNetworks({ data: 'not an array' })).toEqual([]);
    expect(parsePeeringDbNetworks([{ asn: 1 }])).toEqual([]);
  });
});

describe('refreshAsnRegistry — the join domain', () => {
  it('stores only the ASNs page_views has actually seen', async () => {
    await seenAsns([20001, 30058]);

    const result = await refreshAsnRegistry(
      t.db,
      feed([
        { asn: 20001, info_type: 'Cable/DSL/ISP', name: 'Charter' },
        { asn: 30058, info_type: 'Content', name: 'FDCServers.Net' },
        // ~34,000 upstream networks we will never join against.
        { asn: 64501, info_type: 'Content', name: 'Never Seen' },
      ]),
      NOW,
    );

    expect(result).toMatchObject({ status: 'ok', fetched: 3, seen: 2, matched: 2, written: 2 });
    expect((await storedRegistry()).map((r) => r.asn).sort()).toEqual([20001, 30058]);
  });

  it('stamps source and fetched_at, and stores info_type verbatim', async () => {
    await seenAsns([30058]);
    await refreshAsnRegistry(
      t.db,
      feed([{ asn: 30058, info_type: 'Content', name: 'FDCServers.Net' }]),
      NOW,
    );

    expect(await storedRegistry()).toEqual([
      {
        asn: 30058,
        // Verbatim: re-coding it at write time would bake today's reading of
        // their taxonomy into stored data.
        infoType: 'Content',
        asName: 'FDCServers.Net',
        source: ASN_REGISTRY_SOURCE,
        fetchedAt: NOW.toISOString(),
      },
    ]);
  });

  it('is idempotent — a second run updates in place rather than duplicating', async () => {
    await seenAsns([30058]);
    const later = new Date('2026-08-24T02:00:00.000Z');

    await refreshAsnRegistry(
      t.db,
      feed([{ asn: 30058, info_type: 'Content', name: 'Old Name' }]),
      NOW,
    );
    await refreshAsnRegistry(
      t.db,
      feed([{ asn: 30058, info_type: 'NSP', name: 'New Name' }]),
      later,
    );

    const rows = await storedRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      infoType: 'NSP',
      asName: 'New Name',
      fetchedAt: later.toISOString(),
    });
  });

  it('writes more rows than fit in one statement', async () => {
    // D1 caps a query at 100 bound parameters and this table has five columns, so
    // anything past 20 rows must span statements. better-sqlite3 would happily
    // accept one giant statement, which is exactly why this asserts the OUTCOME
    // for a set larger than the chunk rather than the statement count.
    const many = Array.from({ length: UPSERT_ROWS_PER_STATEMENT * 3 + 7 }, (_, i) => 64500 + i);
    await seenAsns(many);

    const result = await refreshAsnRegistry(
      t.db,
      feed(many.map((asn) => ({ asn, info_type: 'Content', name: `net-${asn}` }))),
      NOW,
    );

    expect(result.written).toBe(many.length);
    expect(await storedRegistry()).toHaveLength(many.length);
  });
});

describe('refreshAsnRegistry — fail-open', () => {
  /** Put one good row in the table so every failure case can assert survival. */
  async function seedExistingRegistry(): Promise<void> {
    await seenAsns([30058]);
    await refreshAsnRegistry(
      t.db,
      feed([{ asn: 30058, info_type: 'Content', name: 'FDCServers.Net' }]),
      NOW,
    );
  }

  it('leaves the last good rows in place when the upstream errors', async () => {
    await seedExistingRegistry();
    const broken = vi
      .fn()
      .mockRejectedValue(new Error('network unreachable')) as unknown as typeof fetch;

    const result = await refreshAsnRegistry(t.db, broken, new Date('2026-08-24T02:00:00.000Z'));

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('network unreachable');
    // The failure mode of an annotation feed must be "old answer", never "no
    // answer, silently".
    expect(await storedRegistry()).toHaveLength(1);
  });

  it('treats a non-2xx as failure and keeps the rows', async () => {
    await seedExistingRegistry();
    const down = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;

    const result = await refreshAsnRegistry(t.db, down, NOW);

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('503');
    expect(await storedRegistry()).toHaveLength(1);
  });

  it('treats an EMPTY upstream as failure, not as a clean run', async () => {
    await seedExistingRegistry();

    const result = await refreshAsnRegistry(t.db, feed([]), NOW);

    // Reporting `ok, 0 written` here would let a silently-broken feed read as a
    // healthy run forever, and the coverage gauge would never move.
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('upstream returned no networks');
    expect(await storedRegistry()).toHaveLength(1);
  });

  it('reports ok with nothing written when there is no traffic to annotate', async () => {
    // A fresh environment. The feed is healthy; the intersection is simply empty,
    // and that is not a failure.
    const result = await refreshAsnRegistry(
      t.db,
      feed([{ asn: 20001, info_type: 'Cable/DSL/ISP' }]),
      NOW,
    );

    expect(result).toMatchObject({ status: 'ok', fetched: 1, seen: 0, matched: 0, written: 0 });
  });
});

describe('refreshAsnRegistry — never re-verdicts', () => {
  it('leaves every page_views.is_bot exactly as ingest wrote it', async () => {
    // AS30058 is registered `Content` and is NOT in DATACENTER_ASNS, so ingest
    // wrote is_bot=0. The registry disagreeing must change the annotation and
    // nothing else — that pairing IS the design, not a conflict to resolve.
    await seenAsns([30058, 30058, 20001], false);
    const before = await t.db.select({ id: pageViews.id, isBot: pageViews.isBot }).from(pageViews);

    await refreshAsnRegistry(
      t.db,
      feed([
        { asn: 30058, info_type: 'Content', name: 'FDCServers.Net' },
        { asn: 20001, info_type: 'Cable/DSL/ISP', name: 'Charter' },
      ]),
      NOW,
    );

    const after = await t.db.select({ id: pageViews.id, isBot: pageViews.isBot }).from(pageViews);
    expect(after).toEqual(before);
    expect(after.every((r) => r.isBot === false)).toBe(true);
  });
});

describe('distinctPageViewAsns', () => {
  it('deduplicates and drops nulls', async () => {
    await seenAsns([20001, 20001, null, 30058]);
    expect((await distinctPageViewAsns(t.db)).sort()).toEqual([20001, 30058]);
  });
});

describe('loadAsnAnnotations', () => {
  it('derives network_class and returns the upstream word beside it', async () => {
    await seenAsns([30058]);
    await refreshAsnRegistry(
      t.db,
      feed([{ asn: 30058, info_type: 'Content', name: 'FDCServers.Net' }]),
      NOW,
    );

    const map = await loadAsnAnnotations(t.db, [30058]);

    expect(map.get(30058)).toEqual({
      asn: 30058,
      info_type: 'Content',
      as_name: 'FDCServers.Net',
      network_class: 'non_eyeball',
      source: ASN_REGISTRY_SOURCE,
      fetched_at: NOW.toISOString(),
    });
  });

  it('omits an unknown ASN instead of returning a null-filled record', async () => {
    // "Never heard of this network" and "listed, but with no type" are different
    // statements. A caller that wants to collapse them can; one that does not is
    // not forced to.
    const map = await loadAsnAnnotations(t.db, [64500]);
    expect(map.has(64500)).toBe(false);
  });

  it('keeps a typeless record as a PRESENT annotation reading unclassified', async () => {
    await seenAsns([64500]);
    await refreshAsnRegistry(
      t.db,
      feed([{ asn: 64500, info_type: null, name: 'Typeless Net' }]),
      NOW,
    );

    const map = await loadAsnAnnotations(t.db, [64500]);
    expect(map.get(64500)).toMatchObject({ info_type: null, network_class: 'unclassified' });
  });

  it('reads more ASNs than fit in one IN (…) list', async () => {
    const many = Array.from({ length: READ_ASNS_PER_QUERY * 2 + 5 }, (_, i) => 64500 + i);
    await seenAsns(many);
    await refreshAsnRegistry(t.db, feed(many.map((asn) => ({ asn, info_type: 'NSP' }))), NOW);

    const map = await loadAsnAnnotations(t.db, many);
    expect(map.size).toBe(many.length);
  });

  it('returns an empty map for an empty request without querying', async () => {
    expect((await loadAsnAnnotations(t.db, [])).size).toBe(0);
  });
});

describe('asnRegistryFreshness', () => {
  it('reports never-populated as NOT stale', async () => {
    await seenAsns([20001]);

    // A fresh environment has nothing to be stale about. Flagging it would make
    // the one state an operator can ignore look like the one they cannot.
    expect(await asnRegistryFreshness(t.db, NOW)).toEqual({
      entries: 0,
      fetched_at: null,
      age_hours: null,
      stale: false,
      coverage: 0,
    });
  });

  it('reports coverage as null when there is no traffic to cover', async () => {
    // 0/0 is "not applicable", not 0% — rounding it down would show a brand-new
    // environment a gauge that reads broken.
    expect((await asnRegistryFreshness(t.db, NOW)).coverage).toBeNull();
  });

  it('measures coverage against the ASNs seen, not the rows stored', async () => {
    await seenAsns([20001, 30058, 64500, 64501]);
    await refreshAsnRegistry(
      t.db,
      feed([
        { asn: 20001, info_type: 'Cable/DSL/ISP' },
        { asn: 30058, info_type: 'Content' },
      ]),
      NOW,
    );

    const status = await asnRegistryFreshness(t.db, NOW);
    expect(status.entries).toBe(2);
    expect(status.coverage).toBe(0.5);
    expect(status.stale).toBe(false);
    expect(status.age_hours).toBe(0);
  });

  it('goes stale after two missed refreshes, not one', async () => {
    await seenAsns([30058]);
    await refreshAsnRegistry(t.db, feed([{ asn: 30058, info_type: 'Content' }]), NOW);

    const oneWeek = new Date(NOW.getTime() + 7 * 86_400_000);
    const threeWeeks = new Date(NOW.getTime() + 21 * 86_400_000);

    expect((await asnRegistryFreshness(t.db, oneWeek)).stale).toBe(false);
    expect((await asnRegistryFreshness(t.db, threeWeeks)).stale).toBe(true);
  });

  it('reads the NEWEST fetched_at when rows were written at different times', async () => {
    await seenAsns([20001, 30058]);
    await refreshAsnRegistry(t.db, feed([{ asn: 20001, info_type: 'Cable/DSL/ISP' }]), NOW);
    const later = new Date('2026-08-24T02:00:00.000Z');
    await refreshAsnRegistry(t.db, feed([{ asn: 30058, info_type: 'Content' }]), later);

    expect((await asnRegistryFreshness(t.db, later)).fetched_at).toBe(later.toISOString());
  });
});

describe('the annotation is joinable from page_views', () => {
  it('matches on cf_asn without a foreign key', async () => {
    // No FK by design: `page_views` rows are pruned at 400 days and ASNs are not
    // ours to own, so the join is by value and an absent row is a normal state.
    await seenAsns([30058]);
    await refreshAsnRegistry(t.db, feed([{ asn: 30058, info_type: 'Content' }]), NOW);

    const [row] = await t.db.select().from(pageViews).where(eq(pageViews.cfAsn, 30058));
    const map = await loadAsnAnnotations(t.db, [row!.cfAsn!]);
    expect(map.get(30058)?.network_class).toBe('non_eyeball');
  });
});
