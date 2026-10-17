/**
 * The structural invariant behind AECI-740's headline decision:
 * **a vendor seat can be created WITHOUT granting a license, and the two must never
 * be composed on the provisioning path.**
 *
 * This is an INVARIANT test — it encodes a decision, not behaviour, and must not
 * be deleted without reopening `docs/STAGE_2_SPEC.md` §8.9(2).
 *
 * ── WHY IT IS WORTH A TEST ───────────────────────────────────────────────────
 * `vendors.verified` is a denormalized mirror of a live license (`lib/license.ts`).
 * So *any* live license flips the public `verified` mirror, and "a seat but no
 * `verified`" is not expressible through the license table at all. §8.9(1) says a
 * pure connector vendor is **never** sold verification; §8.9(2) therefore fences its
 * seat off from the license writers entirely.
 *
 * The tempting edit is small and looks like a bug fix: `approveClaim` once composed
 * `grantSeatStatements` with an entitlement activator in one batch, so somebody
 * comparing the two seat paths would notice the provision route "forgets" the plan
 * and add it. Since AECI-1367 the claim grant writes no plan either (every approval
 * lands on Free), and the fence below covers it too. As built (AECI-1358,
 * 2026-10-17): the entitlement builders are deleted, so the fence now names the
 * license builders that replaced them. That change compiles, passes every behavioural
 * test that does not specifically look for the absence, and silently hands a
 * connector vendor the Managed plan the carve-out says they will never be sold —
 * through a one-way door, since withdrawing paid status costs more than never
 * granting it (§8.8(2)).
 *
 * Asserted over module SOURCE rather than behaviour for the same reason
 * `banned-at-writers.spec.ts` is: there is no test you can write against a
 * coupling that does not exist yet. A source scan sees it; behaviour cannot.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const SRC = join(process.cwd(), 'src');

/**
 * The modules allowed to write `profiles.role = 'vendor_admin'`, relative to
 * `src/`. Both are batch BUILDERS in `lib/`, never route handlers — the
 * house shape that keeps the statement list unit-testable without D1 and stops a
 * handler hand-rolling a seat write that skips the audit row (§26.1).
 *
 *  - `vendor-grant.ts` — the claim grant (AECI-519), the revoke (AECI-652) and,
 *    since AECI-740, the standalone provision.
 *  - `vendor-seat-invites.ts` — the invite redeem (AECI-664), which lands a
 *    NON-owner seat and is bounded by requiring an existing owner to send it.
 */
const ALLOWED_ROLE_WRITERS = ['lib/vendor-grant.ts', 'lib/vendor-seat-invites.ts'];

/** The `lib/license.ts` builders that can make a license live, and so flip
 *  `vendors.verified` (AECI-1358 retargeted the fence from the deleted entitlement
 *  builders to these). */
const LICENSE_WRITERS = [
  'grantLicensesStatements',
  'assignLicenseStatements',
  'setLicensesTermStatements',
];

/**
 * A Drizzle write that assigns the vendor-admin role — `.set({ … role: … })` or
 * `.values({ … role: … })` naming `VENDOR_ADMIN_ROLE` or the bare literal.
 *
 * Matches the payload, not the identifier alone: `VENDOR_ADMIN_ROLE` appears
 * legitimately all over the codebase in `WHERE` predicates that only READ (the
 * seat roster, `seatsOf`, `requireSeatOwner`), and flagging those would make the
 * test useless. What a write looks like is the constant inside a `set`/`values`
 * object.
 */
const ROLE_WRITE = /\.(set|values)\s*\(\s*\{[^}]*role:\s*(VENDOR_ADMIN_ROLE|'vendor_admin')/s;

/** Every `.ts` under `src/`, excluding specs and the test harness. */
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

const rel = (file: string) => file.slice(SRC.length + 1).replaceAll('\\', '/');

/**
 * Strip block and line comments before scanning.
 *
 * Not optional here, and the reason is specific: the modules this test polices
 * are the ones whose DOCBLOCKS explain the coupling — `vendor-grant.ts`'s header
 * describes the AECI-612 split, and `createProvisionSeatHandler`'s says in so
 * many words that it must never import a plan writer. A raw
 * substring scan fails on exactly the files that document the invariant best,
 * which would train the next person to delete the explanation rather than keep
 * the property. Scan the code; leave the prose alone.
 */
function code(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');
}

/** A real use of a symbol: an ES import binding or a call. Never a mention. */
function uses(source: string, symbol: string): boolean {
  const body = code(source);
  return (
    new RegExp(`\\b${symbol}\\s*\\(`).test(body) ||
    new RegExp(`import[^;]*\\b${symbol}\\b[^;]*from`, 's').test(body)
  );
}

describe('the vendor_admin seat is not coupled to a license (STAGE_2_SPEC §8.9(2))', () => {
  const files = sourceFiles(SRC);

  it('finds a non-trivial number of source files (the scan is not vacuous)', () => {
    // Guards the guard: a broken walk would make every assertion below pass by
    // examining nothing, which is the failure mode of file-scanning tests.
    expect(files.length).toBeGreaterThan(50);
  });

  it('only the two lib builders write role = vendor_admin', () => {
    const writers = files
      .filter((f) => ROLE_WRITE.test(code(readFileSync(f, 'utf8'))))
      .map(rel)
      .sort();

    expect(writers).toEqual([...ALLOWED_ROLE_WRITERS].sort());
  });

  it('the claim grant uses no license writer (AECI-1367: every approval lands on Free)', () => {
    // `approveClaim` used to compose an entitlement activator into the grant batch on a
    // Managed approve. AECI-1367 removed the plan choice: the grant is the seat, the
    // billing account and the acceptance link. Managed is bought later as licenses.
    // Granting one here would hand out paid status on approval again, through the
    // one-way door §8.8(2) describes.
    const source = readFileSync(join(SRC, 'routes/admin-claims.ts'), 'utf8');

    for (const writer of LICENSE_WRITERS) expect(uses(source, writer), writer).toBe(false);
    expect(code(source)).not.toMatch(/\.(set|values)\s*\(\s*\{[^}]*verified:/s);
  });

  it('no module composes provisionSeatStatements with a license writer', () => {
    // THE fence. What must never exist is a module holding the standalone provision
    // beside a license writer, because that is the composition that turns a
    // catalogue-maintenance seat into a verified account.
    const coupled = files
      .filter((f) => {
        const source = readFileSync(f, 'utf8');
        return (
          uses(source, 'provisionSeatStatements') &&
          LICENSE_WRITERS.some((writer) => uses(source, writer))
        );
      })
      .map(rel);

    expect(coupled).toEqual([]);
  });

  it('the provisioning route uses no license writer at all', () => {
    // Belt to the braces above, and the more readable failure: it names the file
    // an editor is actually looking at rather than a set difference.
    const source = readFileSync(join(SRC, 'routes/admin-vendors.ts'), 'utf8');

    for (const writer of LICENSE_WRITERS) expect(uses(source, writer), writer).toBe(false);
    // And it must not reach `vendors.verified` by hand either. The mirror has a
    // sole writer (`lib/license.ts`) and an ESLint guard, but the guard is scoped
    // to `.set`/`.values` payloads and this states the intent.
    expect(code(source)).not.toMatch(/\.(set|values)\s*\(\s*\{[^}]*verified:/s);
  });
});
