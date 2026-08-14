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
  registryZod: 'The capability registry must import no zod',
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

  it('apps/web source carries the Angular guards AND both constraint tiers', () => {
    const messages = syntaxMessages('webSource');
    for (const fragment of [CONSTRAINT.inject, CONSTRAINT.emDash, ...ALL_TIER, ...SOURCE_TIER]) {
      expect(messages, `apps/web source is missing: ${fragment}`).toContain(fragment);
    }
  });

  it('apps/web tests keep the all-files tier but drop the value bans', () => {
    const messages = syntaxMessages('webTest');
    for (const fragment of [CONSTRAINT.inject, ...ALL_TIER]) {
      expect(messages, `apps/web spec is missing: ${fragment}`).toContain(fragment);
    }
    for (const fragment of [CONSTRAINT.emDash, ...SOURCE_TIER]) {
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
});
