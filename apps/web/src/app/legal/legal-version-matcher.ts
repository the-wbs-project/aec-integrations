/**
 * The URL matcher of the one `/legal/<slug>/v<version>` route (AECI-1610). Eager,
 * because `app.routes.ts` holds it, so it reads the URL shape only and knows no
 * slug or version. The route's `canMatch` lazy-loads `legal-version-route.ts`,
 * which decides whether that version has a page.
 */
import { type UrlMatchResult, UrlSegment } from '@angular/router';

const LEGAL_VERSION_SEGMENT = /^v(\d+(?:\.\d+)*)$/;

/** Matches `legal/<slug>/v<version>`. `slug` and `version` become path params. */
export function legalVersionMatcher(segments: UrlSegment[]): UrlMatchResult | null {
  if (segments.length !== 3 || segments[0].path !== 'legal') return null;
  const version = segments[2].path.match(LEGAL_VERSION_SEGMENT)?.[1];
  if (version === undefined) return null;
  return {
    consumed: segments,
    posParams: { slug: segments[1], version: new UrlSegment(version, {}) },
  };
}
