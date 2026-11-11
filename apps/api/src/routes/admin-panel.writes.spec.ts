/**
 * AECI-1671 — `ADMIN_PANEL_SPEC.md` §6's table is the complete inventory of the
 * admin panel's non-`GET` routes, and §2's "read-only with N named write routes"
 * count is pinned to it.
 *
 * Why this file exists. §2's exception count was hand-maintained and drifted for
 * its whole life: AECI-720's endpoint reached §6's table without amending the
 * count, and AECI-1615 found roughly ten routes the count had never named at all
 * (the protest decision, the field corrections, the brand-assets hold, the email
 * switch, the stub-mapping decision and three pre-existing decision PATCHes). A
 * write that is not in the list looks like it does not exist. A route registered
 * in `apps/api/src/index.ts` but missing from §6 now fails here, in both
 * directions:
 *
 *   registered non-GET ⊆ §6 table   — a route without its doc row fails CI
 *   §6 table non-GET ⊆ registered   — a row for a retired route fails CI
 *   §2's bold count == writes        — the hand count is now a checked number
 *
 * How to fix a failure: add the missing row to §6's table (or delete the row of a
 * retired route), then check §2's "read-only with N named write routes" number
 * and its exception families. Amend both in the same PR as the endpoint — that
 * rule is §2's own, and this file is its teeth.
 *
 * Same technique as `banned-at-writers.spec.ts` (source scan) and
 * `bot-traffic-classification-doc.spec.ts` (doc pinned to code, both
 * directions). Asserted over source text because behaviour cannot see the
 * absence of a doc row.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const INDEX = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
const DOC = readFileSync(join(process.cwd(), '..', '..', 'docs', 'ADMIN_PANEL_SPEC.md'), 'utf8');

type Route = string; // "METHOD /path"

// ─── The registrations in index.ts ───────────────────────────────────────────

/**
 * Every `authAdmin.<method>('/api/...', ...)` registration, including the
 * multi-line ones. Single- or double-quoted paths; no admin route today uses a
 * template literal, and a backticked one would trip the sanity tripwire below
 * rather than pass vacuously.
 */
const REGISTERED = new Set<Route>();
for (const m of INDEX.matchAll(/authAdmin\.(get|post|patch|put|delete)\(\s*['"]([^'"]+)['"]/g)) {
  REGISTERED.add(`${m[1].toUpperCase()} ${m[2]}`);
}

const REGISTERED_NON_GET = [...REGISTERED].filter((r) => !r.startsWith('GET ')).sort();

// ─── §6's table ───────────────────────────────────────────────────────────────

/** The `## 6. API surface` slice of the doc, up to the next `## ` heading. */
const SECTION_6 = (() => {
  const start = DOC.indexOf('## 6. API surface');
  const rest = DOC.indexOf('\n## ', start);
  return DOC.slice(start, rest === -1 ? undefined : rest);
})();

/**
 * The routes §6's TABLE names. First cells of `|`-rows only:
 * the section's prose also mentions routes that are deliberately not built
 * (`POST /api/admin/jobs/:job/run`) or live on other routers
 * (`POST /api/promote`), and those must not count as table rows.
 *
 * `·`-shorthand pieces after a full path are suffixes: one starting with a
 * param segment (`/:id/restore`) joins onto the full path before it, any other
 * (`/restore`) replaces its last segment.
 */
const TABLE = new Map<Route, string>(); // route -> first cell it came from
for (const line of SECTION_6.split('\n')) {
  if (!line.startsWith('|')) continue;
  const bar = line.indexOf('|', 1);
  if (bar === -1) continue;
  const cell = line.slice(1, bar);
  for (const group of cell.split(',')) {
    let method = '';
    let prefix = '';
    for (const piece of group.split('·')) {
      const s = piece.replace(/`/g, '').trim();
      const m = s.match(/^(GET|POST|PATCH|PUT|DELETE)\s+(\/\S+)$/);
      if (m) {
        method = m[1];
        prefix = m[2];
        TABLE.set(`${method} ${prefix}`, cell);
      } else if (method && s.startsWith('/:')) {
        TABLE.set(`${method} ${prefix}${s}`, cell);
      } else if (method && s.startsWith('/') && !s.includes(' ')) {
        TABLE.set(`${method} ${prefix.slice(0, prefix.lastIndexOf('/'))}${s}`, cell);
      }
    }
  }
}

const TABLE_NON_GET = [...TABLE.keys()].filter((r) => !r.startsWith('GET ')).sort();

/**
 * A `POST` that is a read with a body, not a write: §5.14's address search,
 * which carries the address in its body so it never reaches a request URL.
 * These are the only non-`GET` routes §2's write count excludes.
 */
const BODY_READ_MARKER = '**A read with a body';
const bodyReads = TABLE_NON_GET.filter((r) => {
  const cell = TABLE.get(r) ?? '';
  return SECTION_6.split('\n').some(
    (line) => line.startsWith('|') && line.includes(cell) && line.includes(BODY_READ_MARKER),
  );
});

// ─── §2's count ──────────────────────────────────────────────────────────────

/** The bold count phrase the spec pins: "**read-only with 49 named write routes**". */
const COUNT = DOC.match(/\*\*read-only with (\d+) named write routes\*\*/);

const writes = REGISTERED_NON_GET.length - bodyReads.length;

// ─── The invariant ────────────────────────────────────────────────────────────

describe('ADMIN_PANEL_SPEC §6 names every non-GET admin route (AECI-1671)', () => {
  it('the parsers found the router and the table (sanity tripwire)', () => {
    // A refactor that renames `authAdmin` or re-homes the admin registrations
    // must fail HERE, loudly, rather than let every check below pass vacuously.
    expect(REGISTERED.size, 'authAdmin registrations found in src/index.ts').toBeGreaterThan(90);
    expect(TABLE.size, 'routes found in §6 table first cells').toBeGreaterThan(80);
    expect(SECTION_6).toContain('## 6. API surface');
  });

  it('every registered non-GET admin route has a §6 table row', () => {
    const missing = REGISTERED_NON_GET.filter((r) => !TABLE.has(r));
    expect(
      missing,
      'add a row for each route to ADMIN_PANEL_SPEC.md §6 (and, if it is a write, ' +
        'check §2 exception families and its count), in the same PR as the endpoint',
    ).toEqual([]);
  });

  it('every non-GET §6 table row is registered in src/index.ts', () => {
    // The AECI-1375 precedent: the plan-pricing PUT was retired and its row went
    // with it. A row left behind is the same drift, in the other direction.
    const phantom = TABLE_NON_GET.filter((r) => !REGISTERED.has(r));
    expect(phantom, 'delete the row from ADMIN_PANEL_SPEC.md §6').toEqual([]);
  });

  it("§2's named-write-route count matches the registrations", () => {
    expect(
      COUNT,
      'the bold count phrase "read-only with **N named write routes**" was not found',
    ).not.toBeNull();
    const stated = COUNT ? Number(COUNT[1]) : NaN;
    expect(stated, 'ADMIN_PANEL_SPEC.md §2: read-only with **N named write routes**').toBe(writes);
  });
});
