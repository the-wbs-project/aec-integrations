/**
 * `LEGAL_AGREEMENT_TEXT_SHA256` (AECI-1615) must hold the SHA-256 of the exact bytes of
 * each published agreement version's Markdown: the current file under
 * `apps/web/src/content/legal/` and every archived or upcoming file under `.../legal/versions/`. A grant
 * acceptance stamps that hash as evidence of the text the owner was shown, and the API
 * Worker cannot read the Markdown, so this spec is what keeps the constant true. An edit
 * to a published agreement's text fails here: bump the version, or, for a draft with no
 * effective date, update the hash in the same change.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGREEMENT_CHECKBOX_LABELS,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
  LEGAL_AGREEMENT_TEXT_SHA256,
  LEGAL_AGREEMENT_UPCOMING_VERSIONS,
  legalAgreementTextSha256,
  type LegalAgreementDocument,
  PLANS_PAGE_CURRENT_VERSION,
  PLANS_PAGE_KNOWN_VERSIONS,
  PLANS_PAGE_SHA256,
  plansPageSha256,
} from './agreements';

/** Vitest runs with cwd = packages/shared. */
const LEGAL = join(process.cwd(), '..', '..', 'apps', 'web', 'src', 'content', 'legal');

/** Each agreement's current file and archive folder. */
const FILES: Record<LegalAgreementDocument, { current: string; archive: string }> = {
  vendor_terms: { current: 'vendor-terms.md', archive: 'vendor-terms' },
  managed_plan: { current: 'managed-plan-agreement.md', archive: 'managed-plan-agreement' },
};

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe.each(Object.keys(FILES) as LegalAgreementDocument[])('%s text hashes', (document) => {
  const { current, archive } = FILES[document];

  it('records the current version from the current file', () => {
    const version = LEGAL_AGREEMENT_CURRENT_VERSIONS[document];
    expect(legalAgreementTextSha256(document, version)).toBe(sha256(join(LEGAL, current)));
  });

  // An upcoming version (AECI-1610) shares the `versions/` folder. Since AECI-1689 it can
  // be in force before bump day, so a new acceptance can stamp its hash: it is required
  // from the change that adds the file, and the bump moves the file byte for byte.
  it('records every archived and upcoming version from its file', () => {
    const dir = join(LEGAL, 'versions', archive);
    const files = readdirSync(dir).filter((f) => /^v[\d.]+\.md$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const version = file.slice(1, -3);
      expect(legalAgreementTextSha256(document, version), file).toBe(sha256(join(dir, file)));
    }
  });

  it('holds a hash for every known version and the upcoming one, and no other', () => {
    const upcoming = LEGAL_AGREEMENT_UPCOMING_VERSIONS[document]?.version;
    expect(Object.keys(LEGAL_AGREEMENT_TEXT_SHA256[document]).sort()).toEqual(
      [...LEGAL_AGREEMENT_KNOWN_VERSIONS[document], ...(upcoming ? [upcoming] : [])].sort(),
    );
  });
});

// AECI-1615 ruling 16: the stamped `checkbox_label_sha256` must be the hash of the label.
describe.each(Object.keys(FILES) as LegalAgreementDocument[])('%s checkbox label', (document) => {
  it('hashes the exact label string', () => {
    const { text, sha256: hash } = AGREEMENT_CHECKBOX_LABELS[document];
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(hash);
  });

  it('is one plain sentence: no Markdown, no doubled or edge whitespace', () => {
    const { text } = AGREEMENT_CHECKBOX_LABELS[document];
    expect(text).toBe(text.trim());
    expect(text).not.toMatch(/\s{2,}|[[\]()*_]/);
    expect(text).toMatch(/^I have read and accept the .+\.$/);
  });
});

// AECI-1619 (ruling 16): a checkout or grant acceptance stamps `plans_page_sha256` from
// `PLANS_PAGE_SHA256`. Each value must be the hash of that version's snapshot file. The
// web spec `plans-snapshot.spec.ts` checks the current file still matches the live page.
describe('Plans page snapshot hashes', () => {
  const PLANS = join(
    process.cwd(),
    '..',
    '..',
    'apps',
    'web',
    'src',
    'content',
    'docs',
    'vendors',
    'versions',
    'plans',
  );

  it('records every snapshot file, and holds no other version', () => {
    const files = readdirSync(PLANS).filter((f) => /^v[\d.]+\.md$/.test(f));
    expect(files.map((f) => f.slice(1, -3)).sort()).toEqual([...PLANS_PAGE_KNOWN_VERSIONS].sort());
    for (const file of files) {
      const version = file.slice(1, -3);
      expect(plansPageSha256(version), file).toBe(sha256(join(PLANS, file)));
    }
  });

  it('keys the hashes by exactly the known versions, the current one last', () => {
    expect(Object.keys(PLANS_PAGE_SHA256).sort()).toEqual([...PLANS_PAGE_KNOWN_VERSIONS].sort());
    expect(PLANS_PAGE_KNOWN_VERSIONS.at(-1)).toBe(PLANS_PAGE_CURRENT_VERSION);
  });
});
