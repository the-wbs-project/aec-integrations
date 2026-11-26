import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1769): every `<aec-logo-or-initial>` caller is classified, so no caller can
 * show an unclaimed listing's logo off its own page by accident (ADR 0059 floor 3,
 * counsel's ruling 9).
 *
 * `claimStatus` is a required input (AECI-1851), so every tag passes it. The kind decides
 * the value:
 *
 * - `subject`: the payload is a page subject (`ProductDetail`, `VendorDetail`,
 *   `ProductPairSubject`). It keeps the real logo, so the tag binds the payload's
 *   `claim_status`.
 * - `link`: a public list, link or search payload. The API withholds an unclaimed
 *   listing's logo there (AECI-1618) and fails closed (AECI-1851), so the tag passes
 *   `'server-filtered'`.
 * - `portal` and `admin`: ADR 0051 decision 4, "Portal and admin reads keep the real
 *   value." A vendor sees its own logo. The tag passes `'stored'`.
 * - `person`: the account avatar. Not a listing. The tag passes `'stored'`.
 * - `preview`: a dev-only fixture route. The tag passes `'stored'`.
 * - `group`: `integration-group-card` forwards the `claimStatus` its parent put in the
 *   required `GroupCardLogo`. Its parents are classified as `link` below.
 * - `wheel`: the product hero's integrations wheel and its card (AECI-2018). Ruling 64
 *   (2026-11-24) shows a product's logo there whenever we hold one, claimed or not, from
 *   the wheel's own `wheel_marks`. It widens the rule for the wheel only, so the tag
 *   passes `'wheel'`, and only the wheel's file may.
 *
 * A new caller, or a new tag in a listed file, fails here until it is classified.
 */
const APP = join(process.cwd(), 'src/app');

type Kind = 'subject' | 'link' | 'portal' | 'admin' | 'person' | 'preview' | 'group' | 'wheel';

/** The `claimStatus` binding each kind must carry. */
const BINDING: Record<Kind, RegExp> = {
  subject: /\[claimStatus\]="[\w.]+\.claim_status"/,
  link: /\[claimStatus\]="'server-filtered'"/,
  portal: /\[claimStatus\]="'stored'"/,
  admin: /\[claimStatus\]="'stored'"/,
  person: /\[claimStatus\]="'stored'"/,
  preview: /\[claimStatus\]="'stored'"/,
  group: /\[claimStatus\]="mark\.claimStatus"/,
  wheel: /\[claimStatus\]="'wheel'"/,
};

/** The one file that may pass `'wheel'` (ruling 64 widens the rule for the wheel only). */
const WHEEL_FILE = 'products/product-integration-wheel.ts';

/** Where `'stored'` may appear: portal, admin, the avatar and the preview fixtures. */
const STORED_ALLOWED = /^(vendor|admin|preview)\/|^layout\/account-identity\.ts$/;

/** The parents of `integration-group-card` and the `[logo]` bindings each makes. */
const GROUP_PARENTS: Record<string, number> = {
  'products/product-integrations-section.ts': 1,
  'products/product-powered-hub.ts': 1,
};

const CALLERS: Record<string, Partial<Record<Kind, number>>> = {
  'admin/requests/product-request-queue.ts': { admin: 1 },
  'admin/vendors/vendor-detail.html': { admin: 1 },
  'layout/account-identity.ts': { person: 1 },
  'preview/integration-pair/concept-flow-canvas.ts': { preview: 2 },
  'products/integration-group-card.ts': { group: 1 },
  // AECI-1827, AECI-1835: the empty pair body's marks, each by its subject's own
  // claim_status: the ledger head, a single-product chip's mark (one per side) and the
  // vendor card head. A chip both products carry says "Both" and has no mark. An
  // unclaimed product is its initial tile in all of them.
  // AECI-1829 / AECI-1830: the pair's own two products (moving groups, keep toggle) by
  // their claim_status, and each match card from the server-filtered ProductLink.
  'products/pair-empty-alternatives.ts': { subject: 2, link: 1 },
  'products/pair-empty-sections.ts': { subject: 4 },
  // AECI-1835: the empty pair hero's two cards: the 64px mark, and the 32px sourced logo
  // beside the Unclaimed note.
  'products/pair-empty-stage.ts': { subject: 2 },
  'products/product-card-grid.ts': { link: 2 },
  'products/product-card.ts': { link: 1 },
  'products/product-facts-card.ts': { link: 1 },
  'products/product-hero.ts': { subject: 2 },
  // AECI-2018: each tile, the card and the centre (ruling 64).
  'products/product-integration-wheel.ts': { wheel: 3 },
  'products/product-extensions.ts': { link: 2 },
  'products/product-integration-row.ts': { link: 1 },
  // AECI-1782: the card view of the same row, the same server-filtered ProductLink.
  'products/product-integration-card.ts': { link: 1 },
  // AECI-1783: the "Show more" stack names hidden partners, the same ProductLinks.
  // AECI-1720: the "Show more" stack is drawn twice, once per width (phone and md up).
  'products/product-integration-category-group.ts': { link: 2 },
  'products/product-powered-hub.ts': { link: 3 },
  // AECI-1924: the hub tables, the same powered-pair payload as the hub's cards.
  'products/product-powered-table.ts': { link: 1 },
  // AECI-1798: one loop renders both sides, each with its 64px mark and its 32px mark.
  'products/products-pair.ts': { subject: 2 },
  'reviews/review-form.html': { subject: 1 },
  'search/search-product-card.ts': { link: 1 },
  'search/search-vendor-card.ts': { link: 1 },
  'search/search-vendor-row.ts': { link: 1 },
  // Portal and admin pickers call the public `GET /api/products`, so it is a link.
  'shared/product-combobox/product-combobox.ts': { link: 1 },
  'vendor/components/vendor-integration-create.ts': { portal: 2 },
  'vendor/components/vendor-integrations-section.ts': { portal: 2 },
  'vendor/components/vendor-product-connectors.ts': { portal: 1 },
  // AECI-2040: the chosen card on each side of a Sync Service's new pair. Like the
  // counterpart card in vendor-integration-create, its logo comes from the combobox's
  // public `GET /api/products` search, which already withholds an unclaimed logo.
  'vendor/components/vendor-sync-service-pair-create.ts': { portal: 1 },
  'vendor/integration-detail/vendor-integration-detail-page.ts': { portal: 4 },
  'vendor/sections/vendor-product-list-page.ts': { portal: 1 },
  // AECI-1809: the portal header's 48px tile beside the h1.
  'vendor/vendor-dashboard-tabbed.ts': { portal: 1 },
  'vendors/vendor-detail.ts': { subject: 2 },
  'vendors/vendor-product-row.ts': { link: 1 },
};

const SELF = 'shared/logo-or-initial/logo-or-initial.ts';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

interface Tag {
  text: string;
  end: number;
}

function tags(source: string): Tag[] {
  const out: Tag[] = [];
  const re = /<aec-logo-or-initial\b[\s\S]*?\/>/g;
  for (const m of source.matchAll(re)) out.push({ text: m[0], end: m.index! + m[0].length });
  return out;
}

const sources = new Map(
  walk(APP)
    .map((path) => [relative(APP, path), readFileSync(path, 'utf8')] as const)
    .filter(([rel, text]) => rel !== SELF && text.includes('<aec-logo-or-initial')),
);

describe('aec-logo-or-initial callers (AECI-1769)', () => {
  it('every caller file is classified', () => {
    expect([...sources.keys()].sort()).toEqual(Object.keys(CALLERS).sort());
  });

  it.each(Object.entries(CALLERS))('%s has the classified tags', (file, kinds) => {
    const found = tags(sources.get(file) ?? '');
    const total = Object.values(kinds).reduce((sum, n) => sum + n, 0);
    expect(found).toHaveLength(total);
    // Every tag binds `claimStatus` exactly once, with the value its kind allows. Kinds
    // that share a value (portal, admin, person and preview all pass 'stored') are
    // counted together.
    for (const tag of found) {
      expect(tag.text.match(/\[claimStatus\]=/g), `${file}: ${tag.text}`).toHaveLength(1);
    }
    const expected = new Map<string, number>();
    for (const [kind, n] of Object.entries(kinds) as Array<[Kind, number]>) {
      const key = BINDING[kind].source;
      expected.set(key, (expected.get(key) ?? 0) + n);
    }
    for (const [source, n] of expected) {
      const matching = found.filter((tag) => new RegExp(source).test(tag.text));
      expect(matching, `${file}: ${source}`).toHaveLength(n);
    }
  });

  it("passes 'stored' only on portal, admin, avatar and preview surfaces", () => {
    for (const [file, source] of sources) {
      if (STORED_ALLOWED.test(file)) continue;
      for (const tag of tags(source)) expect(tag.text, file).not.toContain("'stored'");
    }
  });

  it("passes 'wheel' only in the integrations wheel (ruling 64)", () => {
    let seen = 0;
    for (const [file, source] of sources) {
      for (const tag of tags(source)) {
        if (!tag.text.includes("'wheel'")) continue;
        seen++;
        expect(file).toBe(WHEEL_FILE);
      }
    }
    expect(seen).toBe(3);
  });

  it("integration-group-card's parents pass 'server-filtered' in the logo they hand over", () => {
    const files = walk(APP)
      .map((path) => [relative(APP, path), readFileSync(path, 'utf8')] as const)
      .filter(
        ([, text]) => /\[logo\]="/.test(text) && text.includes('<aec-integration-group-card'),
      );
    expect(files.map(([rel]) => rel).sort()).toEqual(Object.keys(GROUP_PARENTS).sort());
    for (const [file, text] of files) {
      const bindings = [...text.matchAll(/\[logo\]="([^"]*)"/g)].map((m) => m[1]!);
      expect(bindings, file).toHaveLength(GROUP_PARENTS[file]!);
      for (const binding of bindings)
        expect(binding, file).toContain("claimStatus: 'server-filtered'");
    }
  });

  it('sets ownPage only where the "not affiliated" note sits beside the mark', () => {
    let seen = 0;
    for (const [file, source] of sources) {
      for (const tag of tags(source)) {
        if (!/ownPage/.test(tag.text)) continue;
        seen++;
        expect(tag.text, file).toContain('[claimStatus]');
        // The note is the next element after the mark, in the same wrapper.
        const after = source.slice(tag.end, tag.end + 200).trimStart();
        expect(after.startsWith('<aec-unclaimed-note'), file).toBe(true);
      }
    }
    // Product page, vendor page, the pair page's one side template, which renders for
    // both subjects (AECI-1798), and the empty pair hero's card template (AECI-1835).
    expect(seen).toBe(4);
  });
});
