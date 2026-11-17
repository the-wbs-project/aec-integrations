/**
 * The acceptance chain (AECI-1680, ADR 0057; `DATABASE_SCHEMA.md` §9.17).
 *
 * Counsel asked for a record of who accepted which agreement that an outsider can check
 * was not edited later (Q5(c), ruling 15). Each night the export job
 * (`lib/acceptance-chain-export.ts`) writes one JSON file to `UPLOADS` under
 * `evidence/acceptance-chain/`. The file lists the SHA-256 fingerprint of every
 * `agreement_acceptances` and `license_grants` row that is new or changed since the last
 * file, plus a tombstone for every row that disappeared. Each file names the SHA-256 of
 * the file before it, so changing an old file breaks every later link. A bucket lock
 * refuses an overwrite, and DigiCert timestamps each file's hash (`lib/rfc3161.ts`).
 *
 * ── FINGERPRINTS, NOT ROWS (Chris's ruling 1A, 2026-11-17) ─────────────────────
 * R2 holds hashes, ids and a few fields that are not personal. It is not a backup: it
 * shows that a row changed, but cannot restore it. `ip` and `user_agent` are left out of
 * the hash INPUT, not only the output: an IPv4 address can be recovered from its hash by
 * trying every address, and the Privacy Policy promises both are deleted after 90 days.
 * Every column is classified in {@link COLUMN_MANIFEST}, and a spec fails when a column
 * is in no class, so a new column cannot slip in unclassified.
 *
 * Everything here is pure: the export job and the verify CLI
 * (`scripts/verify-acceptance-chain.ts`) both call it, so they cannot disagree on how a
 * row is fingerprinted.
 */

import { canonicalJson } from '@aeci/shared/api/review-app-ownership';

import { sha256Hex, sha256HexBytes } from './hash';

/** The file format. Bump it, and keep reading the old one, if the shape changes. */
export const ACCEPTANCE_CHAIN_SCHEMA = 'aeci.acceptance-chain/1';

/** The fingerprint recipe. Bump it, and keep the old manifest, if a class changes. */
export const FINGERPRINT_VERSION = 1;

/** The R2 prefix under `UPLOADS`. The operator's bucket lock rule names it. */
export const ACCEPTANCE_CHAIN_PREFIX = 'evidence/acceptance-chain/';

export const CHAIN_TABLES = ['agreement_acceptances', 'license_grants'] as const;
export type ChainTable = (typeof CHAIN_TABLES)[number];

/**
 * - `hashed`: in the fingerprint input only.
 * - `public`: in the fingerprint input, and copied into the entry as a plain field. None
 *   of these is personal: ids, versions, dates, statuses and a text hash.
 * - `excluded`: in neither. Only `ip` and `user_agent`.
 */
export type ColumnClass = 'hashed' | 'public' | 'excluded';

/** Every column of both tables, by its SQL name. `acceptance-chain.spec.ts` compares
 *  this with `getTableColumns()` in both directions. */
export const COLUMN_MANIFEST: Readonly<Record<ChainTable, Readonly<Record<string, ColumnClass>>>> =
  {
    agreement_acceptances: {
      id: 'hashed',
      document: 'public',
      version: 'public',
      source: 'public',
      email: 'hashed',
      profile_id: 'hashed',
      vendor_id: 'public',
      billing_account_id: 'public',
      vendor_request_id: 'hashed',
      listing_request_id: 'hashed',
      stripe_checkout_session_id: 'hashed',
      accepted_at: 'public',
      ip: 'excluded',
      user_agent: 'excluded',
      signer_name: 'hashed',
      signer_title: 'hashed',
      company_legal_name: 'hashed',
      license_grant_id: 'public',
      grant_ends_at: 'hashed',
      method: 'hashed',
      text_sha256: 'public',
      seat_role: 'hashed',
      deal_reference: 'hashed',
      deal_signed_at: 'hashed',
      checkbox_label_sha256: 'hashed',
      checkbox_default_unticked: 'hashed',
      checkbox_label: 'hashed',
      listing_accuracy_version: 'hashed',
      review_guidelines_version: 'hashed',
      plans_page_version: 'hashed',
      plans_page_sha256: 'hashed',
      evidence_removed_at: 'hashed',
      created_at: 'hashed',
    },
    license_grants: {
      id: 'hashed',
      billing_account_id: 'public',
      vendor_id: 'public',
      kind: 'public',
      source: 'public',
      quantity: 'hashed',
      starts_at: 'public',
      ends_at: 'public',
      reference: 'hashed',
      notes: 'hashed',
      items_json: 'hashed',
      terms_version: 'public',
      status: 'public',
      granted_by: 'hashed',
      acceptance_id: 'hashed',
      decided_at: 'hashed',
      decided_by: 'hashed',
      withdraw_reason: 'hashed',
      created_at: 'hashed',
      updated_at: 'public',
    },
  };

/** Binary order: these are SQL names and ids, never text a human reads in order
 *  (`ANGULAR_STYLE_GUIDE.md` §20a keeps such orderings binary). */
function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function columnsOf(table: ChainTable, classes: readonly ColumnClass[]): string[] {
  return Object.entries(COLUMN_MANIFEST[table])
    .filter(([, c]) => classes.includes(c))
    .map(([name]) => name)
    .sort(compareBinary);
}

/** The columns in the fingerprint input: `hashed` and `public`. */
export const hashedColumns = (table: ChainTable): string[] =>
  columnsOf(table, ['hashed', 'public']);

/** The columns copied into an entry as plain fields. */
export const publicColumns = (table: ChainTable): string[] => columnsOf(table, ['public']);

/** A row as SQLite returns it, keyed by SQL column name (`SELECT *`). */
export type RawRow = Record<string, unknown>;
export type FieldValue = string | number | null;

/** One value as SQLite stores it. A boolean becomes 0 or 1 and a missing key becomes
 *  null, so a Drizzle row and a `wrangler d1 execute --json` row fingerprint alike. */
function normalize(value: unknown): FieldValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new TypeError(`acceptance-chain: unsupported column value of type ${typeof value}`);
}

function pick(row: RawRow, columns: readonly string[]): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  for (const column of columns) out[column] = normalize(row[column]);
  return out;
}

/**
 * The fingerprint of one row: `sha256(canonicalJson(pick(row, hashedColumns(table))))`.
 * `ip` and `user_agent` are never read, so changing them never changes the fingerprint.
 */
export function rowFingerprint(table: ChainTable, row: RawRow): Promise<string> {
  return sha256Hex(canonicalJson(pick(row, hashedColumns(table))));
}

/** A row's id as a string. Both tables key on a text `id`. */
function rowId(row: RawRow): string {
  const id = row.id;
  if (typeof id !== 'string' || id === '') throw new Error('acceptance-chain: a row has no id');
  return id;
}

export interface LiveRow {
  table: ChainTable;
  id: string;
  fingerprint: string;
  fields: Record<string, FieldValue>;
  /** `created_at`, for the verify's "older than the last export" test. */
  createdAt: string | null;
}

/** Fingerprint every row of one table. */
export async function fingerprintRows(
  table: ChainTable,
  rows: readonly RawRow[],
): Promise<LiveRow[]> {
  const fieldColumns = publicColumns(table);
  return Promise.all(
    rows.map(async (row) => ({
      table,
      id: rowId(row),
      fingerprint: await rowFingerprint(table, row),
      fields: pick(row, fieldColumns),
      createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    })),
  );
}

/** The last fingerprint exported for a row (`acceptance_chain_rows`, or a chain walk). */
export interface PriorRow {
  table: ChainTable;
  id: string;
  fingerprint: string;
  deleted: boolean;
}

/** One line of a chain file. A `delete` tombstone carries the row's last fingerprint and
 *  no fields. */
export interface ChainEntry {
  table: ChainTable;
  id: string;
  op: 'upsert' | 'delete';
  fingerprint: string;
  fields?: Record<string, FieldValue>;
}

const rowKey = (table: string, id: string) => `${table}:${id}`;

/** Entries in a stable order: table, then id, both binary. */
function sortEntries<T extends { table: string; id: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => compareBinary(a.table, b.table) || compareBinary(a.id, b.id));
}

/**
 * What changed since the last export: an `upsert` for a row that is new, changed, or
 * back after a tombstone, and a `delete` for an exported row that is gone from D1.
 */
export function diffRows(live: readonly LiveRow[], prior: readonly PriorRow[]): ChainEntry[] {
  const before = new Map(prior.map((p) => [rowKey(p.table, p.id), p]));
  const seen = new Set<string>();
  const entries: ChainEntry[] = [];
  for (const row of live) {
    const key = rowKey(row.table, row.id);
    seen.add(key);
    const last = before.get(key);
    if (last && !last.deleted && last.fingerprint === row.fingerprint) continue;
    entries.push({
      table: row.table,
      id: row.id,
      op: 'upsert',
      fingerprint: row.fingerprint,
      fields: row.fields,
    });
  }
  for (const last of prior) {
    if (last.deleted || seen.has(rowKey(last.table, last.id))) continue;
    entries.push({ table: last.table, id: last.id, op: 'delete', fingerprint: last.fingerprint });
  }
  return sortEntries(entries);
}

/** SHA-256 over every live row's `table:id:fingerprint` line, sorted and joined by `\n`.
 *  One value covers the whole state, so a quiet night still commits to it. */
export function stateSha256(
  rows: readonly { table: string; id: string; fingerprint: string }[],
): Promise<string> {
  const lines = rows.map((r) => `${r.table}:${r.id}:${r.fingerprint}`).sort(compareBinary);
  return sha256Hex(lines.join('\n'));
}

export interface ChainFile {
  schema: typeof ACCEPTANCE_CHAIN_SCHEMA;
  seq: number;
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** ISO-8601. */
  created_at: string;
  /** The previous file's SHA-256. Null at seq 1. */
  prev_sha256: string | null;
  fingerprint_version: number;
  entries: ChainEntry[];
  state_sha256: string;
}

/** The file's R2 key. The day is inside the file, not in the key: `wrangler` cannot list
 *  a bucket, so the verify walks `000001`, `000002`, … until a key is missing. */
export function chainKey(seq: number): string {
  return `${ACCEPTANCE_CHAIN_PREFIX}${String(seq).padStart(6, '0')}.json`;
}

/** The DigiCert token's R2 key, beside its file. */
export function tsrKey(seq: number): string {
  return `${ACCEPTANCE_CHAIN_PREFIX}${String(seq).padStart(6, '0')}.tsr`;
}

/** The file's bytes: canonical JSON and a newline, so the same file always hashes the same. */
export function serializeChainFile(file: ChainFile): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(file)}\n`);
}

/** Parse and shape-check a chain file. Throws on anything that is not one, including
 *  any malformed entry, so the verify reports it as `CHAIN BROKEN` at that seq. */
export function parseChainFile(bytes: Uint8Array): ChainFile {
  const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<ChainFile> | null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('not a JSON object');
  }
  if (value.schema !== ACCEPTANCE_CHAIN_SCHEMA) throw new Error('not an acceptance chain file');
  if (!Number.isInteger(value.seq) || (value.seq as number) < 1) throw new Error('bad seq');
  if (!isSha256(value.state_sha256)) throw new Error('bad state_sha256');
  if (value.prev_sha256 !== null && !isSha256(value.prev_sha256)) {
    throw new Error('bad prev_sha256');
  }
  if (!Number.isInteger(value.fingerprint_version)) throw new Error('bad fingerprint_version');
  if (typeof value.created_at !== 'string' || typeof value.day !== 'string') {
    throw new Error('bad created_at or day');
  }
  if (!Array.isArray(value.entries)) throw new Error('chain file has no entries array');
  value.entries.forEach((e: unknown, i) => {
    const entry = e as Partial<ChainEntry> | null;
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !(CHAIN_TABLES as readonly unknown[]).includes(entry.table) ||
      typeof entry.id !== 'string' ||
      entry.id === '' ||
      (entry.op !== 'upsert' && entry.op !== 'delete') ||
      !isSha256(entry.fingerprint)
    ) {
      throw new Error(`entry ${i} is malformed`);
    }
  });
  return value as ChainFile;
}

function isSha256(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** Apply a file's entries to a running state, as the export's ledger and the verify do. */
export function applyEntries(state: Map<string, PriorRow>, entries: readonly ChainEntry[]): void {
  for (const e of entries) {
    state.set(rowKey(e.table, e.id), {
      table: e.table,
      id: e.id,
      fingerprint: e.fingerprint,
      deleted: e.op === 'delete',
    });
  }
}

// ---------------------------------------------------------------------------
// R2 bucket lock (operator step, `docs/environments.md`)
// ---------------------------------------------------------------------------

export interface LockRule {
  name: string;
  enabled: boolean;
  /** Empty for a rule that covers every key. */
  prefix: string;
  /** `indefinitely`, `after N days` or `on YYYY-MM-DD`, as wrangler prints it. */
  condition: string;
}

const LOCK_LINE = /^\s*(name|enabled|prefix|condition):\s*(.*?)\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/**
 * Read `wrangler r2 bucket lock list` output: blocks of `name:`, `enabled:`, `prefix:`
 * and `condition:` lines, separated by blank lines. "There are no lock rules" yields [].
 */
export function parseLockRules(text: string): LockRule[] {
  const rules: LockRule[] = [];
  let current: Partial<Record<string, string>> = {};
  const flush = () => {
    if (current.name !== undefined) {
      const prefix = current.prefix ?? '';
      rules.push({
        name: current.name,
        enabled: (current.enabled ?? '').toLowerCase() === 'yes',
        prefix: prefix === '(all prefixes)' ? '' : prefix,
        condition: current.condition ?? '',
      });
    }
    current = {};
  };
  for (const line of text.replace(ANSI, '').split('\n')) {
    const m = line.match(LOCK_LINE);
    if (m) {
      if (m[1] === 'name' && current.name !== undefined) flush();
      current[m[1]!] = m[2]!;
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();
  return rules;
}

// ---------------------------------------------------------------------------
// The prune contract (AECI-1638)
// ---------------------------------------------------------------------------

/**
 * The `table:id` pairs a retention prune says it deleted. The contract with AECI-1638:
 * a prune that deletes an acceptance or grant row writes its `retention.pruned` audit
 * row with `metadata.tables[]` entries of `{ table, ids: [...] }`. A tombstone the
 * verify finds is accepted only when such a row names it. Malformed metadata is skipped.
 */
export function pruneAuditIds(metadatas: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const raw of metadatas) {
    let meta: unknown = raw;
    if (typeof raw === 'string') {
      try {
        meta = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const tables = (meta as { tables?: unknown } | null)?.tables;
    if (!Array.isArray(tables)) continue;
    for (const t of tables as ({ table?: unknown; ids?: unknown } | null)[]) {
      if (typeof t?.table !== 'string' || !Array.isArray(t.ids)) continue;
      for (const id of t.ids) if (typeof id === 'string') out.add(rowKey(t.table, id));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verify (`ops:verify-acceptance-chain`)
// ---------------------------------------------------------------------------

export type FindingCode =
  | 'LOCK MISSING'
  | 'LOCK NOT INDEFINITE'
  | 'LOCK NOT CHECKED'
  | 'NO FILES'
  | 'CHAIN BROKEN'
  | 'CHAIN STALE'
  | 'TIMESTAMP MISSING'
  | 'TIMESTAMP INVALID'
  | 'CHANGED'
  | 'UNEXPORTED'
  | 'ABSENT'
  | 'TOMBSTONE WITHOUT PRUNE AUDIT';

export interface Finding {
  /** `fail` makes the run fail. `warn` and `info` are reported only. */
  level: 'fail' | 'warn' | 'info';
  code: FindingCode;
  detail: string;
}

export interface VerifyInput {
  /** The lock rules on the bucket, or null when they cannot be read (local). */
  lockRules: readonly LockRule[] | null;
  /** The chain files as fetched from R2, seq 1 upward, stopping at the first missing key. */
  files: readonly { key: string; bytes: Uint8Array | null }[];
  /** Now, on a deployed tier. Set it to report a chain whose newest file is too old
   *  (`CHAIN STALE`), which is what deleting the newest files looks like. Omit locally. */
  now?: Date;
  /** Every live D1 row, by table, as `SELECT *` returns it. */
  d1Rows: Readonly<Record<ChainTable, readonly RawRow[]>>;
  /** From {@link pruneAuditIds}. */
  pruneAuditIds: ReadonlySet<string>;
  /** Each file's DigiCert token check, by seq. A seq with no entry was not checked. */
  timestamps?: ReadonlyMap<number, 'ok' | 'missing' | 'invalid'>;
}

/** The lock result, reported apart from the chain so one cannot hide the other. */
export type LockVerdict = 'LOCKED' | 'LOCK MISSING' | 'LOCK NOT INDEFINITE' | 'LOCK NOT CHECKED';
/** The chain result: did every file's link hold? */
export type ChainVerdict = 'CHAIN INTACT' | 'CHAIN BROKEN' | 'CHAIN STALE' | 'NO FILES';
/** The D1 result: does every live row match its last fingerprint in the chain? */
export type RowsVerdict = 'ROWS MATCH' | 'ROWS DIFFER';

export interface VerifyResult {
  ok: boolean;
  lock: LockVerdict;
  chain: ChainVerdict;
  rows: RowsVerdict;
  findings: Finding[];
  /** Files whose link held. */
  filesVerified: number;
  /** The seq of the first broken link, or null. */
  brokenAt: number | null;
}

/** Does any enabled rule cover the chain prefix, and does one hold it indefinitely? */
export function lockFindings(rules: readonly LockRule[] | null): Finding[] {
  if (rules === null) {
    return [
      {
        level: 'info',
        code: 'LOCK NOT CHECKED',
        detail: 'Local R2 has no bucket lock. The lock is checked only on a deployed tier.',
      },
    ];
  }
  const covering = rules.filter((r) => r.enabled && ACCEPTANCE_CHAIN_PREFIX.startsWith(r.prefix));
  if (covering.length === 0) {
    return [
      {
        level: 'fail',
        code: 'LOCK MISSING',
        detail: `No enabled bucket lock rule covers ${ACCEPTANCE_CHAIN_PREFIX}. Anyone with R2 write access can overwrite or delete the chain. Add the rule in docs/environments.md.`,
      },
    ];
  }
  if (!covering.some((r) => r.condition === 'indefinitely')) {
    const names = covering.map((r) => `"${r.name}" (${r.condition})`).join(', ');
    return [
      {
        level: 'fail',
        code: 'LOCK NOT INDEFINITE',
        detail: `The chain is locked only by ${names}. Those files can be deleted when that rule lapses. ADR 0057 requires an indefinite rule on ${ACCEPTANCE_CHAIN_PREFIX}.`,
      },
    ];
  }
  return [];
}

/** A deployed chain whose newest file is older than this is `CHAIN STALE`. One missed
 *  night is tolerated, since a failed run is retried by the queue and the next cron. */
export const STALE_AFTER_HOURS = 50;

/** Walk the files from seq 1. Stops at the first broken link. */
async function walkChain(input: VerifyInput, findings: Finding[]) {
  const state = new Map<string, PriorRow>();
  let prevSha: string | null = null;
  let lastCreatedAt: string | null = null;
  let filesVerified = 0;
  let brokenAt: number | null = null;

  for (const [index, file] of input.files.entries()) {
    const seq = index + 1;
    let problem: string | null = null;
    let parsed: ChainFile | null;
    const next = new Map(state);
    try {
      if (file.bytes === null) throw new Error('missing from R2, while a later seq exists');
      parsed = parseChainFile(file.bytes);
    } catch (error) {
      problem = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
      parsed = null;
    }
    // Any throw while checking one file is that file's broken link, never a crash.
    try {
      if (parsed) {
        if (parsed.seq !== seq) problem = `the file says seq ${parsed.seq}`;
        else if (parsed.prev_sha256 !== prevSha) {
          problem =
            seq === 1
              ? `prev_sha256 is ${parsed.prev_sha256}, but the first file names no previous file`
              : `prev_sha256 is ${parsed.prev_sha256 ?? 'null'}, but seq ${seq - 1} hashes to ${prevSha}. Seq ${seq - 1} changed after this file was written, or this file was replaced`;
        } else if (parsed.fingerprint_version !== FINGERPRINT_VERSION) {
          problem = `fingerprint_version ${parsed.fingerprint_version} is not ${FINGERPRINT_VERSION}`;
        } else {
          applyEntries(next, parsed.entries);
          const live = [...next.values()].filter((r) => !r.deleted);
          if ((await stateSha256(live)) !== parsed.state_sha256) {
            problem = 'state_sha256 does not match the entries of the chain up to this file';
          }
        }
      }
    } catch (error) {
      problem = `unverifiable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (problem !== null || !parsed || file.bytes === null) {
      brokenAt = seq;
      findings.push({
        level: 'fail',
        code: 'CHAIN BROKEN',
        detail: `seq ${seq} (${file.key}): ${problem}. Every file from here on is unproven.`,
      });
      break;
    }
    state.clear();
    for (const [k, v] of next) state.set(k, v);
    prevSha = await sha256HexBytes(file.bytes);
    lastCreatedAt = parsed.created_at;
    filesVerified += 1;

    const ts = input.timestamps?.get(seq);
    if (ts === 'missing') {
      findings.push({
        level: 'warn',
        code: 'TIMESTAMP MISSING',
        detail: `seq ${seq}: no DigiCert token in R2. A later export run backfills it.`,
      });
    } else if (ts === 'invalid') {
      findings.push({
        level: 'warn',
        code: 'TIMESTAMP INVALID',
        detail: `seq ${seq}: openssl ts -verify failed on the DigiCert token.`,
      });
    }
  }
  return { state, lastCreatedAt, filesVerified, brokenAt };
}

/**
 * Check the chain and compare D1 with it. It trusts nothing in D1's own ledger tables:
 * the state comes only from walking the R2 files. Order: the lock, the chain links (it
 * stops at the first broken one), the timestamps, then every D1 row.
 */
export async function verifyAcceptanceChain(input: VerifyInput): Promise<VerifyResult> {
  const findings: Finding[] = lockFindings(input.lockRules);
  if (input.files.length === 0) {
    findings.push({
      level: 'fail',
      code: 'NO FILES',
      detail: `No chain file at ${chainKey(1)}. The export has not run, or the chain was deleted.`,
    });
  }
  const { state, lastCreatedAt, filesVerified, brokenAt } = await walkChain(input, findings);
  // The newest files can be deleted without breaking a link. The nightly cadence is the
  // check: on a deployed tier the newest intact file must be under STALE_AFTER_HOURS old.
  let stale = false;
  if (input.now && brokenAt === null && lastCreatedAt !== null) {
    const ageHours = (input.now.getTime() - Date.parse(lastCreatedAt)) / 3_600_000;
    if (!(ageHours <= STALE_AFTER_HOURS)) {
      stale = true;
      findings.push({
        level: 'fail',
        code: 'CHAIN STALE',
        detail: `The newest file (seq ${filesVerified}) was written ${lastCreatedAt}, more than ${STALE_AFTER_HOURS} hours ago. The nightly export stopped, or the newest files were deleted. Check job_runs and the acceptance_chain_exports ledger.`,
      });
    }
  }

  // D1 against the last state the chain proves.
  const seen = new Set<string>();
  for (const table of CHAIN_TABLES) {
    for (const row of await fingerprintRows(table, input.d1Rows[table])) {
      const key = rowKey(table, row.id);
      seen.add(key);
      const last = state.get(key);
      if (!last) {
        const older =
          lastCreatedAt !== null && row.createdAt !== null && row.createdAt < lastCreatedAt;
        findings.push({
          level: older ? 'fail' : 'info',
          code: 'UNEXPORTED',
          detail: older
            ? `${key}: created ${row.createdAt}, before the last export (${lastCreatedAt}), but not in the chain.`
            : `${key}: created after the last export. The next nightly run exports it.`,
        });
      } else if (last.deleted) {
        findings.push({
          level: 'fail',
          code: 'CHANGED',
          detail: `${key}: in D1, but the chain holds a tombstone for it.`,
        });
      } else if (last.fingerprint !== row.fingerprint) {
        findings.push({
          level: 'fail',
          code: 'CHANGED',
          detail: `${key}: D1 fingerprint ${row.fingerprint} differs from the chain's ${last.fingerprint}. The row was edited after the last export. Check audit_log for a write that explains it.`,
        });
      }
    }
  }
  for (const [key, last] of [...state.entries()].sort(([a], [b]) => compareBinary(a, b))) {
    if (last.deleted) {
      if (!input.pruneAuditIds.has(key)) {
        findings.push({
          level: 'fail',
          code: 'TOMBSTONE WITHOUT PRUNE AUDIT',
          detail: `${key}: the chain records a delete, and no retention.pruned audit row names it.`,
        });
      }
    } else if (!seen.has(key)) {
      findings.push({
        level: 'fail',
        code: 'ABSENT',
        detail: `${key}: in the chain, missing from D1, and no tombstone yet.`,
      });
    }
  }

  const has = (code: FindingCode) => findings.some((f) => f.code === code);
  const lock: LockVerdict = has('LOCK MISSING')
    ? 'LOCK MISSING'
    : has('LOCK NOT INDEFINITE')
      ? 'LOCK NOT INDEFINITE'
      : has('LOCK NOT CHECKED')
        ? 'LOCK NOT CHECKED'
        : 'LOCKED';
  const chain: ChainVerdict =
    input.files.length === 0
      ? 'NO FILES'
      : brokenAt !== null
        ? 'CHAIN BROKEN'
        : stale
          ? 'CHAIN STALE'
          : 'CHAIN INTACT';
  const rowCodes: readonly FindingCode[] = [
    'CHANGED',
    'UNEXPORTED',
    'ABSENT',
    'TOMBSTONE WITHOUT PRUNE AUDIT',
  ];
  const rows: RowsVerdict = findings.some((f) => f.level === 'fail' && rowCodes.includes(f.code))
    ? 'ROWS DIFFER'
    : 'ROWS MATCH';

  return {
    ok: !findings.some((f) => f.level === 'fail'),
    lock,
    chain,
    rows,
    findings,
    filesVerified,
    brokenAt,
  };
}
