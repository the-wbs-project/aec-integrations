/**
 * AECI-1673 — the accessibility statement's wording guard (counsel Q40, ruling 22).
 *
 * Plain Vitest over the source file, so it runs in the fast unit lane. Each
 * assertion is one of counsel's rules for the page (`docs/STAGE_1_SPEC.md`
 * §27.6). A failing assertion means a wording change needs a legal-impact
 * verdict first (`docs/LEGAL_IMPACT_REVIEW.md` §3, "Accessibility statement").
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  fileURLToPath(new URL('../../content/accessibility.md', import.meta.url)),
  'utf8',
);
const API_WRANGLER = readFileSync(
  fileURLToPath(new URL('../../../../api/wrangler.jsonc', import.meta.url)),
  'utf8',
);

/** The production `SUPPORT_EMAIL`: the first one after the `"production"` env key. */
function productionSupportEmail(): string | undefined {
  const start = API_WRANGLER.indexOf('"production": {');
  if (start < 0) return undefined;
  return /"SUPPORT_EMAIL":\s*"([^"]+)"/.exec(API_WRANGLER.slice(start))?.[1];
}

describe('accessibility statement wording (counsel Q40)', () => {
  it('states an aim to conform to WCAG 2.1 AA', () => {
    expect(SOURCE).toContain(
      'We aim to conform to the Web Content Accessibility Guidelines (WCAG) 2.1 at level AA.',
    );
  });

  it('never claims compliance', () => {
    expect(SOURCE).not.toMatch(/\bcompl(iant|iance|ies)\b/i);
    expect(SOURCE).not.toMatch(/\bfully (accessible|conform)/i);
  });

  it('says we test each release and names both methods', () => {
    expect(SOURCE).toContain('We test each release with automated accessibility checks (axe).');
    expect(SOURCE).toContain('manual keyboard and screen-reader checklist');
  });

  it('promises a reply, not a fix, within 10 business days', () => {
    expect(SOURCE).toContain('We reply within 10 business days.');
    expect(SOURCE).not.toMatch(/\bwe (will )?fix\b/i);
  });

  it('names the production SUPPORT_EMAIL as the contact route', () => {
    const email = productionSupportEmail();
    expect(email).toBe('support@aecintegrations.com');
    expect(SOURCE).toContain(`[${email}](mailto:${email})`);
  });
});
