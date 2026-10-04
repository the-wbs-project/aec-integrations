/**
 * The structural invariant behind AECI-1192: **every audit row about a vendor names
 * the vendor in `audit_log.vendor_id`.**
 *
 * This is an INVARIANT test. It encodes a decision (`DATABASE_SCHEMA.md` §8.4), not
 * behaviour, and must not be deleted without reopening that section.
 *
 * Two rules, both asserted over module SOURCE, in the style of
 * `banned-at-writers.spec.ts`, because behaviour cannot see a writer that does not
 * exist yet:
 *
 *  1. Every `auditInsert` in a `/api/vendor/*` route module (`routes/vendor*.ts`)
 *     wraps its entry in `vendorAuditEntry(c, …)`, which stamps the session's vendor
 *     and plan. A vendor write cannot forget the column.
 *  2. Every object literal that writes an action listed in
 *     `@aeci/shared/audit-vendor-actions` sets `vendorId` (or spreads a vendor stamp)
 *     beside its `action`, unless its module is a vendor route (rule 1) or is listed in
 *     {@link STAMPED_DOWNSTREAM} with the seam that stamps it. A new writer of a
 *     vendor-scoped action fails here until it says which vendor its row is about.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_VENDOR_ACTIONS, isAuditVendorAction } from '@aeci/shared/audit-vendor-actions';
import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const SRC = join(process.cwd(), 'src');

/**
 * Modules whose vendor-scoped rows are built WITHOUT `vendorId` and stamped later, at
 * a seam that knows the vendor. Each entry names that seam, so the exemption is a
 * claim a reviewer can check rather than a silent hole.
 */
const STAMPED_DOWNSTREAM: Record<string, string> = {
  'lib/vendor-handback.ts':
    '`sealed()` stamps every row with `p.vendorId` and its plan before the inserts are built',
  'lib/integration-contests.ts':
    'reroute rows are stamped by their callers: `admin-entitlements.ts`, `admin-contests.ts`, `sealed()` in `vendor-handback.ts`, and `vendorAuditEntry` on the vendor routes',
  'lib/integration-claims.ts':
    'claim rows are written only by vendor routes, through `vendorAuditEntry`',
  'lib/integration-owner-writes.ts':
    'owner-write rows are written only by vendor routes, through `vendorAuditEntry`',
  'lib/integration-create.ts':
    'create rows are written only by `vendor-integration-create.ts`, through `vendorAuditEntry`',
  'routes/admin-contests.ts':
    'the accept plan rows are stamped with the owner in `createModerateContestHandler` before insert',
  // AECi's own catalog writes. Promote is fenced off vendor-held rows (ADR 0035), so
  // a promote row is about AECi-curated data. Naming a vendor there is a separate
  // decision, not part of AECI-1192.
  'routes/promote.ts': 'AECi promote; fenced off vendor-held rows (ADR 0035)',
  'routes/promote-contests.ts': 'AECi promote; contest withdrawals on a promote move',
  'lib/promote-claims.ts': 'AECi promote of claims and attestations',
  // An ops retraction deletes the product's `product_vendors` rows in the same plan,
  // so no holder is left to name. Its tombstones carry `product_id` instead.
  'lib/retract-product.ts': 'ops retraction; tombstones carry `product_id`, no holder survives',
};

/** Every `.ts` under `src/`, excluding specs and the test harness. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
    acc.push(full);
  }
  return acc;
}

const rel = (file: string) => file.slice(SRC.length + 1).replaceAll('\\', '/');
const isVendorRoute = (path: string) => /^routes\/vendor[^/]*\.ts$/.test(path);

const files = sourceFiles(SRC).map((file) => ({
  path: rel(file),
  src: readFileSync(file, 'utf8'),
}));

/**
 * Identifier → the action strings it can stand for, across every module:
 * `const NAME = 'a.b'`, and the keys of `const NAME = { key: 'a.b' }` as `NAME.key`
 * (and `NAME` alone, for a computed `NAME[...]`).
 */
function actionConstants(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, value: string) => out.set(name, [...(out.get(name) ?? []), value]);
  for (const { src } of files) {
    for (const m of src.matchAll(/const (\w+)(?::[^=]+)? = '([a-z_]+(?:\.[a-z_]+)+)'/g)) {
      add(m[1]!, m[2]!);
    }
    for (const m of src.matchAll(/const (\w+) = \{([^{}]*)\}/g)) {
      for (const kv of m[2]!.matchAll(/(\w+): '([a-z_]+(?:\.[a-z_]+)+)'/g)) {
        add(`${m[1]}.${kv[1]}`, kv[2]!);
        add(m[1]!, kv[2]!);
      }
    }
  }
  return out;
}

const CONSTANTS = actionConstants();

/** The vendor-scoped actions an `action:` expression can produce. */
function vendorActionsIn(expr: string): string[] {
  const found = new Set<string>();
  for (const m of expr.matchAll(/'([a-z_]+(?:\.[a-z_]+)+)'/g)) found.add(m[1]!);
  for (const m of expr.matchAll(/[A-Z][A-Z0-9_]*(?:\.\w+)?/g)) {
    for (const value of CONSTANTS.get(m[0]) ?? []) found.add(value);
  }
  return [...found].filter(isAuditVendorAction);
}

/** A sibling property that names the vendor: `vendorId`, or a spread stamp. */
const STAMP = /^(vendorId\b|\.\.\.(\w*[sS]tamp\b|ownerStamp\(|\(await vendorAuditStamp\())/;

/** An `action:` property line: its indentation and its expression. */
const ACTION_LINE = /^(\s*)action: (.+)$/;

interface Writer {
  path: string;
  line: number;
  actions: string[];
  stamped: boolean;
}

/** Every `action:` property in an object literal that writes a vendor-scoped action. */
function vendorActionWriters(): Writer[] {
  const writers: Writer[] = [];
  for (const { path, src } of files) {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(ACTION_LINE);
      if (!m) return;
      const actions = vendorActionsIn(m[2]!);
      if (actions.length === 0) return;
      const indent = m[1]!.length;
      // The sibling properties: walk out both ways until the indentation drops.
      const siblings: string[] = [];
      for (const step of [-1, 1]) {
        for (let j = i + step; j >= 0 && j < lines.length; j += step) {
          const text = lines[j]!;
          if (text.trim() === '') continue;
          const depth = text.length - text.trimStart().length;
          if (depth < indent) break;
          if (depth === indent) siblings.push(text.trim());
        }
      }
      writers.push({
        path,
        line: i + 1,
        actions,
        stamped: siblings.some((s) => STAMP.test(s)),
      });
    });
  }
  return writers;
}

describe('every audit row about a vendor names the vendor (AECI-1192)', () => {
  it('scans a non-trivial number of source files (the scan is not vacuous)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => isVendorRoute(f.path)).length).toBeGreaterThan(10);
  });

  it('every auditInsert in a vendor route goes through vendorAuditEntry', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const { path, src } of files.filter((f) => isVendorRoute(f.path))) {
      for (const m of src.matchAll(/auditInsert\(\s*\w+,\s*/g)) {
        calls++;
        const rest = src.slice(m.index! + m[0].length);
        if (!rest.startsWith('vendorAuditEntry(')) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${path}:${line}`);
        }
      }
    }
    expect(calls).toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });

  it('every writer of a registry action sets vendorId, or is stamped downstream', () => {
    const writers = vendorActionWriters();
    // Guards the guard: the resolver must find the writers it exists to check.
    expect(writers.length).toBeGreaterThan(40);
    const offenders = writers
      .filter((w) => !w.stamped && !isVendorRoute(w.path) && !(w.path in STAMPED_DOWNSTREAM))
      .map((w) => `${w.path}:${w.line} (${w.actions.join(', ')})`);
    expect(offenders).toEqual([]);
  });

  it('every STAMPED_DOWNSTREAM entry still writes a registry action', () => {
    // A stale exemption is a hole waiting for a new writer. Drop the entry instead.
    const writerPaths = new Set(vendorActionWriters().map((w) => w.path));
    const stale = Object.keys(STAMPED_DOWNSTREAM).filter((path) => !writerPaths.has(path));
    expect(stale).toEqual([]);
  });

  it('the registry keys are dot-separated audit actions', () => {
    for (const action of Object.keys(AUDIT_VENDOR_ACTIONS)) {
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });
});
