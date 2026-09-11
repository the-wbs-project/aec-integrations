import { ESLint, Linter } from 'eslint';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * AECI-549 — the ESLint config is itself product surface, so it gets a test.
 *
 * Two things are being protected:
 *
 *  1. **The flat-config restate trap.** Flat config *replaces* a rule's options
 *     per file rather than merging them. `apps/web` spreads `angularBase` after
 *     `tsBase`, so `angularBase`'s TypeScript blocks silently drop every selector
 *     `tsBase` set unless they restate the full list. A dropped selector is
 *     invisible: lint still passes, the constraint just stops being enforced.
 *     The first describe() below asserts the *resolved* config for real files in
 *     both packages and in both tiers.
 *
 *  2. **The rules actually fire.** The second describe() feeds deliberate
 *     violations through the resolved options, plus the near-misses that must
 *     NOT fire — the permitted `Vary: Accept-Language`, prose containing
 *     "dark:", and an ordinary `@angular/core` import.
 *
 * Both groups read their options from `ESLint.calculateConfigForFile()` rather
 * than importing the constants from `eslint.config.base.mjs`. That matters:
 * importing them would make the test vacuous, because deleting a rule would
 * delete its own expectation too.
 *
 * Fixtures are strings, never live code, so this file does not trip the rules it
 * tests. The Prisma env-var selectors are `^…$`-anchored precisely so a fixture
 * *line* mentioning a connection var cannot match.
 */

// Vitest runs with cwd = apps/web (see vitest.config.ts).
const WEB = process.cwd();
const REPO_ROOT = join(WEB, '..', '..');
const API = join(REPO_ROOT, 'apps', 'api');
const SHARED = join(REPO_ROOT, 'packages', 'shared');

/**
 * A representative real file for each (package × tier) combination, plus the
 * two `packages/shared` files that sit on either side of the AECI-610
 * file-scoped zod ban.
 */
const FIXTURE_FILES = {
  webSource: { cwd: WEB, file: join(WEB, 'src/app/home/home-hero.ts') },
  webTest: { cwd: WEB, file: join(WEB, 'src/server/seo-headers.spec.ts') },
  apiSource: { cwd: API, file: join(API, 'src/index.ts') },
  apiTest: { cwd: API, file: join(API, 'src/routes/vendors.spec.ts') },
  // AECI-609 sole-writer tier: the one permanent exempt file, the file whose
  // TEMPORARY carve-out AECI-612 removed, and a neighbouring lib — so the exemption is
  // proven to be exactly ONE file, not "anything under lib/".
  apiMirrorWriter: { cwd: API, file: join(API, 'src/lib/vendor-entitlement.ts') },
  apiMirrorFormerBaseline: { cwd: API, file: join(API, 'src/lib/vendor-grant.ts') },
  apiMirrorNeighbour: { cwd: API, file: join(API, 'src/lib/vendor-cache-tags.ts') },
  /** The capability registry — the one file that may not import zod. */
  sharedRegistry: { cwd: SHARED, file: join(SHARED, 'src/entitlements.ts') },
  /** Its wire-contract sibling — zod is exactly where it belongs. */
  sharedWireContract: { cwd: SHARED, file: join(SHARED, 'src/api/admin-entitlements.ts') },
} as const;

type Target = keyof typeof FIXTURE_FILES;

/**
 * Each constraint family, identified by a stable fragment of its message. Using
 * the message rather than the selector keeps the assertions readable and
 * survives selector tuning that preserves intent.
 */
const CONSTRAINT = {
  inject: 'Call inject() at field initialization',
  emDash: 'No em dashes',
  prisma: 'No Prisma.',
  pgVars: 'No Postgres connection vars',
  darkVariant: 'No `dark:` variants',
  themeDark: 'No `.theme-dark` block',
  vary: 'Only `Vary: Accept-Language` is permitted',
  mirror: 'is a denormalized mirror of',
  registryZod: 'The capability registry must import no zod',
  // AECI-597. All four share a prefix, so each is identified by its
  // parenthetical suffix — that is what makes "the palette rule survived but the
  // hex rule was dropped" a detectable regression rather than a silent one.
  colorHex: '(hex literal)',
  colorFunction: '(rgb/hsl/oklch',
  colorPalette: '(raw Tailwind palette class)',
  colorNamed: '(named color class',
} as const;

/** Only the two core rules — a bare Linter cannot resolve plugin rules. */
type CoreRules = Partial<Linter.RulesRecord>;

const resolved: Record<Target, CoreRules> = {} as Record<Target, CoreRules>;

beforeAll(async () => {
  for (const [name, { cwd, file }] of Object.entries(FIXTURE_FILES)) {
    const config = await new ESLint({ cwd }).calculateConfigForFile(file);
    const rules = (config.rules ?? {}) as Linter.RulesRecord;
    resolved[name as Target] = {
      'no-restricted-syntax': rules['no-restricted-syntax'],
      'no-restricted-imports': rules['no-restricted-imports'],
    };
  }
});

/** The `message` of every active `no-restricted-syntax` selector, joined. */
function syntaxMessages(target: Target): string {
  const entry = resolved[target]['no-restricted-syntax'];
  const options = Array.isArray(entry) ? entry.slice(1) : [];
  return options
    .map((o) => (typeof o === 'string' ? o : ((o as { message?: string }).message ?? '')))
    .join('\n');
}

function lint(target: Target, code: string): string[] {
  const linter = new Linter();
  return linter
    .verify(code, {
      languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
      rules: resolved[target] as Linter.RulesRecord,
    })
    .map((m) => m.message);
}

describe('resolved ESLint config — constraint coverage per package and tier', () => {
  // The all-files tier bans a *dependency*, so it applies to tests too.
  const ALL_TIER = [CONSTRAINT.prisma, CONSTRAINT.pgVars];
  // The source-only tier bans a *value*, which tests legitimately build as a
  // fixture (seo-headers.spec.ts constructs `Vary: Cookie` upstream responses
  // in order to assert the middleware strips them).
  const SOURCE_TIER = [CONSTRAINT.darkVariant, CONSTRAINT.themeDark, CONSTRAINT.vary];
  // AECI-597 colours live in `angularBase`, not in a `tsBase` tier, so they are
  // apps/web-only BY CONSTRUCTION. Kept as a separate list because that scoping
  // is a decision, not an accident: `apps/api` holds 13 hex literals in
  // transactional email HTML that are CORRECT (email clients do not support CSS
  // custom properties), and `apps/datatool` holds 28 more in an internal ops
  // Worker with no design system. Moving these into CONSTRAINT_SYNTAX_SOURCE_ONLY
  // would need 41 exemptions on day one; the `apiSource` assertion below is what
  // fails if someone tries.
  const WEB_COLOR_TIER = [
    CONSTRAINT.colorHex,
    CONSTRAINT.colorFunction,
    CONSTRAINT.colorPalette,
    CONSTRAINT.colorNamed,
  ];

  it('apps/web source carries the Angular guards AND both constraint tiers', () => {
    const messages = syntaxMessages('webSource');
    for (const fragment of [
      CONSTRAINT.inject,
      CONSTRAINT.emDash,
      ...ALL_TIER,
      ...SOURCE_TIER,
      ...WEB_COLOR_TIER,
    ]) {
      expect(messages, `apps/web source is missing: ${fragment}`).toContain(fragment);
    }
  });

  it('apps/web tests keep the all-files tier but drop the value bans', () => {
    const messages = syntaxMessages('webTest');
    for (const fragment of [CONSTRAINT.inject, ...ALL_TIER]) {
      expect(messages, `apps/web spec is missing: ${fragment}`).toContain(fragment);
    }
    for (const fragment of [CONSTRAINT.emDash, ...SOURCE_TIER, ...WEB_COLOR_TIER]) {
      expect(messages, `apps/web spec should exempt: ${fragment}`).not.toContain(fragment);
    }
  });

  it('apps/api source carries both constraint tiers without the Angular guards', () => {
    const messages = syntaxMessages('apiSource');
    for (const fragment of [...ALL_TIER, ...SOURCE_TIER]) {
      expect(messages, `apps/api source is missing: ${fragment}`).toContain(fragment);
    }
    expect(messages).not.toContain(CONSTRAINT.inject);
  });

  it('the colour rules are apps/web only — apps/api email HTML is legitimately hex', () => {
    const messages = syntaxMessages('apiSource');
    for (const fragment of WEB_COLOR_TIER) {
      expect(messages, `apps/api should not carry: ${fragment}`).not.toContain(fragment);
    }
    expect(syntaxMessages('sharedRegistry')).not.toContain(CONSTRAINT.colorHex);
  });

  it('apps/api tests keep the all-files tier but drop the value bans', () => {
    const messages = syntaxMessages('apiTest');
    for (const fragment of ALL_TIER) {
      expect(messages, `apps/api spec is missing: ${fragment}`).toContain(fragment);
    }
    for (const fragment of SOURCE_TIER) {
      expect(messages, `apps/api spec should exempt: ${fragment}`).not.toContain(fragment);
    }
  });

  it('every package resolves the restricted-import ban', () => {
    for (const target of Object.keys(FIXTURE_FILES) as Target[]) {
      expect(
        resolved[target]['no-restricted-imports'],
        `${target} is missing no-restricted-imports`,
      ).toBeDefined();
    }
  });

  // ── AECI-609 Guard 1: the `vendors.verified` sole-writer tier ────────────────

  it('the mirror sole-writer rule reaches apps/api AND apps/web source', () => {
    // apps/web has no Drizzle, but angularBase REPLACES the rule per file, so what is
    // actually being asserted for webSource is that the restate did not drop it.
    expect(syntaxMessages('apiSource')).toContain(CONSTRAINT.mirror);
    expect(syntaxMessages('webSource')).toContain(CONSTRAINT.mirror);
  });

  it('tests are exempt from the mirror rule (they seed verified rows as fixtures)', () => {
    expect(syntaxMessages('apiTest')).not.toContain(CONSTRAINT.mirror);
    expect(syntaxMessages('webTest')).not.toContain(CONSTRAINT.mirror);
  });

  it('lib/vendor-entitlement.ts is exempt from the mirror rule but keeps both other tiers', () => {
    const messages = syntaxMessages('apiMirrorWriter');
    expect(messages).not.toContain(CONSTRAINT.mirror);
    // The flat-config trap: an `ignores` on the wrong block would drop these too.
    for (const fragment of [...ALL_TIER, ...SOURCE_TIER]) {
      expect(messages, `the sole-writer file lost: ${fragment}`).toContain(fragment);
    }
  });

  it('lib/vendor-grant.ts LOST its temporary exemption once AECI-612 landed', () => {
    // AECI-609 carved vendor-grant.ts out because it still emitted the `verified`
    // flip. AECI-612 (§6 step 1) deleted that statement and composed
    // `activateEntitlementStatements` into the same batch instead, so the carve-out
    // was removed. Asserting the rule is now ACTIVE here — rather than deleting the
    // case — is what stops the flip being reintroduced under a stale exemption.
    expect(syntaxMessages('apiMirrorFormerBaseline')).toContain(CONSTRAINT.mirror);
  });

  it('the exemption is exactly one file — a neighbouring lib still carries the rule', () => {
    expect(syntaxMessages('apiMirrorNeighbour')).toContain(CONSTRAINT.mirror);
  });
});

describe('constraint rules fire on deliberate violations', () => {
  it('rejects `dark:` variants, including stacked ones', () => {
    expect(lint('webSource', 'const c = "p-4 dark:bg-black";').join()).toContain(
      CONSTRAINT.darkVariant,
    );
    expect(lint('webSource', 'const c = "md:dark:hidden";').join()).toContain(
      CONSTRAINT.darkVariant,
    );
    expect(
      lint('webSource', 'const c = `<b class="dark:(--surface-base)"></b>`;').join(),
    ).toContain(CONSTRAINT.darkVariant);
  });

  it('rejects a `.theme-dark` block', () => {
    expect(lint('webSource', 'const css = ".theme-dark { color: red }";').join()).toContain(
      CONSTRAINT.themeDark,
    );
  });

  it('rejects a forbidden Vary value in every form', () => {
    expect(lint('apiSource', 'h.set("Vary", "Cookie");').join()).toContain(CONSTRAINT.vary);
    expect(lint('apiSource', 'h.append("vary", "User-Agent");').join()).toContain(CONSTRAINT.vary);
    expect(lint('apiSource', 'const h = new Headers({ vary: "Cookie" });').join()).toContain(
      CONSTRAINT.vary,
    );
  });

  it('rejects Prisma, pg adapters and zone.js imports', () => {
    expect(
      lint('apiSource', 'import { PrismaClient } from "@prisma/client";').length,
    ).toBeGreaterThan(0);
    expect(
      lint('apiSource', 'import { drizzle } from "drizzle-orm/node-postgres";').length,
    ).toBeGreaterThan(0);
    expect(lint('webSource', 'import "zone.js";').length).toBeGreaterThan(0);
    expect(lint('webSource', 'import { NgZone } from "@angular/core";').length).toBeGreaterThan(0);
  });

  it('rejects Prisma identifiers and Postgres connection vars', () => {
    expect(lint('apiSource', 'const db = getPrisma(env);').join()).toContain(CONSTRAINT.prisma);
    expect(lint('apiSource', 'const u = env.DATABASE_URL;').join()).toContain(CONSTRAINT.pgVars);
    expect(lint('apiSource', 'const d = env.DIRECT_URL;').join()).toContain(CONSTRAINT.pgVars);
  });

  it('enforces the dependency bans inside tests too', () => {
    expect(
      lint('apiTest', 'import { PrismaClient } from "@prisma/client";').length,
    ).toBeGreaterThan(0);
    expect(lint('apiTest', 'const db = getPrisma(env);').join()).toContain(CONSTRAINT.prisma);
  });

  it('rejects a direct write to vendors.verified, via UPDATE or INSERT', () => {
    expect(
      lint('apiSource', 'db.update(vendors).set({ verified: true, updatedAt: now });').join(),
    ).toContain(CONSTRAINT.mirror);
    expect(
      lint('apiSource', 'db.insert(vendors).values({ id, slug, verified: true });').join(),
    ).toContain(CONSTRAINT.mirror);
  });

  // ── AECI-597: colour literals ───────────────────────────────────────────────
  // These run through the REAL resolved config, which is what proves the
  // esquery selectors parse — the patterns carry lookaheads, a lookbehind, and
  // an escaped `/`, any of which could be mangled on the way into a selector
  // string and would otherwise fail silently as a rule that never matches.

  it('rejects hex colours in strings and in inline templates', () => {
    expect(lint('webSource', 'const c = "color: #1E3A2F";').join()).toContain(CONSTRAINT.colorHex);
    expect(lint('webSource', 'const c = "#fff";').join()).toContain(CONSTRAINT.colorHex);
    expect(lint('webSource', 'const t = `<svg fill="#EA4335"></svg>`;').join()).toContain(
      CONSTRAINT.colorHex,
    );
    // Eight-digit #RRGGBBAA is in scope; four-digit #RGBA deliberately is not.
    expect(lint('webSource', 'const c = "#1E3A2FCC";').join()).toContain(CONSTRAINT.colorHex);
  });

  it('rejects rgb/hsl/oklch that is not pure black', () => {
    expect(lint('webSource', 'const c = "color: rgb(255 0 0)";').join()).toContain(
      CONSTRAINT.colorFunction,
    );
    expect(lint('webSource', 'const c = "oklch(31.92% 0.0436 152.32)";').join()).toContain(
      CONSTRAINT.colorFunction,
    );
    expect(lint('webSource', 'const c = "hsl(210 40% 50%)";').join()).toContain(
      CONSTRAINT.colorFunction,
    );
    // The Tailwind arbitrary-value form, where spaces are underscores. This is
    // the case a `\b` anchor would have missed: the preceding `_` is a word
    // character, so the rule would have silently exempted every arbitrary shadow.
    expect(lint('webSource', 'const c = "shadow-[0_4px_8px_rgb(255_0_0)]";').join()).toContain(
      CONSTRAINT.colorFunction,
    );
  });

  it('rejects raw Tailwind palette classes and named colour classes', () => {
    expect(lint('webSource', 'const c = "p-4 bg-zinc-100";').join()).toContain(
      CONSTRAINT.colorPalette,
    );
    expect(lint('webSource', 'const c = "hover:text-slate-500";').join()).toContain(
      CONSTRAINT.colorPalette,
    );
    expect(lint('webSource', 'const c = "border-gray-200 ring-red-950";').join()).toContain(
      CONSTRAINT.colorPalette,
    );
    expect(lint('webSource', 'const c = "bg-(--accent-primary) text-white";').join()).toContain(
      CONSTRAINT.colorNamed,
    );
    // The opacity-modifier form stays in scope — `/` is not in the trailing guard.
    expect(lint('webSource', 'const c = "text-white/80";').join()).toContain(CONSTRAINT.colorNamed);
  });
});

describe('the capability registry is zod-free by lint (AECI-610)', () => {
  // packages/shared/eslint.config.mjs scopes this to ONE file. The bundle
  // constraint it protects (STAGE_2_PAID_TIERS_SPEC.md §10 R11) is invisible at
  // runtime — nothing fails, the Angular initial graph just grows a 327 kB zod
  // chunk again — so the lint rule is the only feedback there is.

  it('rejects zod, and any hop through api/* that would reintroduce it', () => {
    expect(lint('sharedRegistry', 'import { z } from "zod";').join()).toContain(
      CONSTRAINT.registryZod,
    );
    expect(
      lint('sharedRegistry', 'import { PageQuerySchema } from "./api/common";').join(),
    ).toContain(CONSTRAINT.registryZod);
    expect(
      lint('sharedRegistry', 'import { VendorSchema } from "@aeci/shared/api";').join(),
    ).toContain(CONSTRAINT.registryZod);
  });

  it('keeps the shared constraint bans through the flat-config restate', () => {
    // The file-scoped block sets `no-restricted-imports`, which REPLACES rather
    // than merges. If it ever stops spreading CONSTRAINT_IMPORTS, these are the
    // bans that vanish — silently, on the one file with the strictest rules.
    expect(
      lint('sharedRegistry', 'import { PrismaClient } from "@prisma/client";').length,
    ).toBeGreaterThan(0);
    expect(lint('sharedRegistry', 'import "zone.js";').length).toBeGreaterThan(0);
  });

  it('bans zod on the registry only, not across packages/shared', () => {
    // The whole design is a registry/wire-contract split: if the ban leaked to
    // the package it would make `api/*` unwritable and the split pointless.
    expect(lint('sharedWireContract', 'import { z } from "zod";')).toEqual([]);
    expect(lint('sharedWireContract', 'import { TIERS } from "../entitlements";')).toEqual([]);
  });

  it('permits the registry its own legitimate imports (it has none today)', () => {
    expect(lint('sharedRegistry', 'import { INDEX_ENTITIES } from "./algolia";')).toEqual([]);
  });
});

describe('constraint rules do not fire on legitimate code', () => {
  it('permits Vary: Accept-Language', () => {
    expect(lint('apiSource', 'h.set("Vary", "Accept-Language");')).toEqual([]);
    expect(lint('apiSource', 'const h = new Headers({ vary: "Accept-Language" });')).toEqual([]);
  });

  it('permits prose that merely contains the word dark', () => {
    expect(lint('webSource', 'const s = "light and dark: themes";')).toEqual([]);
    expect(lint('webSource', 'const s = "the dark theme was removed";')).toEqual([]);
  });

  it('permits ordinary @angular/core and drizzle-orm/d1 imports', () => {
    expect(lint('webSource', 'import { Component, inject } from "@angular/core";')).toEqual([]);
    expect(lint('apiSource', 'import { drizzle } from "drizzle-orm/d1";')).toEqual([]);
  });

  it('lets tests build a forbidden Vary fixture, which is why seo-headers.spec.ts is clean', () => {
    expect(lint('webTest', 'const h = new Headers({ vary: "Cookie" });')).toEqual([]);
    expect(lint('webTest', 'h.append("vary", "User-Agent");')).toEqual([]);
  });

  it('permits `verified` in read projections, spread column vars, and other tables', () => {
    // Every one of these is a real shape in the tree today; the mirror selector is
    // anchored to the `.update(vendors).set({...})` chain precisely so they stay clean.
    expect(
      lint('apiSource', 'const cfg = { columns: { id: true, slug: true, verified: true } };'),
    ).toEqual([]);
    expect(
      lint('apiSource', 'db.update(vendors).set(writeColumns).where(eq(vendors.id, id));'),
    ).toEqual([]);
    expect(
      lint('apiSource', 'db.update(vendors).set({ companyName: n, promotionStatus: "promoted" });'),
    ).toEqual([]);
    expect(lint('apiSource', 'db.update(profiles).set({ verified: true });')).toEqual([]);
  });

  it('permits an Angular signal .set({ … }) that happens to carry a verified key', () => {
    expect(lint('webSource', 'this.model.set({ verified: true });')).toEqual([]);
  });

  it('lets the sole writer write the mirror', () => {
    expect(
      lint('apiMirrorWriter', 'db.update(vendors).set({ verified: true, updatedAt: now });'),
    ).toEqual([]);
  });

  // ── AECI-597: the near-misses that deferred this rule for a year ────────────
  // Every string below is lifted from the tree as it stood when the rule landed.
  // They are the reason AECI-549 recorded the rule as "feasible but not yet
  // false-positive-free"; each one is now defeated by a specific guard.

  it('permits id selectors whose name happens to be hex — the `#aec-` namespace', () => {
    // `a`, `e` and `c` are all hex digits and every id in this app is namespaced
    // `aec-`, so `#aec` matches any word-boundary pattern. The trailing
    // `(?![0-9a-zA-Z_-])` guard is what rejects it.
    expect(lint('webSource', 'const el = root.querySelector("#aec-facet-panel");')).toEqual([]);
    expect(lint('webSource', 'const el = root.querySelector("#aec-user-menu-pending");')).toEqual(
      [],
    );
  });

  it('permits four-digit references — purchase orders, issues, PRs', () => {
    // Dropping the `#RGBA` branch is what makes this work: the three-digit branch
    // tries `#447`, and the guard rejects it because `1` is itself a hex digit.
    expect(lint('webSource', 'const n = { notes: "PO #4471, USD 5k/yr" };')).toEqual([]);
    expect(lint('webSource', 'const s = "drizzle-team/drizzle-orm #2226 and #4522";')).toEqual([]);
  });

  it('permits HTML numeric entities', () => {
    // `&#10003;` is the checkmark used in vendor-products-menu.ts. `#100` is
    // followed by `0`, a hex digit, so no branch can complete.
    expect(lint('webSource', 'const t = `<span aria-hidden="true">&#10003;</span>`;')).toEqual([]);
    // The three-digit ones need the leading `(?<!&)` guard instead: the trailing
    // guard excludes hex digits but not `;`, so `#160` completes on its own.
    expect(lint('webSource', 'const t = `<span>10&#160;&#215;&#160;4&#169;</span>`;')).toEqual([]);
  });

  it('permits the DESIGN.md pure-black shadow recipe in both spellings', () => {
    // DESIGN.md §Shadows specifies rgb(0 0 0 / a) as the canonical dialog shadow.
    // Underscore form is what Tailwind arbitrary values actually ship.
    expect(lint('webSource', 'const c = "background-color: rgb(0 0 0 / 0.5)";')).toEqual([]);
    expect(
      lint(
        'webSource',
        'const c = "shadow-[0_16px_48px_-8px_rgb(0_0_0/0.18),0_4px_16px_-2px_rgb(0_0_0/0.10)]";',
      ),
    ).toEqual([]);
  });

  it('permits the sanctioned token vocabulary and the transparent keywords', () => {
    expect(lint('webSource', 'const c = "bg-(--surface-raised) text-(--text-secondary)";')).toEqual(
      [],
    );
    expect(lint('webSource', 'const c = "text-(--surface-base)/80";')).toEqual([]);
    expect(lint('webSource', 'const c = "border border-transparent bg-transparent";')).toEqual([]);
    expect(lint('webSource', 'const t = `<svg stroke="currentColor" fill="none"></svg>`;')).toEqual(
      [],
    );
    // Non-colour utilities that share a prefix with a banned one.
    expect(lint('webSource', 'const c = "text-3xl outline-2 rounded-(--radius-sm)";')).toEqual([]);
    expect(lint('webSource', 'const t = `<a href="#main">Skip</a>`;')).toEqual([]);
  });

  it('lets tests assert a colour literal, which is why login.component.spec.ts is clean', () => {
    // That spec pins the four Google brand fills; recolouring the mark to
    // currentColor would breach the Sign-in-with-Google branding guidelines.
    expect(lint('webTest', 'const fills = ["#EA4335", "#4285F4"];')).toEqual([]);
    expect(lint('webTest', 'const c = "bg-zinc-100 text-white";')).toEqual([]);
  });
});
