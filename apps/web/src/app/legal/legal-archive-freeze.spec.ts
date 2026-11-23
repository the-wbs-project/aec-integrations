/**
 * AECI-1720: every archived legal version keeps the bytes it was published with. Plain
 * Vitest, cwd = apps/web.
 *
 * An archive is the superseded version's final text, copied unchanged
 * (`src/content/legal/README.md`). The two agreements' archives are already held to
 * their bytes by `LEGAL_AGREEMENT_TEXT_SHA256` (`packages/shared`,
 * `agreement-text-hash.spec.ts`), because an acceptance stamps that hash. The Terms of
 * Service and the Privacy Policy have no acceptance hash, so nothing froze their
 * archives. This spec records one hash for each archive the agreement map does not
 * cover, and checks every archive for git conflict markers, which a merge once left in
 * a published docs archive without any gate noticing.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEGAL_AGREEMENT_TEXT_SHA256 } from '@aeci/shared/api/agreements';
import { describe, expect, it } from 'vitest';

import { LEGAL_ARCHIVES } from './legal-manifest';

const VERSIONS = join(process.cwd(), 'src', 'content', 'legal', 'versions');
const archiveFile = (slug: string, version: string) => join(VERSIONS, slug, `v${version}.md`);

/** The manifest slug of each agreement in `LEGAL_AGREEMENT_TEXT_SHA256`. */
const AGREEMENT_SLUGS: Readonly<Record<keyof typeof LEGAL_AGREEMENT_TEXT_SHA256, string>> = {
  vendor_terms: 'vendor-terms',
  managed_plan: 'managed-plan-agreement',
};

/** Archives no acceptance hash covers, by `<slug>@<version>`. */
const ARCHIVE_SHA256: Readonly<Record<string, string>> = {
  'terms@1.0': 'd0e1456b634d1f469e763f9e2ba22ceb7d45ac77f57527a05821724f77edb14d',
  'privacy@1.0': 'aa23bb1ef721af726d1c35bf2cd4890cf25487550774c26f54d6412b3b5d8d93',
};

/** A git conflict: a line opening with seven `<` closed by a later one with seven `>`. */
const CONFLICT_RE = /^<{7}(?: .*)?$[\s\S]*?^>{7}(?: .*)?$/m;

const covered = new Set(Object.values(AGREEMENT_SLUGS));
const uncovered = LEGAL_ARCHIVES.filter((entry) => !covered.has(entry.slug));

describe('archived legal versions are frozen (AECI-1720)', () => {
  it.each(LEGAL_ARCHIVES.map((e) => [e.slug, e.version]))(
    '%s v%s holds no git conflict markers',
    (slug, version) => {
      const text = readFileSync(archiveFile(slug, version), 'utf8');
      expect(CONFLICT_RE.test(text)).toBe(false);
    },
  );

  it('records a hash for every archive the agreement hash map does not cover, and no other', () => {
    expect(Object.keys(ARCHIVE_SHA256).sort()).toEqual(
      uncovered.map((e) => `${e.slug}@${e.version}`).sort(),
    );
  });

  it('every agreement archive is in the agreement hash map', () => {
    for (const [document, slug] of Object.entries(AGREEMENT_SLUGS)) {
      const hashed = Object.keys(
        LEGAL_AGREEMENT_TEXT_SHA256[document as keyof typeof LEGAL_AGREEMENT_TEXT_SHA256],
      );
      for (const entry of LEGAL_ARCHIVES.filter((e) => e.slug === slug)) {
        expect(hashed, `${slug} ${entry.version}`).toContain(entry.version);
      }
    }
  });

  it.each(uncovered.map((e) => [e.slug, e.version]))(
    '%s v%s keeps its published bytes',
    (slug, version) => {
      const hash = createHash('sha256')
        .update(readFileSync(archiveFile(slug, version)))
        .digest('hex');
      expect(
        hash,
        `versions/${slug}/v${version}.md changed. An archive is never edited ` +
          '(src/content/legal/README.md). Restore it from git.',
      ).toBe(ARCHIVE_SHA256[`${slug}@${version}`]);
    },
  );
});
