/**
 * The acceptance chain's pure core (AECI-1680, ADR 0057): fingerprints, the column
 * manifest, the diff, and the verify that `ops:verify-acceptance-chain` runs.
 */

import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { agreementAcceptances, licenseGrants } from '../db/schema';
import {
  ACCEPTANCE_CHAIN_SCHEMA,
  applyEntries,
  CHAIN_TABLES,
  chainKey,
  COLUMN_MANIFEST,
  diffRows,
  fingerprintRows,
  FINGERPRINT_VERSION,
  hashedColumns,
  parseLockRules,
  pruneAuditIds,
  publicColumns,
  rowFingerprint,
  serializeChainFile,
  stateSha256,
  verifyAcceptanceChain,
  type ChainFile,
  type ChainTable,
  type LockRule,
  type PriorRow,
  type RawRow,
} from './acceptance-chain';
import { sha256HexBytes } from './hash';

const ACCEPTANCE: RawRow = {
  id: 'acc-1',
  document: 'vendor_terms',
  version: '1.0',
  source: 'claim',
  email: 'signer@example.com',
  profile_id: null,
  vendor_id: 'v-1',
  billing_account_id: null,
  vendor_request_id: 'vr-1',
  listing_request_id: null,
  stripe_checkout_session_id: null,
  accepted_at: '2026-11-01T10:00:00.000Z',
  ip: '203.0.113.7',
  user_agent: 'Mozilla/5.0',
  signer_name: 'Sam Signer',
  signer_title: 'CEO',
  company_legal_name: 'Acme Inc.',
  license_grant_id: null,
  grant_ends_at: null,
  method: null,
  text_sha256: 'a'.repeat(64),
  seat_role: null,
  deal_reference: null,
  deal_signed_at: null,
  checkbox_label_sha256: 'b'.repeat(64),
  checkbox_default_unticked: 1,
  checkbox_label: 'I agree',
  listing_accuracy_version: '1.0',
  review_guidelines_version: '1.0',
  plans_page_version: null,
  plans_page_sha256: null,
  evidence_removed_at: null,
  created_at: '2026-11-01T10:00:00.000Z',
};

const GRANT: RawRow = {
  id: 'grant-1',
  billing_account_id: 'ba-1',
  vendor_id: 'v-1',
  kind: 'grant',
  source: 'complimentary',
  quantity: 1,
  starts_at: null,
  ends_at: '2027-11-01T00:00:00.000Z',
  reference: null,
  notes: 'pilot',
  items_json: '[]',
  terms_version: '1.0',
  status: 'accepted',
  granted_by: 'admin-1',
  acceptance_id: 'acc-1',
  decided_at: '2026-11-01T10:00:00.000Z',
  decided_by: null,
  withdraw_reason: null,
  created_at: '2026-11-01T09:00:00.000Z',
  updated_at: '2026-11-01T10:00:00.000Z',
};

const DRIZZLE_TABLES = {
  agreement_acceptances: agreementAcceptances,
  license_grants: licenseGrants,
} as const;

describe('rowFingerprint', () => {
  it('ignores ip and user_agent: changing either leaves the fingerprint unchanged', async () => {
    const base = await rowFingerprint('agreement_acceptances', ACCEPTANCE);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await rowFingerprint('agreement_acceptances', { ...ACCEPTANCE, ip: '198.51.100.1' }),
    ).toBe(base);
    expect(
      await rowFingerprint('agreement_acceptances', { ...ACCEPTANCE, user_agent: 'curl/8' }),
    ).toBe(base);
    // The 90-day sweep's NULLs alone do not change it either.
    expect(
      await rowFingerprint('agreement_acceptances', { ...ACCEPTANCE, ip: null, user_agent: null }),
    ).toBe(base);
  });

  it('changing email, a signer field or evidence_removed_at changes it', async () => {
    const base = await rowFingerprint('agreement_acceptances', ACCEPTANCE);
    for (const edit of [
      { email: 'other@example.com' },
      { signer_name: 'Someone Else' },
      { evidence_removed_at: '2027-02-01T17:00:00.000Z' },
      { profile_id: 'p-1' },
    ]) {
      expect(await rowFingerprint('agreement_acceptances', { ...ACCEPTANCE, ...edit })).not.toBe(
        base,
      );
    }
  });

  it('a Drizzle boolean and a SQLite integer fingerprint alike', async () => {
    expect(
      await rowFingerprint('agreement_acceptances', {
        ...ACCEPTANCE,
        checkbox_default_unticked: true,
      }),
    ).toBe(await rowFingerprint('agreement_acceptances', ACCEPTANCE));
  });

  it('a grant status change changes the grant fingerprint', async () => {
    expect(await rowFingerprint('license_grants', { ...GRANT, status: 'withdrawn' })).not.toBe(
      await rowFingerprint('license_grants', GRANT),
    );
  });
});

describe('COLUMN_MANIFEST', () => {
  it.each(CHAIN_TABLES)('classifies every column of %s, and names no column it lacks', (table) => {
    const sqlNames = Object.values(getTableColumns(DRIZZLE_TABLES[table]))
      .map((c) => c.name)
      .sort();
    expect(Object.keys(COLUMN_MANIFEST[table]).sort()).toEqual(sqlNames);
  });

  it('excludes exactly ip and user_agent, and only from agreement_acceptances', () => {
    const excluded = (t: ChainTable) =>
      Object.entries(COLUMN_MANIFEST[t])
        .filter(([, c]) => c === 'excluded')
        .map(([n]) => n);
    expect(excluded('agreement_acceptances').sort()).toEqual(['ip', 'user_agent']);
    expect(excluded('license_grants')).toEqual([]);
    expect(hashedColumns('agreement_acceptances')).not.toContain('ip');
    expect(hashedColumns('agreement_acceptances')).not.toContain('user_agent');
  });

  it('puts no personal field in the public class', () => {
    for (const table of CHAIN_TABLES) {
      for (const personal of ['email', 'signer_name', 'signer_title', 'ip', 'user_agent']) {
        expect(publicColumns(table)).not.toContain(personal);
      }
    }
  });
});

describe('diffRows', () => {
  it('emits new, changed and tombstone entries, and skips an unchanged row', async () => {
    const live = [
      ...(await fingerprintRows('agreement_acceptances', [
        ACCEPTANCE,
        { ...ACCEPTANCE, id: 'acc-2' },
      ])),
      ...(await fingerprintRows('license_grants', [GRANT])),
    ];
    const prior: PriorRow[] = [
      // Unchanged.
      {
        table: 'agreement_acceptances',
        id: 'acc-1',
        fingerprint: live[0]!.fingerprint,
        deleted: false,
      },
      // Changed.
      { table: 'license_grants', id: 'grant-1', fingerprint: 'f'.repeat(64), deleted: false },
      // Gone from D1.
      {
        table: 'agreement_acceptances',
        id: 'acc-gone',
        fingerprint: 'e'.repeat(64),
        deleted: false,
      },
      // Already tombstoned: no second tombstone.
      { table: 'agreement_acceptances', id: 'acc-old', fingerprint: 'd'.repeat(64), deleted: true },
    ];
    const entries = diffRows(live, prior);
    expect(entries.map((e) => [e.table, e.id, e.op])).toEqual([
      ['agreement_acceptances', 'acc-2', 'upsert'],
      ['agreement_acceptances', 'acc-gone', 'delete'],
      ['license_grants', 'grant-1', 'upsert'],
    ]);
    expect(entries[1]).toEqual({
      table: 'agreement_acceptances',
      id: 'acc-gone',
      op: 'delete',
      fingerprint: 'e'.repeat(64),
    });
    // The entry carries the public fields, and never a personal one.
    expect(entries[0]!.fields).toMatchObject({ document: 'vendor_terms', vendor_id: 'v-1' });
    expect(entries[0]!.fields).not.toHaveProperty('email');
    expect(entries[0]!.fields).not.toHaveProperty('ip');
  });
});

// ─── Verify ──────────────────────────────────────────────────────────────────

const INDEFINITE_LOCK: LockRule[] = [
  {
    name: 'acceptance-chain',
    enabled: true,
    prefix: 'evidence/acceptance-chain/',
    condition: 'indefinitely',
  },
];

/** Build a chain of files the way the export does, from successive D1 states. */
async function buildChain(states: Record<ChainTable, RawRow[]>[]) {
  const files: { key: string; bytes: Uint8Array }[] = [];
  const ledger = new Map<string, PriorRow>();
  let prev: string | null = null;
  for (const [i, rows] of states.entries()) {
    const live = [
      ...(await fingerprintRows('agreement_acceptances', rows.agreement_acceptances)),
      ...(await fingerprintRows('license_grants', rows.license_grants)),
    ];
    const file: ChainFile = {
      schema: ACCEPTANCE_CHAIN_SCHEMA,
      seq: i + 1,
      day: `2026-11-${String(10 + i).padStart(2, '0')}`,
      created_at: `2026-11-${String(10 + i).padStart(2, '0')}T18:00:00.000Z`,
      prev_sha256: prev,
      fingerprint_version: FINGERPRINT_VERSION,
      entries: diffRows(live, [...ledger.values()]),
      state_sha256: await stateSha256(live),
    };
    applyEntries(ledger, file.entries);
    const bytes = serializeChainFile(file);
    prev = await sha256HexBytes(bytes);
    files.push({ key: chainKey(file.seq), bytes });
  }
  return files;
}

const both = (a: RawRow[], g: RawRow[] = [GRANT]) => ({
  agreement_acceptances: a,
  license_grants: g,
});

const codes = (r: { findings: { code: string; level: string }[] }) =>
  r.findings.filter((f) => f.level !== 'info').map((f) => f.code);

describe('verifyAcceptanceChain', () => {
  it('passes a clean chain that matches D1', async () => {
    const files = await buildChain([both([ACCEPTANCE]), both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([ACCEPTANCE]),
      pruneAuditIds: new Set(),
    });
    expect(result).toMatchObject({ ok: true, filesVerified: 2, brokenAt: null });
    expect(codes(result)).toEqual([]);
  });

  it('reports CHANGED for a D1 row edited after the export', async () => {
    const files = await buildChain([both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([{ ...ACCEPTANCE, email: 'forged@example.com' }]),
      pruneAuditIds: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['CHANGED']);
    expect(result.findings.find((f) => f.code === 'CHANGED')!.detail).toContain(
      'agreement_acceptances:acc-1',
    );
  });

  it('does not report CHANGED when only ip or user_agent differ', async () => {
    const files = await buildChain([both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([{ ...ACCEPTANCE, ip: null, user_agent: null }]),
      pruneAuditIds: new Set(),
    });
    expect(result.ok).toBe(true);
  });

  it('reports the first broken link when a byte of an old file changes', async () => {
    const files = await buildChain([
      both([ACCEPTANCE]),
      both([ACCEPTANCE, { ...ACCEPTANCE, id: 'acc-2' }]),
      both([ACCEPTANCE, { ...ACCEPTANCE, id: 'acc-2' }]),
    ]);
    // Flip one byte inside file 2's JSON (a hex digit of a fingerprint).
    const tampered = new Uint8Array(files[1]!.bytes);
    const at = new TextDecoder().decode(tampered).indexOf('"fingerprint":"') + 15;
    tampered[at] = tampered[at] === 0x30 ? 0x31 : 0x30;
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files: [files[0]!, { ...files[1]!, bytes: tampered }, files[2]!],
      d1Rows: both([ACCEPTANCE, { ...ACCEPTANCE, id: 'acc-2' }]),
      pruneAuditIds: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(2);
    expect(result.filesVerified).toBe(1);
    expect(result.findings.filter((f) => f.code === 'CHAIN BROKEN')).toHaveLength(1);
    expect(result.chain).toBe('CHAIN BROKEN');
    expect(result.lock).toBe('LOCKED');
  });

  it('reports a broken link when a later file does not name the previous file', async () => {
    const files = await buildChain([both([ACCEPTANCE]), both([ACCEPTANCE])]);
    const other = await buildChain([both([{ ...ACCEPTANCE, id: 'x' }]), both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files: [files[0]!, other[1]!],
      d1Rows: both([ACCEPTANCE]),
      pruneAuditIds: new Set(),
    });
    expect(result.brokenAt).toBe(2);
    expect(result.findings.find((f) => f.code === 'CHAIN BROKEN')!.detail).toContain('prev_sha256');
  });

  it('a missing interior file breaks the chain at that seq, never a false PASS', async () => {
    const files = await buildChain([both([ACCEPTANCE]), both([ACCEPTANCE]), both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files: [files[0]!, { key: files[1]!.key, bytes: null }, files[2]!],
      d1Rows: both([ACCEPTANCE]),
      pruneAuditIds: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(result.chain).toBe('CHAIN BROKEN');
    expect(result.brokenAt).toBe(2);
    expect(result.filesVerified).toBe(1);
    expect(result.findings.find((f) => f.code === 'CHAIN BROKEN')!.detail).toContain(
      'missing from R2',
    );
  });

  it('a malformed entry or non-object file is CHAIN BROKEN at that seq, not a crash', async () => {
    const [good] = await buildChain([both([ACCEPTANCE])]);
    const file = JSON.parse(new TextDecoder().decode(good!.bytes)) as Record<string, unknown>;
    const bad = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
    for (const bytes of [
      bad({ ...file, entries: [null] }),
      bad({
        ...file,
        entries: [{ table: 'licenses', id: 'x', op: 'upsert', fingerprint: 'a'.repeat(64) }],
      }),
      bad({
        ...file,
        entries: [{ table: 'license_grants', id: 'x', op: 'edit', fingerprint: 'a'.repeat(64) }],
      }),
      bad({
        ...file,
        entries: [{ table: 'license_grants', id: 'x', op: 'upsert', fingerprint: 7 }],
      }),
      bad({ ...file, prev_sha256: 42 }),
      bad(null),
      bad([1, 2]),
      new TextEncoder().encode('{not json'),
    ]) {
      const result = await verifyAcceptanceChain({
        lockRules: INDEFINITE_LOCK,
        files: [{ key: good!.key, bytes }],
        d1Rows: both([ACCEPTANCE]),
        pruneAuditIds: new Set(),
      });
      expect(result.ok).toBe(false);
      expect(result.chain).toBe('CHAIN BROKEN');
      expect(result.brokenAt).toBe(1);
    }
  });

  it('reports CHAIN STALE on a deployed tier when the newest file is too old', async () => {
    const files = await buildChain([both([ACCEPTANCE])]); // created 2026-11-10T18:00Z
    const run = (now: Date) =>
      verifyAcceptanceChain({
        lockRules: INDEFINITE_LOCK,
        files,
        d1Rows: both([ACCEPTANCE]),
        pruneAuditIds: new Set(),
        now,
      });
    const fresh = await run(new Date('2026-11-11T19:00:00Z'));
    expect(fresh.ok).toBe(true);
    expect(fresh.chain).toBe('CHAIN INTACT');
    const stale = await run(new Date('2026-11-13T00:00:00Z'));
    expect(stale.ok).toBe(false);
    expect(stale.chain).toBe('CHAIN STALE');
    expect(codes(stale)).toEqual(['CHAIN STALE']);
  });

  it('reports LOCK MISSING when no enabled rule covers the prefix', async () => {
    const files = await buildChain([both([ACCEPTANCE])]);
    for (const lockRules of [
      [],
      [{ name: 'logos', enabled: true, prefix: 'logos/', condition: 'indefinitely' }],
      [{ ...INDEFINITE_LOCK[0]!, enabled: false }],
    ]) {
      const result = await verifyAcceptanceChain({
        lockRules,
        files,
        d1Rows: both([ACCEPTANCE]),
        pruneAuditIds: new Set(),
      });
      expect(result.ok).toBe(false);
      expect(codes(result)).toEqual(['LOCK MISSING']);
      expect(result.lock).toBe('LOCK MISSING');
      expect(result.chain).toBe('CHAIN INTACT');
    }
  });

  it('fails LOCK NOT INDEFINITE when only the evidence/ 4-year rule covers the prefix', async () => {
    const files = await buildChain([both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: [
        { name: 'evidence', enabled: true, prefix: 'evidence/', condition: 'after 1461 days' },
      ],
      files,
      d1Rows: both([ACCEPTANCE]),
      pruneAuditIds: new Set(),
    });
    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual(['LOCK NOT INDEFINITE']);
    expect(result.lock).toBe('LOCK NOT INDEFINITE');
    expect(result.chain).toBe('CHAIN INTACT');
    expect(result.rows).toBe('ROWS MATCH');
  });

  it('flags a tombstone with no prune audit row, and accepts one with it', async () => {
    const files = await buildChain([
      both([ACCEPTANCE, { ...ACCEPTANCE, id: 'acc-2' }]),
      both([ACCEPTANCE]),
    ]);
    const input = {
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([ACCEPTANCE]),
    };
    const flagged = await verifyAcceptanceChain({ ...input, pruneAuditIds: new Set() });
    expect(codes(flagged)).toEqual(['TOMBSTONE WITHOUT PRUNE AUDIT']);
    const accepted = await verifyAcceptanceChain({
      ...input,
      pruneAuditIds: pruneAuditIds([
        JSON.stringify({
          rowsDeleted: 1,
          tables: [{ table: 'agreement_acceptances', cutoff: 'x', rowsDeleted: 1, ids: ['acc-2'] }],
        }),
      ]),
    });
    expect(accepted.ok).toBe(true);
  });

  it('reports ABSENT for a chain row missing from D1 with no tombstone', async () => {
    const files = await buildChain([both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([]),
      pruneAuditIds: new Set(),
    });
    expect(codes(result)).toEqual(['ABSENT']);
  });

  it('flags UNEXPORTED only for a row older than the last export', async () => {
    const files = await buildChain([both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([
        ACCEPTANCE,
        { ...ACCEPTANCE, id: 'old', created_at: '2026-11-01T00:00:00.000Z' },
        { ...ACCEPTANCE, id: 'new', created_at: '2026-11-30T00:00:00.000Z' },
      ]),
      pruneAuditIds: new Set(),
    });
    const unexported = result.findings.filter((f) => f.code === 'UNEXPORTED');
    expect(unexported.map((f) => f.level)).toEqual(['fail', 'info']);
  });

  it('reports NO FILES for an empty chain, and timestamp gaps as warnings', async () => {
    expect(
      codes(
        await verifyAcceptanceChain({
          lockRules: INDEFINITE_LOCK,
          files: [],
          d1Rows: both([], []),
          pruneAuditIds: new Set(),
        }),
      ),
    ).toEqual(['NO FILES']);
    const files = await buildChain([both([ACCEPTANCE]), both([ACCEPTANCE])]);
    const result = await verifyAcceptanceChain({
      lockRules: INDEFINITE_LOCK,
      files,
      d1Rows: both([ACCEPTANCE]),
      pruneAuditIds: new Set(),
      timestamps: new Map([
        [1, 'missing'],
        [2, 'invalid'],
      ]),
    });
    expect(result.ok).toBe(true);
    expect(codes(result)).toEqual(['TIMESTAMP MISSING', 'TIMESTAMP INVALID']);
  });
});

describe('parseLockRules', () => {
  it('reads wrangler lock list output, ANSI colours and all', () => {
    const out = [
      "Listing lock rules for bucket 'aeci-uploads-production'...",
      '\u001b[37mname:\u001b[39m       \u001b[90mevidence\u001b[39m',
      'enabled:    Yes',
      'prefix:     evidence/',
      'condition:  after 1461 days',
      '',
      'name:       acceptance-chain',
      'enabled:    Yes',
      'prefix:     evidence/acceptance-chain/',
      'condition:  indefinitely',
    ].join('\n');
    expect(parseLockRules(out)).toEqual([
      { name: 'evidence', enabled: true, prefix: 'evidence/', condition: 'after 1461 days' },
      {
        name: 'acceptance-chain',
        enabled: true,
        prefix: 'evidence/acceptance-chain/',
        condition: 'indefinitely',
      },
    ]);
  });

  it('reads "no lock rules" as none, and "(all prefixes)" as an empty prefix', () => {
    expect(parseLockRules("There are no lock rules for bucket 'b'.")).toEqual([]);
    expect(
      parseLockRules('name: all\nenabled: Yes\nprefix: (all prefixes)\ncondition: indefinitely'),
    ).toEqual([{ name: 'all', enabled: true, prefix: '', condition: 'indefinitely' }]);
  });
});
