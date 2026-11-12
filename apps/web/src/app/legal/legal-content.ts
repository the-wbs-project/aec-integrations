/**
 * Legal-page content registry (AECI-237, Phase 7.2).
 *
 * The legal documents (the four launch-required ones from `STAGE_1_SPEC.md`
 * §13/§27, plus the vendor terms and the Managed plan agreement from
 * `docs/VENDOR_SIGNUP_PROCESS.md` §4, AECI-1359/1360) live as Markdown source
 * in `apps/web/src/content/legal/`. They are inlined into the bundle at build time via the esbuild `text` loader (`"loader": { ".md":
 * "text" }` in `angular.json`; see the `declare module '*.md'` in
 * `src/markdown.d.ts`), so the imports below are plain strings — no runtime fetch.
 *
 * Parsing is **pure and deterministic** and runs once at module init (a `Map`
 * memoised per isolate), so the rendered HTML is byte-identical on the SSR
 * Worker and in the browser — a hard requirement for hydration stability and the
 * cache-neutral SSR contract (CLAUDE.md). The frontmatter splitter lives in
 * `legal-frontmatter.ts` (a pure, `.md`-free module so it is unit-testable under
 * plain Vitest); we avoid `gray-matter`/`js-yaml` (they pull `Buffer`, unsafe on
 * the `platform: neutral` SSR build).
 *
 * The route slug (short, public — set by the footer links) maps to the long
 * §27.1 filename via `LEGAL_SOURCE_FILES` in `legal-manifest.ts`. Each document
 * has a current version and zero or more archived ones (AECI-1361): the version
 * map is built and validated by `buildLegalVersions` (`legal-versions.ts`) at
 * module init, so a bad archive or `## Change history` throws before any page
 * renders and fails `ng test`. The Markdown body is *content*, not UI strings:
 * it is rendered via `[innerHTML]` (Angular's sanitizer runs) and is not
 * `$localize`-extracted. Only the page chrome in `legal-page.ts` is i18n-wrapped.
 */
import listingAccuracyMd from '../../content/legal/listing-accuracy-policy.md';
import managedPlanAgreementMd from '../../content/legal/managed-plan-agreement.md';
import privacyMd from '../../content/legal/privacy-policy.md';
import reviewGuidelinesMd from '../../content/legal/review-guidelines.md';
import termsMd from '../../content/legal/terms-of-service.md';
import vendorTermsMd from '../../content/legal/vendor-terms.md';
import managedPlanAgreementV1_0Md from '../../content/legal/versions/managed-plan-agreement/v1.0.md';
import privacyV1_0Md from '../../content/legal/versions/privacy/v1.0.md';
import vendorTermsV1_0Md from '../../content/legal/versions/vendor-terms/v1.0.md';
import vendorTermsV1_1Md from '../../content/legal/versions/vendor-terms/v1.1.md';
import vendorTermsV1_2Md from '../../content/legal/versions/vendor-terms/v1.2.md';
import termsV1_0Md from '../../content/legal/versions/terms/v1.0.md';
import {
  LEGAL_ARCHIVES,
  LEGAL_CURRENT_VERSIONS,
  LEGAL_UPCOMING,
  type LegalSlug,
} from './legal-manifest';
import { type LegalDoc, renderLegalVersion } from './legal-render';
import { buildLegalVersions } from './legal-versions';

export { LEGAL_SLUGS, type LegalSlug } from './legal-manifest';

export type { LegalDoc, LegalFrontmatter } from './legal-render';

// The current text of each document (`LEGAL_SOURCE_FILES` names the files).
const CURRENT_SOURCES: Record<LegalSlug, string> = {
  terms: termsMd,
  privacy: privacyMd,
  'review-guidelines': reviewGuidelinesMd,
  'listing-accuracy': listingAccuracyMd,
  'vendor-terms': vendorTermsMd,
  'managed-plan-agreement': managedPlanAgreementMd,
};

// Every archived and upcoming version, keyed by its path under
// `src/content/legal/`. Must match `LEGAL_ARCHIVES` plus `LEGAL_UPCOMING` one to
// one; `buildLegalVersions` throws otherwise.
const ARCHIVE_SOURCES: Record<string, string> = {
  'versions/terms/v1.0.md': termsV1_0Md,
  'versions/privacy/v1.0.md': privacyV1_0Md,
  'versions/vendor-terms/v1.0.md': vendorTermsV1_0Md,
  'versions/managed-plan-agreement/v1.0.md': managedPlanAgreementV1_0Md,
  'versions/vendor-terms/v1.1.md': vendorTermsV1_1Md,
  'versions/vendor-terms/v1.2.md': vendorTermsV1_2Md,
};

const VERSIONS = buildLegalVersions({
  current: CURRENT_SOURCES,
  archives: ARCHIVE_SOURCES,
  manifest: LEGAL_ARCHIVES,
  upcoming: LEGAL_UPCOMING,
  currentVersions: LEGAL_CURRENT_VERSIONS,
});

// slug → version → rendered doc. Rendered once per isolate, at module init.
const REGISTRY: ReadonlyMap<LegalSlug, ReadonlyMap<string, LegalDoc>> = new Map(
  Array.from(VERSIONS, ([slug, set]) => [
    slug,
    new Map(Array.from(set.versions, ([version, v]) => [version, renderLegalVersion(v)] as const)),
  ]),
);

/** The current version string for a slug (its frontmatter `version`). */
export function currentLegalVersion(slug: LegalSlug): string {
  const set = VERSIONS.get(slug);
  if (!set) throw new Error(`No legal document for slug "${slug}"`);
  return set.current.version;
}

/** Returns the current version of a known slug, or `undefined` if unknown. */
export function getLegalDoc(slug: string): LegalDoc | undefined {
  const set = VERSIONS.get(slug as LegalSlug);
  return set && getLegalVersion(slug, set.current.version);
}

/**
 * Returns one version of a known slug, current, archived or upcoming, or `undefined` when
 * the slug or the version is unknown.
 */
export function getLegalVersion(slug: string, version: string): LegalDoc | undefined {
  return REGISTRY.get(slug as LegalSlug)?.get(version);
}
