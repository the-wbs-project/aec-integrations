/**
 * The `asn_registry` refresh + read helpers (AECI-624).
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §7.6, §9.7, §9.8.
 *
 * ─── The problem this solves ─────────────────────────────────────────────────
 *
 * `page_views.is_bot` is written once, at ingest, from the hand-curated
 * `DATACENTER_ASNS` map (`lib/bot-classification.ts`). That map is deliberately
 * strict — a false positive deletes a real human from the digest — so it lists
 * only ASNs whose registered holder *cannot* have a residential subscriber behind
 * it. The consequence is a class of miss: on 2026-08-13 five requests hit one
 * product page inside 1.9 seconds from Amsterdam, Los Angeles and Singapore with
 * the referrer cycling Google → none → YouTube → none → ChatGPT, and three of the
 * five counted as human because AS30058 (FDCservers.net, a dedicated-server host)
 * is not on the list.
 *
 * The tempting fix — adopt a maintained external list — was measured against
 * production before this module existed, and does not work. Neither
 * X4BNet/lists_vpn nor brianhama/bad-asn-list contains AS30058; 56 of our own 109
 * entries appear in neither (ours was censused from real traffic, so it is the
 * more targeted list); and X4BNet contains AS208323, the Tor exits
 * `bot-classification.ts` excludes on purpose. Adopting one wholesale would flip
 * 74 of 2,500 human rows and quietly violate our own membership doctrine.
 *
 * ─── So: annotate, never re-verdict ──────────────────────────────────────────
 *
 * Nothing in this module writes `page_views`. The registry is joined at READ time
 * to say what the ASN is *registered as* — "AS30058 is registered as `Content`,
 * not an eyeball network" — beside an `is_bot` that stays exactly as ingest left
 * it. Two properties fall out of that:
 *
 *   - Improving the feed improves every historical row for free. No backfill, no
 *     rewritten verdicts, no Monday-morning history edit.
 *   - The annotation can be wrong without corrupting anything, because it is
 *     labelled as the registry's claim rather than absorbed into ours.
 *
 * ─── Why PeeringDB ───────────────────────────────────────────────────────────
 *
 * It is the only free source with a real per-ASN classification: one
 * unauthenticated request returns ~35,000 networks with an `info_type`. The
 * trade-off is coverage, and it is honestly poor at the tail — against the 2,500
 * human-classified production rows, 70% land on `Cable/DSL/ISP`/`NSP`, 2.2% on
 * `Content` (the bucket holding AS30058), and **25% have no usable signal at
 * all** (no record, or a record with a blank `info_type`). That 25% is why
 * {@link AsnNetworkClass} carries an explicit `unclassified` member instead of
 * defaulting the unknown case into `eyeball`.
 *
 * Typed ASN data with a true `hosting` flag exists (IPinfo's ASN database,
 * ipapi.is at $49/mo) and is the upgrade path if the tail ever matters.
 * `asn_registry.source` is per-row precisely so a second feed can land beside
 * this one.
 */

import { eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { asnRegistry, pageViews } from '../db/schema';

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** `asn_registry.source` for rows written from PeeringDB. */
export const ASN_REGISTRY_SOURCE = 'peeringdb';

/**
 * The whole network list in one unauthenticated GET. `fields=` is load-bearing:
 * the unprojected response is tens of megabytes of contact/facility records,
 * while this projection is ~2 MB for ~35,000 rows.
 */
export const PEERINGDB_NETWORKS_URL = 'https://www.peeringdb.com/api/net?fields=asn,info_type,name';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Our coarse reading of the upstream's vocabulary. Four members, and the fourth
 * is not a formality — a quarter of production traffic lands in it.
 *
 * - `eyeball` — a network real people browse from: consumer ISPs, but also
 *   corporate, university, non-profit and government networks. Confirms `is_bot=0`.
 * - `transit` — tier-1 / wholesale carriers. Carries everyone, so it confirms
 *   nothing either way. Kept separate from `eyeball` rather than folded into it
 *   because "we can't tell" and "it's a person" are different answers.
 * - `non_eyeball` — registered, and registered as something no residential
 *   subscriber sits behind: content/CDN networks, network services, route
 *   servers. **This is a suspicion, not a verdict** — Google and Netflix are
 *   `Content` too. It means "not an eyeball network", never "hosting".
 * - `unclassified` — no record, or a record with a blank `info_type`. Says
 *   nothing at all, and must not be rendered as if it said something.
 *
 * A pure function over the stored `info_type` rather than a stored column, so
 * revising this reading costs no migration and no re-fetch.
 */
export type AsnNetworkClass = 'eyeball' | 'transit' | 'non_eyeball' | 'unclassified';

/**
 * PeeringDB's `info_type` vocabulary → {@link AsnNetworkClass}.
 *
 * Every value the feed emits is listed, including the ones that map to the same
 * bucket, so an unrecognized value is genuinely new upstream rather than merely
 * unhandled here — the `??` fallthrough in {@link networkClassOf} is then the
 * honest `unclassified` rather than a silent mis-bucketing.
 */
const NETWORK_CLASS_BY_INFO_TYPE: Readonly<Record<string, AsnNetworkClass>> = {
  'Cable/DSL/ISP': 'eyeball',
  Enterprise: 'eyeball',
  'Educational/Research': 'eyeball',
  'Non-Profit': 'eyeball',
  Government: 'eyeball',
  NSP: 'transit',
  Content: 'non_eyeball',
  'Network Services': 'non_eyeball',
  'Route Server': 'non_eyeball',
  'Route Collector': 'non_eyeball',
};

/** Classify one stored `info_type`. Null, empty and unrecognized all read as
 *  `unclassified` — the registry knowing nothing is a fact worth surfacing, and
 *  it is not the same fact as "this is a person". */
export function networkClassOf(infoType: string | null | undefined): AsnNetworkClass {
  if (!infoType) return 'unclassified';
  return NETWORK_CLASS_BY_INFO_TYPE[infoType] ?? 'unclassified';
}

// ---------------------------------------------------------------------------
// Upstream fetch
// ---------------------------------------------------------------------------

/** One upstream network record, after parsing. */
export interface PeeringDbNetwork {
  asn: number;
  /** Verbatim upstream value; `null` for the ~29% of records with a blank one. */
  infoType: string | null;
  name: string | null;
}

/** A non-object, non-array `unknown` narrowed for field access. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimmedOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parse the upstream envelope, dropping records that carry no usable ASN.
 *
 * Shape-checked rather than cast: this crossed a process boundary and is not our
 * schema. A malformed envelope yields `[]`, which the caller treats as a failed
 * refresh — never as "the registry is now empty", because nothing here deletes.
 */
export function parsePeeringDbNetworks(payload: unknown): PeeringDbNetwork[] {
  const root = asRecord(payload);
  const data = root?.['data'];
  if (!Array.isArray(data)) return [];

  const out: PeeringDbNetwork[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    if (!record) continue;
    const asn = record['asn'];
    // AS0 is reserved and never a real holder, so `> 0` is the membership test.
    if (typeof asn !== 'number' || !Number.isInteger(asn) || asn <= 0) continue;
    out.push({
      asn,
      infoType: trimmedOrNull(record['info_type']),
      name: trimmedOrNull(record['name']),
    });
  }
  return out;
}

/** GET the network list. Throws on a non-2xx or unparseable body; the job shell
 *  turns that into a fail-open `status: 'failed'` with the old rows untouched. */
export async function fetchPeeringDbNetworks(
  fetchImpl: typeof fetch,
  url: string = PEERINGDB_NETWORKS_URL,
  apiKey?: string,
): Promise<PeeringDbNetwork[]> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'user-agent': 'aeci-admin-panel/asn-registry',
  };
  // AECI-661. PeeringDB throttles ANONYMOUS reads hard, and the whole-list GET
  // above is exactly the shape it throttles first: production's only run of this
  // job (2026-08-23) came back `429` and the table has been empty ever since.
  // A free PeeringDB account issues a key with a workable limit.
  //
  // Optional on purpose — absent, this behaves exactly as it did before, so no
  // environment hard-fails on a secret it has not been given yet.
  if (apiKey) headers.authorization = `Api-Key ${apiKey}`;

  const response = await fetchImpl(url, { headers });
  if (!response.ok) {
    // Name the throttle explicitly. `peeringdb responded 429` was a truthful but
    // inert message: it told the operator the status code and nothing about the
    // fix, and it sat unread in `job_runs` for days.
    if (response.status === 429) {
      throw new Error(
        apiKey
          ? 'peeringdb responded 429 (rate limited despite an API key; back off or reduce frequency)'
          : 'peeringdb responded 429 (rate limited; set PEERINGDB_API_KEY, anonymous reads are throttled)',
      );
    }
    throw new Error(`peeringdb responded ${response.status}`);
  }
  return parsePeeringDbNetworks(await response.json());
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------

/**
 * Rows per upsert statement.
 *
 * D1 caps a query at **100 bound parameters**
 * (developers.cloudflare.com/d1/platform/limits/), and this table has five
 * columns, so 20 rows saturates exactly one statement. Sized off the documented
 * limit rather than measured locally on purpose: better-sqlite3 has a far higher
 * ceiling, so a spec would pass at any chunk size while production failed — the
 * same trap `SQLITE_MAX_COMPOUND_SELECT` sets in `routes/admin-system.ts`.
 */
export const UPSERT_ROWS_PER_STATEMENT = 20;

/**
 * ASNs per `IN (…)` read. Same 100-parameter ceiling, one column, minus headroom
 * for the predicates a caller may add.
 */
export const READ_ASNS_PER_QUERY = 90;

export interface AsnRegistryRefreshResult {
  status: 'ok' | 'failed';
  /** Networks the upstream returned. */
  fetched: number;
  /** Distinct non-null `page_views.cf_asn` values — the join domain. */
  seen: number;
  /** `fetched ∩ seen`: how many seen ASNs the upstream could classify. */
  matched: number;
  /** Rows actually upserted (`matched` minus anything a failed chunk dropped). */
  written: number;
  /** Upsert statements that threw. Non-zero still leaves a usable registry. */
  failedChunks: number;
  /** Present on `status: 'failed'`, or on a partial write. */
  reason?: string;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every distinct ASN `page_views` has recorded — the only ASNs worth storing a
 *  classification for, since they are the only ones anything joins against. */
export async function distinctPageViewAsns(db: Db): Promise<number[]> {
  const rows = await db
    .selectDistinct({ asn: pageViews.cfAsn })
    .from(pageViews)
    .where(isNotNull(pageViews.cfAsn));
  return rows.map((r) => r.asn).filter((asn): asn is number => typeof asn === 'number');
}

/**
 * Refresh the registry from the upstream feed.
 *
 * Three properties this deliberately has:
 *
 *   - **Nothing is ever deleted.** An upstream outage, an empty response, a
 *     schema change on their side — every one of those leaves the last good rows
 *     in place, annotated with their real `fetched_at` so the System screen can
 *     call them stale. The failure mode of an annotation feed must be "old
 *     answer", never "no answer, silently".
 *   - **The write is idempotent.** One `ON CONFLICT` upsert keyed on the ASN, so
 *     a re-run (or a retry, if this ever becomes queue-backed) converges rather
 *     than duplicating.
 *   - **Chunks are individually isolated.** A statement that throws costs its 20
 *     rows and no more; the run reports `failedChunks` and keeps going, because a
 *     registry missing 20 of 878 ASNs is worth far more than no registry.
 */
export async function refreshAsnRegistry(
  db: Db,
  fetchImpl: typeof fetch,
  now: Date,
  opts: { url?: string; apiKey?: string } = {},
): Promise<AsnRegistryRefreshResult> {
  const empty = { fetched: 0, seen: 0, matched: 0, written: 0, failedChunks: 0 };

  let networks: PeeringDbNetwork[];
  try {
    networks = await fetchPeeringDbNetworks(fetchImpl, opts.url, opts.apiKey);
  } catch (error) {
    return {
      ...empty,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (networks.length === 0) {
    // Distinguished from a successful empty intersection below: an upstream that
    // returned nothing is broken, and treating it as "ok, 0 written" would let a
    // silent feed outage read as a clean run forever.
    return { ...empty, status: 'failed', reason: 'upstream returned no networks' };
  }

  let seen: number[];
  try {
    seen = await distinctPageViewAsns(db);
  } catch (error) {
    return {
      ...empty,
      fetched: networks.length,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const wanted = new Set(seen);
  const fetchedAt = now.toISOString();
  const rows = networks
    .filter((n) => wanted.has(n.asn))
    .map((n) => ({
      asn: n.asn,
      infoType: n.infoType,
      asName: n.name,
      source: ASN_REGISTRY_SOURCE,
      fetchedAt,
    }));

  let written = 0;
  let failedChunks = 0;
  let firstReason: string | undefined;
  for (const batch of chunk(rows, UPSERT_ROWS_PER_STATEMENT)) {
    try {
      await db
        .insert(asnRegistry)
        .values(batch)
        .onConflictDoUpdate({
          target: asnRegistry.asn,
          set: {
            infoType: sql`excluded.info_type`,
            asName: sql`excluded.as_name`,
            source: sql`excluded.source`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        });
      written += batch.length;
    } catch (error) {
      failedChunks += 1;
      firstReason ??= error instanceof Error ? error.message : String(error);
    }
  }

  return {
    status: failedChunks > 0 && written === 0 ? 'failed' : 'ok',
    fetched: networks.length,
    seen: seen.length,
    matched: rows.length,
    written,
    failedChunks,
    ...(firstReason ? { reason: firstReason } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

/**
 * What the registry says about one ASN, as the admin API returns it.
 *
 * `info_type` is the upstream's word and `network_class` is ours; both travel so
 * the UI can show the claim and the reading of it without the reader having to
 * trust that our bucket is right.
 */
export interface AsnAnnotation {
  asn: number;
  info_type: string | null;
  as_name: string | null;
  network_class: AsnNetworkClass;
  source: string;
  fetched_at: string;
}

/**
 * Annotations for the given ASNs, keyed by ASN.
 *
 * An ASN with no row is **absent from the map**, not present-with-nulls: "the
 * registry has never heard of this network" is a different statement from "the
 * registry lists it without a type", and a caller that wants to collapse them can,
 * while one that does not is not forced to.
 *
 * Chunked at {@link READ_ASNS_PER_QUERY} against D1's 100-parameter ceiling. A
 * feed page carries at most `perPage` distinct ASNs so it is one round trip; the
 * traffic breakdown can exceed that, hence the loop.
 */
export async function loadAsnAnnotations(
  db: Db,
  asns: readonly number[],
): Promise<Map<number, AsnAnnotation>> {
  const unique = [...new Set(asns.filter((a): a is number => typeof a === 'number'))];
  const out = new Map<number, AsnAnnotation>();
  if (unique.length === 0) return out;

  for (const batch of chunk(unique, READ_ASNS_PER_QUERY)) {
    const rows = await db.select().from(asnRegistry).where(inArray(asnRegistry.asn, batch));
    for (const row of rows) {
      out.set(row.asn, {
        asn: row.asn,
        info_type: row.infoType,
        as_name: row.asName,
        network_class: networkClassOf(row.infoType),
        source: row.source,
        fetched_at: row.fetchedAt,
      });
    }
  }
  return out;
}

/**
 * Two refresh intervals. One missed Monday is a blip the next run repairs; two
 * consecutive misses mean the feed, the cron, or the parse is broken and the
 * annotations on screen are being served from a registry nobody is maintaining.
 */
export const STALE_AFTER_HOURS = 24 * 14;

/**
 * The §5.6 status row: how fresh the registry is, how large, and how much of the
 * traffic it can actually speak to.
 *
 * Coverage is the number that matters and the one nothing else would surface. The
 * table can be perfectly fresh and still annotate almost nothing, because
 * freshness measures the last write while coverage measures the intersection with
 * a `page_views` that keeps meeting new networks. It is deliberately `null` rather
 * than `0` when there are no ASNs to cover: 0/0 is "not applicable", and rounding
 * it to zero would show a brand-new environment a gauge that reads broken.
 */
export async function asnRegistryFreshness(
  db: Db,
  now: Date,
): Promise<{
  entries: number;
  fetched_at: string | null;
  age_hours: number | null;
  stale: boolean;
  coverage: number | null;
}> {
  const [registry] = await db
    .select({
      entries: sql<number>`count(*)`,
      fetchedAt: sql<string | null>`max(${asnRegistry.fetchedAt})`,
    })
    .from(asnRegistry);

  // One pass over the ASNs `page_views` has seen, left-joined to the registry, so
  // "how many networks" and "how many of them are known" come back together and
  // cannot describe two different populations.
  const [reach] = await db
    .select({
      seen: sql<number>`count(distinct ${pageViews.cfAsn})`,
      covered: sql<number>`count(distinct case when ${asnRegistry.asn} is not null then ${pageViews.cfAsn} end)`,
    })
    .from(pageViews)
    .leftJoin(asnRegistry, eq(asnRegistry.asn, pageViews.cfAsn))
    .where(isNotNull(pageViews.cfAsn));

  const fetchedAt = registry?.fetchedAt ?? null;
  const ageHours = fetchedAt ? (now.getTime() - Date.parse(fetchedAt)) / 3_600_000 : null;
  const seen = Number(reach?.seen ?? 0);

  return {
    entries: Number(registry?.entries ?? 0),
    fetched_at: fetchedAt,
    age_hours: ageHours,
    // Never-populated is NOT stale. A fresh environment has nothing to be stale
    // about, and flagging it would make the one state an operator can ignore look
    // like the one they cannot.
    stale: ageHours !== null && ageHours > STALE_AFTER_HOURS,
    coverage: seen === 0 ? null : Number(reach?.covered ?? 0) / seen,
  };
}
