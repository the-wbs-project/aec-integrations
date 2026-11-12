/**
 * The eager half of the legal manifest (AECI-1610): the slugs, their files and
 * the path helpers. Nothing about versions.
 *
 * Two readers ship in the initial bundle: `app.routes.ts` and the app shell's
 * `legal-notices.ts`. They import from here, not from `legal-manifest.ts`, so the
 * version lists (archives, upcoming versions, current versions) stay out of the
 * initial bundle and load with the legal page. Do not import `legal-manifest.ts`
 * from eager code. `legal-manifest.ts` re-exports everything here.
 */

/** Public route slug for a legal page (`/legal/<slug>`). */
export type LegalSlug =
  | 'terms'
  | 'privacy'
  | 'review-guidelines'
  | 'listing-accuracy'
  | 'vendor-terms'
  | 'managed-plan-agreement';

/** slug → the long §27.1 filename under `src/content/legal/`, in canonical order. */
export const LEGAL_SOURCE_FILES: Readonly<Record<LegalSlug, string>> = {
  terms: 'terms-of-service.md',
  privacy: 'privacy-policy.md',
  'review-guidelines': 'review-guidelines.md',
  'listing-accuracy': 'listing-accuracy-policy.md',
  'vendor-terms': 'vendor-terms.md',
  'managed-plan-agreement': 'managed-plan-agreement.md',
};

/** Every legal slug, in canonical order. */
export const LEGAL_SLUGS = Object.keys(LEGAL_SOURCE_FILES) as readonly LegalSlug[];

/** The current version's path. */
export function legalPath(slug: LegalSlug): string {
  return `/legal/${slug}`;
}

/**
 * A version's own path: `/legal/<slug>/v<version>`. The same shape for an
 * archived, an upcoming and the current version.
 */
export function legalArchivePath(slug: LegalSlug, version: string): string {
  return `/legal/${slug}/v${version}`;
}

/**
 * A non-current version's file under `src/content/legal/`, archived or upcoming:
 * `versions/<slug>/v<version>.md`.
 */
export function legalArchiveFile(slug: LegalSlug, version: string): string {
  return `versions/${slug}/v${version}.md`;
}
