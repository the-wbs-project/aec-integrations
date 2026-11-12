/**
 * AECI-1610 — the one `/legal/<slug>/v<version>` route: the matcher reads the URL
 * shape, and `servesLegalVersion` (its lazy `canMatch`) decides which versions
 * have a page. A version with none falls through to the `**` 404.
 */
import { UrlSegment } from '@angular/router';
import { describe, expect, it } from 'vitest';

import {
  LEGAL_ARCHIVES,
  LEGAL_CURRENT_VERSIONS,
  LEGAL_SLUGS,
  LEGAL_UPCOMING,
} from './legal-manifest';
import { legalVersionMatcher } from './legal-version-matcher';
import { servesLegalVersion } from './legal-version-route';

const segments = (path: string) => path.split('/').map((p) => new UrlSegment(p, {}));

describe('legalVersionMatcher', () => {
  it('matches legal/<slug>/v<version> and passes slug and version as path params', () => {
    const match = legalVersionMatcher(segments('legal/vendor-terms/v1.3'));
    expect(match?.consumed).toHaveLength(3);
    expect(match?.posParams?.['slug'].path).toBe('vendor-terms');
    expect(match?.posParams?.['version'].path).toBe('1.3');
  });

  it.each([
    'legal/vendor-terms',
    'legal/vendor-terms/1.3',
    'legal/x/v',
    'docs/x/v1.0',
    'legal/a/v1.0/b',
  ])('does not match %s', (path) => {
    expect(legalVersionMatcher(segments(path))).toBeNull();
  });
});

describe('servesLegalVersion', () => {
  it('serves every archive, every upcoming version and every current version', () => {
    for (const { slug, version } of [...LEGAL_ARCHIVES, ...LEGAL_UPCOMING]) {
      expect(servesLegalVersion(slug, version), `${slug} ${version}`).toBe(true);
    }
    for (const slug of LEGAL_SLUGS) {
      expect(servesLegalVersion(slug, LEGAL_CURRENT_VERSIONS[slug]), slug).toBe(true);
    }
  });

  it('refuses an unknown version or slug, so the route 404s', () => {
    expect(servesLegalVersion('terms', '9.9')).toBe(false);
    expect(servesLegalVersion('nope', '1.0')).toBe(false);
    expect(servesLegalVersion('review-guidelines', '0.9')).toBe(false);
  });
});
