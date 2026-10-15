/**
 * Legal version map builder (AECI-1361, `STAGE_1_SPEC.md` §27.3).
 *
 * Builds slug → versions from the two places a legal document lives:
 *
 *   - the current text, `src/content/legal/<name>.md` (served at `/legal/<slug>`);
 *   - each superseded version's final text, copied unchanged to
 *     `src/content/legal/versions/<slug>/v<version>.md` (served at
 *     `/legal/<slug>/v<version>`).
 *
 * `legal-content.ts` calls it once at module init with the bundled Markdown, so
 * any inconsistency throws before a page can render, and fails `ng test`. It
 * throws on:
 *
 *   - a version collision: an archive at the current version, or a duplicate
 *     manifest entry;
 *   - a filename/frontmatter mismatch: `v1.0.md` whose frontmatter says another
 *     version, or an archive file outside `versions/<slug>/v<version>.md`;
 *   - an archive file with no `LEGAL_ARCHIVES` entry, or an entry with no file;
 *   - a `## Change history` problem: the section is missing or not last, an
 *     archived version is not listed with its link and superseded date, the
 *     current version is not listed, or a listed version or link does not resolve.
 *
 * Pure and `.md`-free (the caller passes the raw strings), so it runs under plain
 * Vitest. `legal-versions.spec.ts` also feeds it the real files from disk.
 */
import { parseFrontmatter } from './legal-frontmatter';
import {
  type LegalArchiveEntry,
  type LegalSlug,
  legalArchiveFile,
  legalArchivePath,
  legalPath,
} from './legal-manifest';

/** One parsed version of a legal document. */
export interface LegalVersion {
  readonly slug: LegalSlug;
  readonly version: string;
  /** Scalar frontmatter (`parseFrontmatter`). */
  readonly data: Readonly<Record<string, string>>;
  /** The Markdown body, frontmatter removed. */
  readonly body: string;
  /** Set on an archived version only: the day the next version replaced it. */
  readonly supersededOn?: string;
}

/** Every version of one document. `versions` includes the current one. */
export interface LegalVersionSet {
  readonly current: LegalVersion;
  readonly versions: ReadonlyMap<string, LegalVersion>;
}

export type LegalVersionMap = ReadonlyMap<LegalSlug, LegalVersionSet>;

export interface LegalVersionSources {
  /** slug → the raw Markdown of the current file. */
  readonly current: Readonly<Partial<Record<LegalSlug, string>>>;
  /** `versions/<slug>/v<version>.md` → the raw Markdown of the archived file. */
  readonly archives: Readonly<Record<string, string>>;
  /** The archive manifest (`LEGAL_ARCHIVES`). */
  readonly manifest: readonly LegalArchiveEntry[];
}

/** The heading every current file ends with. */
export const CHANGE_HISTORY_HEADING = '## Change history';

const VERSION_RE = /^\d+(?:\.\d+)*$/;
const ARCHIVE_FILE_RE = /^versions\/([a-z0-9-]+)\/v(\d+(?:\.\d+)*)\.md$/;
const LISTED_VERSION_RE = /\bVersion (\d+(?:\.\d+)*)/g;
const LINK_RE = /\]\(([^)\s]+)\)/g;

function fail(message: string): never {
  throw new Error(`legal registry: ${message}`);
}

/** Builds and validates the version map. Throws on any inconsistency. */
export function buildLegalVersions(sources: LegalVersionSources): LegalVersionMap {
  const sets = new Map<LegalSlug, { current: LegalVersion; versions: Map<string, LegalVersion> }>();

  for (const [slug, raw] of Object.entries(sources.current) as [LegalSlug, string][]) {
    const { data, body } = parseFrontmatter(raw);
    const version = data['version'] ?? '';
    if (!VERSION_RE.test(version)) {
      fail(`/legal/${slug} has no valid frontmatter version (got "${version}")`);
    }
    const current: LegalVersion = { slug, version, data, body };
    sets.set(slug, { current, versions: new Map([[version, current]]) });
  }

  const manifestKeys = new Map<string, LegalArchiveEntry>();
  for (const entry of sources.manifest) {
    const file = legalArchiveFile(entry.slug, entry.version);
    if (manifestKeys.has(file)) {
      fail(`version collision: ${entry.slug} ${entry.version} is in LEGAL_ARCHIVES twice`);
    }
    manifestKeys.set(file, entry);
  }

  for (const [file, raw] of Object.entries(sources.archives)) {
    const match = file.match(ARCHIVE_FILE_RE);
    if (!match) {
      fail(`archive file "${file}" is not named versions/<slug>/v<version>.md`);
    }
    const slug = match[1] as LegalSlug;
    const fileVersion = match[2];
    const set = sets.get(slug);
    if (!set) fail(`archive file "${file}" has no current document for slug "${slug}"`);

    const { data, body } = parseFrontmatter(raw);
    const version = data['version'] ?? '';
    if (version !== fileVersion) {
      fail(
        `filename/frontmatter mismatch: "${file}" names version ${fileVersion} but its frontmatter says "${version}"`,
      );
    }
    if (set.versions.has(version)) {
      fail(`version collision: /legal/${slug} has two version ${version} texts`);
    }
    const entry = manifestKeys.get(file);
    if (!entry) fail(`archive file "${file}" has no LEGAL_ARCHIVES entry`);
    set.versions.set(version, { slug, version, data, body, supersededOn: entry.supersededOn });
  }

  for (const [file, entry] of manifestKeys) {
    if (!(file in sources.archives)) {
      fail(`LEGAL_ARCHIVES lists ${entry.slug} ${entry.version} but "${file}" is not bundled`);
    }
  }

  const knownPaths = new Set<string>();
  for (const [slug, set] of sets) {
    knownPaths.add(legalPath(slug));
    for (const v of set.versions.values()) {
      if (v.supersededOn !== undefined) knownPaths.add(legalArchivePath(slug, v.version));
    }
  }
  for (const set of sets.values()) checkChangeHistory(set, knownPaths);

  return sets;
}

/**
 * The list items of the trailing `## Change history` section, or `undefined`
 * when the section is missing or another h1/h2 follows it.
 */
export function changeHistoryItems(body: string): string[] | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === CHANGE_HISTORY_HEADING);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  if (rest.some((line) => /^#{1,2}\s/.test(line))) return undefined;
  return rest.filter((line) => /^\s*[-*]\s/.test(line)).map((line) => line.trim());
}

function checkChangeHistory(set: LegalVersionSet, knownPaths: ReadonlySet<string>): void {
  const { slug, version: currentVersion } = set.current;
  const where = legalPath(slug);
  const items = changeHistoryItems(set.current.body);
  if (!items) fail(`${where} does not end with a "${CHANGE_HISTORY_HEADING}" section`);

  const listed = new Map<string, string>();
  for (const item of items) {
    const versions = Array.from(item.matchAll(LISTED_VERSION_RE), (m) => m[1]);
    if (versions.length !== 1) {
      fail(`${where} change history line must name exactly one "Version X.Y": "${item}"`);
    }
    const version = versions[0];
    if (listed.has(version)) fail(`${where} change history lists version ${version} twice`);
    if (!set.versions.has(version)) {
      fail(`${where} change history lists version ${version}, which does not resolve`);
    }
    for (const [, href] of item.matchAll(LINK_RE)) {
      if (href.startsWith('/legal/') && !knownPaths.has(href)) {
        fail(`${where} change history links to ${href}, which does not resolve`);
      }
    }
    listed.set(version, item);
  }

  if (!listed.has(currentVersion)) {
    fail(`${where} change history does not list the current version ${currentVersion}`);
  }
  for (const v of set.versions.values()) {
    if (v.supersededOn === undefined) continue;
    const item = listed.get(v.version);
    const path = legalArchivePath(slug, v.version);
    if (!item) fail(`${where} change history does not list archived version ${v.version}`);
    if (!item.includes(`](${path})`)) {
      fail(`${where} change history line for version ${v.version} does not link to ${path}`);
    }
    if (!item.includes(v.supersededOn)) {
      fail(
        `${where} change history line for version ${v.version} does not give its superseded date "${v.supersededOn}"`,
      );
    }
  }
}
