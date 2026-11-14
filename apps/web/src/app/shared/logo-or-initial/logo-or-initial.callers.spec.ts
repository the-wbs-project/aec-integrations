import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1769): every `<aec-logo-or-initial>` caller is classified, so no caller can
 * show an unclaimed listing's logo off its own page by accident (ADR 0056 floor 3,
 * counsel's ruling 9).
 *
 * - `subject`: the payload is a page subject (`ProductDetail`, `VendorDetail`,
 *   `ProductPairSubject`). It keeps the real logo, so the tag must pass `[claimStatus]`.
 * - `link`: a list, link or search payload. The API withholds an unclaimed listing's
 *   logo there (AECI-1618), so the tag passes `src` alone.
 * - `portal` and `admin`: ADR 0051 decision 4, "Portal and admin reads keep the real
 *   value." A vendor sees its own logo.
 * - `person`: the account avatar. Not a listing.
 * - `preview`: a dev-only fixture route.
 *
 * A new caller, or a new tag in a listed file, fails here until it is classified.
 */
const APP = join(process.cwd(), 'src/app');

type Kind = 'subject' | 'link' | 'portal' | 'admin' | 'person' | 'preview';

const CALLERS: Record<string, Partial<Record<Kind, number>>> = {
  'admin/requests/product-request-queue.ts': { admin: 1 },
  'admin/vendors/vendor-detail.html': { admin: 1 },
  'layout/account-identity.ts': { person: 1 },
  'preview/integration-pair/concept-flow-canvas.ts': { preview: 2 },
  'products/integration-group-card.ts': { link: 1 },
  'products/product-card-grid.ts': { link: 2 },
  'products/product-card.ts': { link: 1 },
  'products/product-detail.ts': { subject: 2, link: 1 },
  'products/product-extensions.ts': { link: 2 },
  'products/product-integration-row.ts': { link: 1 },
  'products/product-powered-hub.ts': { link: 3 },
  'products/products-pair.ts': { subject: 4 },
  'reviews/review-form.html': { subject: 1 },
  'search/search-product-card.ts': { link: 1 },
  'search/search-vendor-card.ts': { link: 1 },
  'search/search-vendor-row.ts': { link: 1 },
  // Portal and admin pickers call the public `GET /api/products`, so it is a link.
  'shared/product-combobox/product-combobox.ts': { link: 1 },
  'vendor/components/vendor-integration-create.ts': { portal: 2 },
  'vendor/components/vendor-integrations-section.ts': { portal: 2 },
  'vendor/components/vendor-product-connectors.ts': { portal: 1 },
  'vendor/integration-detail/vendor-integration-detail-page.ts': { portal: 4 },
  'vendor/sections/vendor-product-list-page.ts': { portal: 1 },
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
    // A subject tag is the only kind that passes the claim status.
    const withStatus = found.filter((tag) => tag.text.includes('[claimStatus]'));
    expect(withStatus).toHaveLength(kinds.subject ?? 0);
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
    // Product page, vendor page and both pair-page subjects.
    expect(seen).toBe(4);
  });
});
