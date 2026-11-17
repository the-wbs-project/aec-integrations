/**
 * The nightly acceptance chain export (AECI-1680, ADR 0057). It writes R2 before it
 * writes D1, writes a file every night, never overwrites an object (the bucket lock
 * refuses it), and a failed DigiCert timestamp never fails the run.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptanceChainExports,
  acceptanceChainRows,
  agreementAcceptances,
  billingAccounts,
  licenseGrants,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { makeFakeR2Bucket, type FakeR2Bucket } from '../test/fake-r2';
import {
  chainKey,
  parseChainFile,
  rowFingerprint,
  serializeChainFile,
  tsrKey,
  verifyAcceptanceChain,
  type ChainFile,
} from './acceptance-chain';
import { runAcceptanceChainExport, TSA_BACKFILL_LIMIT } from './acceptance-chain-export';
import { sha256HexBytes } from './hash';
import type { TimeStampVerifier } from './rfc3161';

const RESPONSE = new Uint8Array(
  readFileSync(join(__dirname, '../test/fixtures/rfc3161/digicert-response.tsr')),
);

const VENDOR = 'v-1';
const ACCOUNT = 'ba-1';
const NIGHT_1 = new Date('2026-11-17T18:00:00.000Z');
const NIGHT_2 = new Date('2026-11-18T18:00:00.000Z');

let t: TestDb;
let bucket: FakeR2Bucket;
beforeEach(async () => {
  t = await makeTestDb();
  bucket = makeFakeR2Bucket();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR, name: 'Acme' });
  await t.db.insert(agreementAcceptances).values({
    id: 'acc-1',
    document: 'vendor_terms',
    version: '1.0',
    source: 'claim',
    email: 'signer@example.com',
    vendorId: VENDOR,
    acceptedAt: '2026-11-01T10:00:00.000Z',
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    checkboxDefaultUnticked: true,
    createdAt: '2026-11-01T10:00:00.000Z',
  });
  await t.db.insert(licenseGrants).values({
    id: 'grant-1',
    billingAccountId: ACCOUNT,
    vendorId: VENDOR,
    kind: 'grant',
    source: 'complimentary',
    quantity: 1,
    endsAt: '2027-11-01T00:00:00.000Z',
    termsVersion: '1.0',
    status: 'pending_acceptance',
  });
});
afterEach(() => t.dispose());

/** A DigiCert that cannot be reached. */
const failingFetch = () => vi.fn<typeof fetch>().mockRejectedValue(new Error('network down'));

/**
 * A DigiCert that answers every request with the recorded real reply. The reply names
 * one fixed digest, so on its own it is rejected for any file this spec writes.
 */
const realReplyFetch = () =>
  vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(RESPONSE as BodyInit, { status: 200 }));

/**
 * The export's spec-only verifier seam (`verifyTimestamp`): grants any reply, so the
 * flow specs can store a token for a digest the recorded reply does not name. The
 * cryptographic checks have their own spec in `rfc3161.spec.ts`. The forged-token specs
 * below leave the seam unset, so they run the production verifier.
 */
const grantAll: TimeStampVerifier = async () => ({
  pkiStatus: 0,
  status: 'granted',
  hasToken: true,
  verified: true,
});

/** DER TLV with long-form lengths. */
const der = (tag: number, ...content: (number[] | Uint8Array)[]): number[] => {
  const body = content.flatMap((c) => Array.from(c));
  const len = body.length;
  const head = len < 0x80 ? [len] : len < 0x100 ? [0x81, len] : [0x82, len >> 8, len & 0xff];
  return [tag, ...head, ...body];
};
const oid = (h: string) =>
  der(
    0x06,
    h.match(/../g)!.map((x) => parseInt(x, 16)),
  );

/**
 * The attack the Worker check exists for: a reply on the plain-HTTP path that names our
 * digest and nonce in a well-formed TSTInfo with a current genTime, whose signed
 * attributes match it, but whose signature no DigiCert key made.
 */
const forgedFetch = () =>
  vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const req = new Uint8Array(init!.body as Uint8Array);
    // The digest follows the OCTET STRING header (0x04 0x20); the nonce INTEGER follows it.
    const at = req.findIndex((b, i) => b === 0x04 && req[i + 1] === 0x20) + 2;
    const digest = req.slice(at, at + 32);
    const nonce = req.slice(at + 34, at + 34 + req[at + 33]!);
    const genTime = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
    const tstInfo = der(
      0x30,
      der(0x02, [1]),
      oid('2b0601040101'),
      der(0x30, der(0x30, oid('608648016503040201'), [0x05, 0x00]), der(0x04, digest)),
      der(0x02, [7]),
      der(0x18, new TextEncoder().encode(genTime)),
      der(0x02, nonce),
    );
    const md = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(tstInfo)));
    const signerInfo = der(
      0x30,
      der(0x02, [1]),
      der(0x30, der(0x30), der(0x02, [1])),
      der(0x30, oid('608648016503040201')),
      der(
        0xa0,
        der(0x30, oid('2a864886f70d010903'), der(0x31, oid('2a864886f70d0109100104'))),
        der(0x30, oid('2a864886f70d010904'), der(0x31, der(0x04, md))),
      ),
      der(0x30, oid('2a864886f70d010101'), [0x05, 0x00]),
      der(0x04, new Uint8Array(256).fill(0x5a)),
    );
    const token = der(
      0x30,
      oid('2a864886f70d010702'),
      der(
        0xa0,
        der(
          0x30,
          der(0x02, [3]),
          der(0x31, der(0x30, oid('608648016503040201'))),
          der(0x30, oid('2a864886f70d0109100104'), der(0xa0, der(0x04, tstInfo))),
          der(0x31, signerInfo),
        ),
      ),
    );
    const body = new Uint8Array(der(0x30, der(0x30, der(0x02, [0])), token));
    return new Response(body as BodyInit, { status: 200 });
  });

const exportsRows = () =>
  t.db.select().from(acceptanceChainExports).orderBy(acceptanceChainExports.seq);
const fileAt = async (seq: number): Promise<ChainFile> =>
  parseChainFile(new Uint8Array(await (await bucket.get(chainKey(seq)))!.arrayBuffer()));
/** One export. The default DigiCert grants through the spec seam. Pass `verify: null`
 *  to run the production verifier. */
const run = (
  now: Date,
  fetchImpl: typeof fetch = realReplyFetch(),
  verify: TimeStampVerifier | null = grantAll,
) =>
  runAcceptanceChainExport(t.db, bucket, {
    now,
    fetchImpl,
    ...(verify ? { verifyTimestamp: verify } : {}),
  });

describe('runAcceptanceChainExport', () => {
  it('the first run writes seq 1 with no previous hash, then records it', async () => {
    const result = await run(NIGHT_1);
    expect(result).toMatchObject({
      seq: 1,
      entries: 2,
      rows: 2,
      adopted: false,
      tsa: 'granted',
      backfilled: 0,
      tsaFailures: [],
    });
    expect(bucket.keys()).toEqual([chainKey(1), tsrKey(1)]);
    const file = await fileAt(1);
    expect(file).toMatchObject({ seq: 1, prev_sha256: null, day: '2026-11-17' });
    expect(file.entries.map((e) => [e.table, e.id, e.op])).toEqual([
      ['agreement_acceptances', 'acc-1', 'upsert'],
      ['license_grants', 'grant-1', 'upsert'],
    ]);

    const [ledger] = await exportsRows();
    const bytes = new Uint8Array(await (await bucket.get(chainKey(1)))!.arrayBuffer());
    expect(ledger).toMatchObject({
      seq: 1,
      objectKey: chainKey(1),
      sha256: await sha256HexBytes(bytes),
      prevSha256: null,
      entries: 2,
      tsaStatus: 'granted',
      tsaKey: tsrKey(1),
    });
    expect(await t.db.select().from(acceptanceChainRows)).toHaveLength(2);
  });

  it('never puts an ip, a browser or an email into R2', async () => {
    await run(NIGHT_1);
    const text = new TextDecoder().decode(
      new Uint8Array(await (await bucket.get(chainKey(1)))!.arrayBuffer()),
    );
    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('Mozilla');
    expect(text).not.toContain('signer@example.com');
    // The fingerprint is of the row WITHOUT them: the same with them blanked.
    const [row] = await t.db.all<Record<string, unknown>>('SELECT * FROM agreement_acceptances');
    const file = await fileAt(1);
    expect(file.entries[0]!.fingerprint).toBe(
      await rowFingerprint('agreement_acceptances', { ...row, ip: null, user_agent: null }),
    );
  });

  it('a quiet night still writes a file, chained to the last one', async () => {
    await run(NIGHT_1);
    const result = await run(NIGHT_2);
    expect(result).toMatchObject({ seq: 2, entries: 0 });
    const [first, second] = await exportsRows();
    const file = await fileAt(2);
    expect(file.prev_sha256).toBe(first!.sha256);
    expect(file.entries).toEqual([]);
    expect(file.state_sha256).toBe((await fileAt(1)).state_sha256);
    expect(second!.prevSha256).toBe(first!.sha256);
  });

  it('exports a changed row and a tombstone for a deleted one, and verify agrees', async () => {
    await run(NIGHT_1);
    await t.db
      .update(licenseGrants)
      .set({ status: 'accepted' })
      .where(eq(licenseGrants.id, 'grant-1'));
    await t.db.delete(agreementAcceptances).where(eq(agreementAcceptances.id, 'acc-1'));
    await run(NIGHT_2);
    expect((await fileAt(2)).entries.map((e) => [e.id, e.op])).toEqual([
      ['acc-1', 'delete'],
      ['grant-1', 'upsert'],
    ]);
    const [tomb] = await t.db
      .select()
      .from(acceptanceChainRows)
      .where(eq(acceptanceChainRows.rowId, 'acc-1'));
    expect(tomb).toMatchObject({ deleted: true, seq: 2 });

    const files = await Promise.all(
      [1, 2].map(async (seq) => ({
        key: chainKey(seq),
        bytes: new Uint8Array(await (await bucket.get(chainKey(seq)))!.arrayBuffer()),
      })),
    );
    const d1Rows = {
      agreement_acceptances: await t.db.all<Record<string, unknown>>(
        'SELECT * FROM agreement_acceptances',
      ),
      license_grants: await t.db.all<Record<string, unknown>>('SELECT * FROM license_grants'),
    };
    const verified = await verifyAcceptanceChain({
      lockRules: null,
      files,
      d1Rows,
      pruneAuditIds: new Set(['agreement_acceptances:acc-1']),
    });
    expect(verified).toMatchObject({ ok: true, filesVerified: 2 });

    // Then an edit in D1 with no export after it.
    await t.db.update(licenseGrants).set({ quantity: 9 }).where(eq(licenseGrants.id, 'grant-1'));
    const changed = await verifyAcceptanceChain({
      lockRules: null,
      files,
      d1Rows: {
        ...d1Rows,
        license_grants: await t.db.all<Record<string, unknown>>('SELECT * FROM license_grants'),
      },
      pruneAuditIds: new Set(['agreement_acceptances:acc-1']),
    });
    expect(changed.findings.map((f) => f.code)).toContain('CHANGED');
  });

  it('adopts a file an earlier attempt left in R2, and writes nothing over it', async () => {
    // An earlier attempt wrote seq 1, then its D1 batch failed.
    const earlier: ChainFile = {
      schema: 'aeci.acceptance-chain/1',
      seq: 1,
      day: '2026-11-17',
      created_at: '2026-11-17T18:00:01.000Z',
      prev_sha256: null,
      fingerprint_version: 1,
      entries: [],
      state_sha256: 'f'.repeat(64),
    };
    const bytes = serializeChainFile(earlier);
    await bucket.put(chainKey(1), bytes.buffer as ArrayBuffer, {});

    const result = await run(NIGHT_1);
    expect(result).toMatchObject({ seq: 1, adopted: true, entries: 0 });
    expect(bucket.puts.filter((k) => k === chainKey(1))).toHaveLength(1);
    const [ledger] = await exportsRows();
    expect(ledger).toMatchObject({ seq: 1, sha256: await sha256HexBytes(bytes), entries: 0 });
    // Its rows are not in the ledger, so the next night exports them.
    expect(await run(NIGHT_2)).toMatchObject({ seq: 2, entries: 2 });
  });

  it('refuses to adopt an object that does not continue the chain', async () => {
    await run(NIGHT_1);
    const foreign = serializeChainFile({
      ...(await fileAt(1)),
      seq: 2,
      prev_sha256: 'f'.repeat(64),
    });
    await bucket.put(chainKey(2), foreign.buffer as ArrayBuffer, {});
    await expect(run(NIGHT_2)).rejects.toThrow(/adopt_conflict/);
    expect(await exportsRows()).toHaveLength(1);
  });

  it('a failed R2 write records nothing in D1, so the retry starts clean', async () => {
    bucket.failPut(/\.json$/);
    await expect(run(NIGHT_1)).rejects.toThrow(/put failed/);
    expect(await exportsRows()).toHaveLength(0);
    expect(await t.db.select().from(acceptanceChainRows)).toHaveLength(0);
  });

  it('a timestamp failure still succeeds, and sets tsa_status failed', async () => {
    const fetchImpl = failingFetch();
    const result = await run(NIGHT_1, fetchImpl);
    expect(result).toMatchObject({
      seq: 1,
      tsa: 'failed',
      tsaFailures: [{ seq: 1, reason: 'fetch: network down' }],
    });
    expect(bucket.keys()).toEqual([chainKey(1)]);
    expect((await exportsRows())[0]).toMatchObject({ tsaStatus: 'failed', tsaKey: null });
  });

  it('a rejected DigiCert reply is a failure too: the recorded token names another hash', async () => {
    const result = await run(NIGHT_1, realReplyFetch(), null);
    expect(result.tsa).toBe('failed');
    expect(result.tsaFailures[0]!.reason).toMatch(/reason=digest_mismatch/);
    expect(bucket.puts).not.toContain(tsrKey(1));
  });

  it('a forged token is never written under the lock, and the next run retries it', async () => {
    const result = await run(NIGHT_1, forgedFetch(), null);
    expect(result).toMatchObject({
      seq: 1,
      tsa: 'failed',
      tsaFailures: [{ seq: 1, reason: 'rejected pki_status=0 reason=signer_cert_missing' }],
    });
    // Not stored, not even attempted: the lock would make a stored token permanent.
    expect(bucket.puts).not.toContain(tsrKey(1));
    expect(bucket.keys()).toEqual([chainKey(1)]);
    expect((await exportsRows())[0]).toMatchObject({ tsaStatus: 'failed', tsaKey: null });

    // The next night's backfill asks again and stores the granted token.
    const next = await run(NIGHT_2);
    expect(next).toMatchObject({ seq: 2, tsa: 'granted', backfilled: 1, tsaFailures: [] });
    expect(bucket.keys()).toContain(tsrKey(1));
    expect((await exportsRows()).map((r) => r.tsaStatus)).toEqual(['granted', 'granted']);
  });

  it('the next run backfills the missing tokens, newest first, up to the limit', async () => {
    await run(NIGHT_1, failingFetch());
    await run(NIGHT_2, failingFetch());
    const result = await run(new Date('2026-11-19T18:00:00.000Z'));
    expect(result).toMatchObject({ seq: 3, tsa: 'granted', backfilled: 2, tsaFailures: [] });
    expect((await exportsRows()).map((r) => r.tsaStatus)).toEqual([
      'granted',
      'granted',
      'granted',
    ]);
    expect(bucket.keys()).toContain(tsrKey(1));
    expect(TSA_BACKFILL_LIMIT).toBe(7);
  });

  it('two runs racing for one seq: the ledger primary key refuses the second', async () => {
    const results = await Promise.allSettled([run(NIGHT_1), run(NIGHT_1)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/UNIQUE|PRIMARY/);
    expect(await exportsRows()).toHaveLength(1);
  });
});
