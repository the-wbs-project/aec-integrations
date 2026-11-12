/**
 * Legal version map builder (AECI-1361, AECI-1610, `STAGE_1_SPEC.md` §27.3).
 *
 * Builds slug → versions from the places a legal document lives:
 *
 *   - the current text, `src/content/legal/<name>.md` (served at `/legal/<slug>`,
 *     and at its fixed address `/legal/<slug>/v<version>`);
 *   - each superseded version's final text, copied unchanged to
 *     `src/content/legal/versions/<slug>/v<version>.md` (served at
 *     `/legal/<slug>/v<version>`);
 *   - each version not yet in force, committed before its effective date in the
 *     same `versions/` slot and served at the same kind of URL. A `versions/` file
 *     is upcoming when `LEGAL_UPCOMING` lists it and archived when
 *     `LEGAL_ARCHIVES` does.
 *
 * `legal-content.ts` calls it once at module init with the bundled Markdown, so
 * any inconsistency throws before a page can render, and fails `ng test`. It
 * throws on:
 *
 *   - a version collision: an archive at the current version, a duplicate
 *     manifest entry, or a file in both manifests;
 *   - a filename/frontmatter mismatch: `v1.0.md` whose frontmatter says another
 *     version, or a file outside `versions/<slug>/v<version>.md`;
 *   - with `currentVersions` given, a `LEGAL_CURRENT_VERSIONS` entry that is not
 *     the current file's frontmatter version;
 *   - a `versions/` file with no `LEGAL_ARCHIVES` or `LEGAL_UPCOMING` entry, or an
 *     entry with no file;
 *   - an upcoming entry that is not later than the current version, has an
 *     invalid `effectiveOn`, or whose file's `effective_date` label is not that
 *     day;
 *   - a `## Change history` problem: the section is missing or not last, an
 *     archived version is not listed with its link and superseded date, the
 *     current version is not listed, or a listed version or link does not resolve.
 *
 * The change history never has to list an upcoming version: that would edit the
 * current file, and so an agreement's hashed text, while it is in force.
 * `LegalPage` announces the upcoming version from the manifest instead.
 *
 * It never reads the clock. An upcoming entry whose effective date has passed
 * still builds: what happens on that date is AECI-1689's.
 *
 * Pure and `.md`-free (the caller passes the raw strings), so it runs under plain
 * Vitest. `legal-versions.spec.ts` also feeds it the real files from disk.
 */
import { parseFrontmatter } from './legal-frontmatter';
import {
  type LegalArchiveEntry,
  type LegalSlug,
  type LegalUpcomingEntry,
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
  /** Set on an upcoming version only: the day it takes effect, `YYYY-MM-DD`. */
  readonly effectiveOn?: string;
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
  /**
   * `versions/<slug>/v<version>.md` → the raw Markdown of an archived or upcoming
   * file.
   */
  readonly archives: Readonly<Record<string, string>>;
  /** The archive manifest (`LEGAL_ARCHIVES`). */
  readonly manifest: readonly LegalArchiveEntry[];
  /** The upcoming manifest (`LEGAL_UPCOMING`). Omitted means none. */
  readonly upcoming?: readonly LegalUpcomingEntry[];
  /**
   * The routes' copy of each current version (`LEGAL_CURRENT_VERSIONS`). When
   * given, a slug whose entry disagrees with its current file's frontmatter throws,
   * so the current version's fixed address never serves the wrong text.
   */
  readonly currentVersions?: Readonly<Partial<Record<LegalSlug, string>>>;
}

/** The heading every current file ends with. */
export const CHANGE_HISTORY_HEADING = '## Change history';

const VERSION_RE = /^\d+(?:\.\d+)*$/;
const ARCHIVE_FILE_RE = /^versions\/([a-z0-9-]+)\/v(\d+(?:\.\d+)*)\.md$/;
const LISTED_VERSION_RE = /\bVersion (\d+(?:\.\d+)*)/g;
const LINK_RE = /\]\(([^)\s]+)\)/g;
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * `YYYY-MM-DD` → its "Month D, YYYY" label, or `undefined` when it is not a real
 * day. Hand-rolled so module init never depends on ICU.
 */
export function legalDateLabel(iso: string): string | undefined {
  const match = iso.match(ISO_DATE_RE);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return undefined;
  }
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/** Numeric dotted-version compare: negative when `a` is earlier than `b`. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

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
    if (sources.currentVersions) {
      const pinned = sources.currentVersions[slug];
      if (pinned !== version) {
        fail(
          `LEGAL_CURRENT_VERSIONS says ${slug} is version ${pinned ?? '(missing)'} but its file says ${version}: move both`,
        );
      }
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

  const upcomingKeys = new Map<string, LegalUpcomingEntry>();
  for (const entry of sources.upcoming ?? []) {
    const file = legalArchiveFile(entry.slug, entry.version);
    const where = `LEGAL_UPCOMING ${entry.slug} ${entry.version}`;
    if (upcomingKeys.has(file)) fail(`version collision: ${where} is listed twice`);
    if (manifestKeys.has(file)) fail(`version collision: ${where} is also in LEGAL_ARCHIVES`);
    const set = sets.get(entry.slug);
    if (!set) fail(`${where} has no current document`);
    if (!VERSION_RE.test(entry.version)) fail(`${where} has an invalid version`);
    if (compareVersions(entry.version, set.current.version) <= 0) {
      fail(`${where} is not later than the current version ${set.current.version}`);
    }
    if (!legalDateLabel(entry.effectiveOn)) {
      fail(`${where} effectiveOn "${entry.effectiveOn}" is not a real YYYY-MM-DD day`);
    }
    upcomingKeys.set(file, entry);
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
    const upcoming = upcomingKeys.get(file);
    if (upcoming) {
      const label = legalDateLabel(upcoming.effectiveOn);
      const frontmatterLabel = data['effective_date'] ?? '';
      if (frontmatterLabel !== label) {
        fail(
          `"${file}" effective_date "${frontmatterLabel}" is not "${label}", the LEGAL_UPCOMING effectiveOn ${upcoming.effectiveOn}`,
        );
      }
      set.versions.set(version, { slug, version, data, body, effectiveOn: upcoming.effectiveOn });
      continue;
    }
    const entry = manifestKeys.get(file);
    if (!entry) fail(`"${file}" has no LEGAL_ARCHIVES or LEGAL_UPCOMING entry`);
    set.versions.set(version, { slug, version, data, body, supersededOn: entry.supersededOn });
  }

  for (const [file, entry] of manifestKeys) {
    if (!(file in sources.archives)) {
      fail(`LEGAL_ARCHIVES lists ${entry.slug} ${entry.version} but "${file}" is not bundled`);
    }
  }
  for (const [file, entry] of upcomingKeys) {
    if (!(file in sources.archives)) {
      fail(`LEGAL_UPCOMING lists ${entry.slug} ${entry.version} but "${file}" is not bundled`);
    }
  }

  // Every `/legal/<slug>/v<version>` the routes serve, the current version's
  // fixed address included.
  const knownPaths = new Set<string>();
  for (const [slug, set] of sets) {
    knownPaths.add(legalPath(slug));
    for (const v of set.versions.values()) knownPaths.add(legalArchivePath(slug, v.version));
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
    // An upcoming version is not listed here: listing it would edit the current
    // file while it is in force. `LegalPage` announces it from the manifest.
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
