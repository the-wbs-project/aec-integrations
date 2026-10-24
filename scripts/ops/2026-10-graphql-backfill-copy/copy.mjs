#!/usr/bin/env node
//
// copy.mjs — moves the Cloudflare GraphQL backfill into the edge request log bucket (AECI-1448).
//
// Source: R2 bucket `aeci-views-temp`, only keys under `cloudflare-backfill-` (kept as they are).
// The bucket also holds the AECI-1167 old-account export (`old-account-final-export-2026-10-04/`).
// That is not backfill. It stays in `aeci-views-temp` and this script never reads or deletes it.
// Destination: R2 bucket `aeci-edge-log-prod-us`, under `graphql-backfill/<source key>`.
// Both buckets are on The WBS Project account. ADR 0045 decided the destination.
//
// It talks to R2's S3 API with a one-off R2 API token that has Object Read & Write on both
// buckets: R2_BACKFILL_KEY_ID and R2_BACKFILL_SECRET. Wrangler cannot list or copy objects,
// which is why this script exists. It has no dependencies.
//
//   node copy.mjs inventory                       read-only: list the source, write manifest.csv
//   node copy.mjs upload <localDir> <destPrefix>  put a local pull under graphql-backfill/<destPrefix>/
//   node copy.mjs copy                            copy every source row of the manifest
//   node copy.mjs verify                          read-only: every manifest row must match in R2
//   node copy.mjs summary                         read-only: Markdown row-count table from the manifest
//   node copy.mjs prune-source --confirm aeci-views-temp
//                                                 verify, then delete the copied backfill from the source
//
// The manifest (manifest.csv beside this script) is the record the READMEs quote. One row per
// destination object: its key, where it came from, bytes, SHA-256 and data rows. Rows are CSV
// records after the header, counted quote-aware, after gunzip when the bytes are gzip.
//
// Nothing is ever overwritten. A destination key that exists with the same SHA-256 is skipped,
// and one with different bytes stops the run.
//
// Requests use node:https, not fetch: fetch decompresses a body stored with
// `Content-Encoding: gzip`, and the hashes must be over the stored bytes.

import { createHash, createHmac } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ACCOUNT = '004dc1af737b22a8aa83b3550fa9b9d3';
const HOST = `${ACCOUNT}.r2.cloudflarestorage.com`;
const SOURCE = 'aeci-views-temp';
const SOURCE_PREFIX = 'cloudflare-backfill-';
const DEST = 'aeci-edge-log-prod-us';
const DEST_PREFIX = 'graphql-backfill/';
const MANIFEST = join(dirname(fileURLToPath(import.meta.url)), 'manifest.csv');
const COLUMNS = ['key', 'source', 'bytes', 'sha256', 'rows'];

const KEY_ID = process.env.R2_BACKFILL_KEY_ID;
const SECRET = process.env.R2_BACKFILL_SECRET;

// --- S3 SigV4 ---------------------------------------------------------------------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const enc = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** SigV4 headers for one request. Pure, so it can be checked against AWS's published example. */
export function sign({ method, path, qs, headers, body, now, keyId, secret, region = 'auto' }) {
  const day = now.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
    'x-amz-content-sha256': sha256(body),
    'x-amz-date': now,
  };
  // Binary order is what SigV4 requires for header names.
  const names = Object.keys(all).sort();
  const canonical = [
    method,
    path,
    qs,
    names.map((n) => `${n}:${all[n].trim()}\n`).join(''),
    names.join(';'),
    all['x-amz-content-sha256'],
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', now, scope, sha256(canonical)].join('\n');
  const signingKey = [region, 's3', 'aws4_request'].reduce(hmac, hmac(`AWS4${secret}`, day));
  all.authorization =
    `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, ` +
    `Signature=${hmac(signingKey, toSign).toString('hex')}`;
  return all;
}

function s3(method, bucket, key = '', { query = {}, body = Buffer.alloc(0), headers = {} } = {}) {
  if (!KEY_ID || !SECRET) throw new Error('Set R2_BACKFILL_KEY_ID and R2_BACKFILL_SECRET');
  const path = `/${bucket}${key ? `/${key.split('/').map(enc).join('/')}` : ''}`;
  // Binary order is what SigV4 requires for the canonical query string.
  const qs = Object.entries(query)
    .map(([k, v]) => `${enc(k)}=${enc(String(v))}`)
    .sort()
    .join('&');
  const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const all = sign({
    method,
    path,
    qs,
    headers: { ...headers, host: HOST },
    body,
    now,
    keyId: KEY_ID,
    secret: SECRET,
  });
  if (body.length) all['content-length'] = String(body.length);

  return new Promise((resolve, reject) => {
    const req = request(
      { method, host: HOST, path: qs ? `${path}?${qs}` : path, headers: all },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function ok(res, what) {
  if (res.status >= 200 && res.status < 300) return res;
  throw new Error(`${what}: HTTP ${res.status} ${res.body.toString().slice(0, 300)}`);
}

const xmlText = (s) =>
  s
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

export async function list(bucket, prefix = '') {
  const keys = [];
  let token;
  do {
    const query = { 'list-type': 2, prefix, ...(token ? { 'continuation-token': token } : {}) };
    const xml = (
      await ok(await s3('GET', bucket, '', { query }), `list ${bucket}`)
    ).body.toString();
    for (const [, k] of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(xmlText(k));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xmlText(xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)[1])
      : undefined;
  } while (token);
  return keys;
}

export const get = async (bucket, key) => ok(await s3('GET', bucket, key), `get ${bucket}/${key}`);
const head = async (bucket, key) => (await s3('HEAD', bucket, key)).status === 200;

// --- Counting and the manifest -----------------------------------------------------------

/** CSV records after the header, quote-aware, after gunzip when the bytes are gzip. */
export function countRows(bytes) {
  const text = (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString();
  let records = 0;
  let quoted = false;
  let empty = true;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === '\n' && !quoted) {
      if (!empty) records++;
      empty = true;
    } else if (ch !== '\r') empty = false;
  }
  if (!empty) records++;
  return Math.max(records - 1, 0);
}

const describe = (bytes) => ({
  bytes: bytes.length,
  sha256: sha256(bytes),
  rows: countRows(bytes),
});

function readManifest() {
  if (!existsSync(MANIFEST)) return [];
  const [header, ...lines] = readFileSync(MANIFEST, 'utf8').trim().split('\n');
  if (header !== COLUMNS.join(',')) throw new Error(`Unexpected manifest header: ${header}`);
  return lines.map((l) => {
    const [key, source, bytes, sha, rows] = l.split(',');
    return { key, source, bytes: Number(bytes), sha256: sha, rows: Number(rows) };
  });
}

function writeManifest(rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Binary order is fine: the keys are ASCII paths with dates.
  const sorted = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const r of sorted)
    if (/[,\n]/.test(r.key + r.source)) throw new Error(`Comma or newline in ${r.key}`);
  writeFileSync(
    MANIFEST,
    `${[COLUMNS.join(','), ...sorted.map((r) => COLUMNS.map((c) => r[c]).join(','))].join('\n')}\n`,
  );
  console.error(`${MANIFEST}: ${sorted.length} rows`);
}

/** Puts bytes at a destination key unless the same bytes are already there. */
async function putOnce(key, bytes, headers) {
  if (await head(DEST, key)) {
    const existing = sha256((await get(DEST, key)).body);
    if (existing !== sha256(bytes)) throw new Error(`${DEST}/${key} exists with different bytes`);
    return 'already there';
  }
  await ok(await s3('PUT', DEST, key, { body: bytes, headers }), `put ${DEST}/${key}`);
  return 'copied';
}

const contentHeaders = (h) =>
  Object.fromEntries(
    ['content-type', 'content-encoding'].filter((n) => h[n]).map((n) => [n, h[n]]),
  );

// --- Commands -----------------------------------------------------------------------------

async function inventory() {
  const rows = readManifest();
  const kept = rows.filter((r) => !r.source.startsWith(`${SOURCE}/`));
  const keys = await list(SOURCE, SOURCE_PREFIX);
  // After prune-source the source is empty. Re-listing it would drop the record of the copy.
  const listed = new Set(keys.map((k) => `${SOURCE}/${k}`));
  const gone = rows.filter((r) => r.source.startsWith(`${SOURCE}/`) && !listed.has(r.source));
  if (gone.length)
    throw new Error(`${gone.length} manifest rows are no longer in ${SOURCE}; manifest left as is`);
  for (const [i, key] of keys.entries()) {
    kept.push({
      key: DEST_PREFIX + key,
      source: `${SOURCE}/${key}`,
      ...describe((await get(SOURCE, key)).body),
    });
    process.stderr.write(`inventory ${i + 1}/${keys.length} ${key}\n`);
  }
  writeManifest(kept);
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function upload(localDir, destPrefix) {
  if (!localDir || !destPrefix) throw new Error('upload <localDir> <destPrefix>');
  const rows = readManifest();
  for (const path of walk(localDir)) {
    const rel = relative(localDir, path).split(sep).join('/');
    const key = `${DEST_PREFIX}${destPrefix.replace(/\/+$/, '')}/${rel}`;
    const bytes = readFileSync(path);
    const type = path.endsWith('.gz') ? 'application/gzip' : 'text/csv';
    const result = await putOnce(key, bytes, { 'content-type': type });
    rows.push({ key, source: `local/${rel}`, ...describe(bytes) });
    console.error(`${result}: ${key}`);
  }
  writeManifest(rows);
}

async function copy() {
  const rows = readManifest().filter((r) => r.source.startsWith(`${SOURCE}/`));
  if (!rows.length) throw new Error('No source rows in the manifest. Run inventory first.');
  for (const [i, r] of rows.entries()) {
    const src = await get(SOURCE, r.source.slice(SOURCE.length + 1));
    if (sha256(src.body) !== r.sha256) throw new Error(`${r.source} changed since inventory`);
    const result = await putOnce(r.key, src.body, contentHeaders(src.headers));
    process.stderr.write(`${result} ${i + 1}/${rows.length} ${r.key}\n`);
  }
}

async function verify() {
  const rows = readManifest();
  if (!rows.length) throw new Error('Empty manifest');
  const failures = [];
  for (const [i, r] of rows.entries()) {
    const res = await s3('GET', DEST, r.key);
    if (res.status === 404) failures.push(`missing ${r.key}`);
    else {
      const got = describe((await ok(res, `get ${r.key}`)).body);
      if (got.sha256 !== r.sha256 || got.rows !== r.rows)
        failures.push(`mismatch ${r.key}: rows ${got.rows} vs ${r.rows}`);
    }
    process.stderr.write(`verify ${i + 1}/${rows.length}\r`);
  }
  const known = new Set(rows.map((r) => r.key));
  const extra = (await list(DEST, DEST_PREFIX)).filter((k) => !known.has(k));
  const total = rows.reduce((n, r) => n + r.rows, 0);
  console.error(
    `\nverify: ${rows.length} objects, ${total} rows, ${failures.length} failures, ` +
      `${extra.length} objects under ${DEST_PREFIX} not in the manifest`,
  );
  for (const f of [...failures, ...extra.map((k) => `not in manifest ${k}`)]) console.error(f);
  return failures.length === 0;
}

function summary() {
  // Group by everything above the file name: <pull>/<zone>/<directory>/<dataset>.
  const groups = Map.groupBy(readManifest(), (r) =>
    r.key.slice(DEST_PREFIX.length, r.key.lastIndexOf('/') + 1),
  );
  console.log('| Prefix under `graphql-backfill/` | Objects | Rows |');
  console.log('|---|---|---|');
  for (const [prefix, rows] of groups)
    console.log(
      `| \`${prefix}\` | ${rows.length} | ${rows.reduce((n, r) => n + r.rows, 0).toLocaleString('en-US')} |`,
    );
}

async function pruneSource(flag, name) {
  if (flag !== '--confirm' || name !== SOURCE)
    throw new Error(
      `prune-source deletes every ${SOURCE_PREFIX}* object in ${SOURCE}. Pass --confirm ${SOURCE}`,
    );
  const inManifest = new Set(readManifest().map((r) => r.source));
  const keys = await list(SOURCE, SOURCE_PREFIX);
  const unknown = keys.filter((k) => !inManifest.has(`${SOURCE}/${k}`));
  if (unknown.length) throw new Error(`Not in the manifest, run inventory and copy: ${unknown}`);
  if (!(await verify())) throw new Error('verify failed; nothing deleted');
  for (const [i, key] of keys.entries()) {
    await ok(await s3('DELETE', SOURCE, key), `delete ${SOURCE}/${key}`);
    process.stderr.write(`deleted ${i + 1}/${keys.length} ${key}\n`);
  }
  console.error(`${SOURCE} holds no ${SOURCE_PREFIX}* objects now. The bucket itself stays.`);
}

// Run only as a script, so the signing and counting can be imported and checked.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const commands = {
    inventory,
    upload: () => upload(...args),
    copy,
    verify: async () => {
      if (!(await verify())) process.exitCode = 1;
    },
    summary,
    'prune-source': () => pruneSource(...args),
  };
  if (!commands[command]) throw new Error(`Commands: ${Object.keys(commands).join(', ')}`);
  await commands[command]();
}
