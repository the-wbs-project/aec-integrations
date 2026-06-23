/**
 * Pure frontmatter splitter for the legal Markdown sources (AECI-237).
 *
 * Kept in its own module — separate from `legal-content.ts`, which imports the
 * `.md` files via the esbuild `text` loader — so this pure logic can be
 * unit-tested under plain Vitest (`*.spec.ts`), which has no `.md` loader
 * configured. The `legal-page.component.spec.ts` (run via `ng test`, the Angular
 * build) exercises the full `legal-content.ts` path including the `.md` imports.
 *
 * Scalar values only (no nested YAML); we avoid `gray-matter`/`js-yaml` because
 * they pull `Buffer`, which is unsafe on the `platform: neutral` SSR build.
 */

// Leading `---` … `---` fence (tolerant of CRLF), consumed off the front.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Splits a leading frontmatter block into a scalar `key → value` map and the
 * remaining body. A blank value (e.g. an unset `effective_date:`) parses to an
 * empty string. If there is no frontmatter fence, returns the input unchanged as
 * the body with an empty map.
 */
export function parseFrontmatter(raw: string): {
  data: Record<string, string>;
  body: string;
} {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: raw };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (key) data[key] = line.slice(sep + 1).trim();
  }
  // Drop the blank line(s) left between the closing `---` fence and the body so
  // the body begins at its first real character.
  const body = raw.slice(match[0].length).replace(/^(?:\r?\n)+/, '');
  return { data, body };
}
