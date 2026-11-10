/**
 * `LEGAL_AGREEMENT_TEXT_SHA256` (AECI-1615) must hold the SHA-256 of the exact bytes of
 * each published agreement version's Markdown: the current file under
 * `apps/web/src/content/legal/` and every archive under `.../legal/versions/`. A grant
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
  legalAgreementTextSha256,
  type LegalAgreementDocument,
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

  it('records every archived version from its archive file', () => {
    const dir = join(LEGAL, 'versions', archive);
    const archived = readdirSync(dir).filter((f) => /^v[\d.]+\.md$/.test(f));
    expect(archived.length).toBeGreaterThan(0);
    for (const file of archived) {
      const version = file.slice(1, -3);
      expect(legalAgreementTextSha256(document, version), file).toBe(sha256(join(dir, file)));
    }
  });

  it('holds a hash for every known version, and no other', () => {
    expect(Object.keys(LEGAL_AGREEMENT_TEXT_SHA256[document]).sort()).toEqual(
      [...LEGAL_AGREEMENT_KNOWN_VERSIONS[document]].sort(),
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
