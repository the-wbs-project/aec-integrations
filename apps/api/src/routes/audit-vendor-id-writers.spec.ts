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
 *  3. An `action:` the scanner cannot resolve to a string (a template literal such as
 *     `` `${seatRole}.banned` ``) is invisible to rule 2. Every such writer outside a
 *     vendor route and outside {@link STAMPED_DOWNSTREAM} must be listed in
 *     {@link UNRESOLVED_ACTION_WRITERS}, and must still carry a stamp beside it.
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

/**
 * Modules that write a vendor-scoped action through an expression the scanner cannot
 * resolve to a string, so rule 2 cannot see them. Each must keep a vendor stamp
 * beside every such `action:` line. The value names the actions it can produce, so a
 * reviewer can check the registry entry by hand.
 */
const UNRESOLVED_ACTION_WRITERS: Record<string, string> = {
  'routes/admin-field-overrides.ts':
    '`${prefix}.field_overridden` / `${actionPrefix(entityType)}.override_lifted`: `{vendor,product,integration}.field_overridden` and `.override_lifted`, stamped with the holder vendor (AECI-1237)',
  'routes/admin-reviewers.ts':
    '`${seatRole}.banned` / `.unbanned`: `vendor_admin.banned` and `vendor_admin.unbanned` for a vendor seat; a reviewer ban is not vendor-scoped and spreads `NO_VENDOR_STAMP`',
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
 *
 * Aliases resolve too: `const NAME = OTHER.key` and `const NAME = { key: OTHER.key }`.
 * `REVIEW_RESPONSE_DECISION_ACTIONS` is built that way over `REVIEW_RESPONSE_ACTIONS`,
 * and without this pass its writer in `admin-review-responses.ts` was invisible.
 */
function actionConstants(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (name: string, value: string) => {
    const known = out.get(name) ?? [];
    if (known.includes(value)) return false;
    out.set(name, [...known, value]);
    return true;
  };
  /** `[name, target]`: `name` stands for whatever `target` stands for. */
  const aliases: Array<[string, string]> = [];
  const REF = '[A-Z][A-Z0-9_]*(?:\\.\\w+)?';
  for (const { src } of files) {
    for (const m of src.matchAll(/const (\w+)(?::[^=]+)? = '([a-z_]+(?:\.[a-z_]+)+)'/g)) {
      add(m[1]!, m[2]!);
    }
    for (const m of src.matchAll(new RegExp(`const (\\w+)(?::[^=]+)? = (${REF})\\s*;`, 'g'))) {
      aliases.push([m[1]!, m[2]!]);
    }
    for (const m of src.matchAll(/const (\w+) = \{([^{}]*)\}/g)) {
      for (const kv of m[2]!.matchAll(/(\w+): '([a-z_]+(?:\.[a-z_]+)+)'/g)) {
        add(`${m[1]}.${kv[1]}`, kv[2]!);
        add(m[1]!, kv[2]!);
      }
      for (const kv of m[2]!.matchAll(new RegExp(`(\\w+): (${REF})\\s*[,\\n]`, 'g'))) {
        aliases.push([`${m[1]}.${kv[1]}`, kv[2]!], [m[1]!, kv[2]!]);
      }
    }
  }
  // Fixed point: an alias may point at another alias, declared in any order.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, target] of aliases) {
      for (const value of out.get(target) ?? []) changed = add(name, value) || changed;
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

/** Whether the object literal around `lines[i]` has a sibling that names the vendor. */
function hasSiblingStamp(lines: string[], i: number, indent: number): boolean {
  // The sibling properties: walk out both ways until the indentation drops.
  for (const step of [-1, 1]) {
    for (let j = i + step; j >= 0 && j < lines.length; j += step) {
      const text = lines[j]!;
      if (text.trim() === '') continue;
      const depth = text.length - text.trimStart().length;
      if (depth < indent) break;
      if (depth === indent && STAMP.test(text.trim())) return true;
    }
  }
  return false;
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
      writers.push({
        path,
        line: i + 1,
        actions,
        stamped: hasSiblingStamp(lines, i, m[1]!.length),
      });
    });
  }
  return writers;
}

/** Every `action:` built from a template literal: no string the scanner can resolve. */
function unresolvedActionWriters(): Omit<Writer, 'actions'>[] {
  const writers: Omit<Writer, 'actions'>[] = [];
  for (const { path, src } of files) {
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      const m = line.match(ACTION_LINE);
      if (!m || !m[2]!.includes('`')) return;
      writers.push({ path, line: i + 1, stamped: hasSiblingStamp(lines, i, m[1]!.length) });
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

  it('resolves an action map built from another map (NAME: OTHER.key)', () => {
    // `REVIEW_RESPONSE_DECISION_ACTIONS` aliases `REVIEW_RESPONSE_ACTIONS.*`. If this
    // fails, the admin reply-decision writer has dropped out of rule 2 again.
    expect(vendorActionsIn('REVIEW_RESPONSE_DECISION_ACTIONS[payload.decision]').sort()).toEqual([
      'review_response.approved',
      'review_response.rejected',
      'review_response.removed',
    ]);
    expect(
      vendorActionWriters().some((w) => w.path === 'routes/admin-review-responses.ts' && w.stamped),
    ).toBe(true);
  });

  it('every template-literal action outside a vendor route is listed, and stamped', () => {
    const writers = unresolvedActionWriters().filter(
      (w) => !isVendorRoute(w.path) && !(w.path in STAMPED_DOWNSTREAM),
    );
    const unlisted = writers
      .filter((w) => !(w.path in UNRESOLVED_ACTION_WRITERS))
      .map((w) => `${w.path}:${w.line}`);
    expect(unlisted).toEqual([]);
    const unstamped = writers.filter((w) => !w.stamped).map((w) => `${w.path}:${w.line}`);
    expect(unstamped).toEqual([]);
    // A stale entry is a hole waiting for a new writer. Drop it instead.
    const paths = new Set(writers.map((w) => w.path));
    expect(Object.keys(UNRESOLVED_ACTION_WRITERS).filter((p) => !paths.has(p))).toEqual([]);
  });

  it('the registry keys are dot-separated audit actions', () => {
    for (const action of Object.keys(AUDIT_VENDOR_ACTIONS)) {
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
  });
});
