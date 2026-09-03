/**
 * The structural invariant behind AECI-692's headline acceptance criterion:
 * **`profiles.banned_at` has exactly ONE writer.**
 *
 * This is an INVARIANT test — it encodes a decision, not behaviour, and must not
 * be deleted without reopening `docs/ADMIN_PANEL_SPEC.md` §5.8.
 *
 * `createBanReviewerHandler` (`routes/admin-reviewers.ts`) carries a lot that is
 * invisible at the call site and expensive to get wrong: the two 403 guardrails
 * (cannot ban an admin, cannot ban yourself), the 422 on a repeat ban or repeat
 * unban, the **role-aware** audit action (`reviewer.banned` vs
 * `vendor_admin.banned`, which is what makes a banned seat legible in the trail),
 * the reversible `reviewer_ban` workflow row, and the `WHERE banned_at IS [NOT]
 * NULL` predicate on the UPDATE that makes the toggle concurrency-safe. All four
 * statements ride one `db.batch`, so the audit row cannot be lost.
 *
 * A second writer would not fail loudly. It would ban someone correctly and
 * silently skip a guardrail or an audit row — the failure only surfaces later, as
 * a moderation action nobody can account for. AECI-692 added a whole new surface
 * whose most obvious implementation is "write `banned_at` from the users
 * handler", so this is the moment to nail it down.
 *
 * Asserted over module SOURCE rather than behaviour because behaviour cannot see
 * the absence of a thing: there is no test you can write against a writer that
 * does not exist yet. A source scan does see it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const SRC = join(process.cwd(), 'src');

/** The one module allowed to write the column, relative to `src/`. */
const THE_ONLY_WRITER = 'routes/admin-reviewers.ts';

/**
 * A Drizzle write that sets the ban columns — `.set({ … bannedAt … })` or
 * `.values({ … bannedAt … })`.
 *
 * Deliberately matches the Drizzle identifier (`bannedAt`), not the column name
 * (`banned_at`): the snake_case form appears legitimately in `db/schema.ts`, in
 * raw `sql` predicates that only READ, and in comments. The camelCase identifier
 * inside a `set`/`values` payload is what a write actually looks like here.
 */
const BAN_WRITE = /\.(set|values)\s*\(\s*\{[^}]*bannedAt/s;

/** Every `.ts` under `src/`, excluding specs, seeds and the schema itself. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.spec.ts')) continue;
    acc.push(full);
  }
  return acc;
}

describe('profiles.banned_at has exactly one writer', () => {
  const files = sourceFiles(SRC);

  it('finds a non-trivial number of source files (the scan is not vacuous)', () => {
    // Guards the guard: a broken walk would make every assertion below pass by
    // examining nothing, which is the failure mode of file-scanning tests.
    expect(files.length).toBeGreaterThan(50);
  });

  it(`only ${THE_ONLY_WRITER} writes the ban columns`, () => {
    const writers = files
      .filter((file) => BAN_WRITE.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(SRC.length + 1).replaceAll('\\', '/'));

    expect(writers).toEqual([THE_ONLY_WRITER]);
  });

  it('the admin users surface writes nothing at all', () => {
    // A read handler has no business calling `writeDb` (`lib/handler-utils.ts`),
    // which is what stamps the D1 `first-primary` constraint and the outbound
    // bookmark. Its absence is the cheap proof that both handlers are reads —
    // and reads emit no `audit_log` row (ADR 0022).
    const source = readFileSync(join(SRC, 'routes/admin-users.ts'), 'utf8');

    expect(source).not.toMatch(/\bwriteDb\b/);
    expect(source).not.toMatch(/\bauditInsert\b/);
    expect(source).not.toMatch(/db\.batch\(\[[^\]]*\.(insert|update|delete)\(/s);
  });
});
