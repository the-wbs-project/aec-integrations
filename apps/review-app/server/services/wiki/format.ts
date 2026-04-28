// ---------------------------------------------------------------------------
// Per-record wiki page format. The wiki is a YAML-frontmatter + markdown-body
// document stored on the vendor / tool record (see the `wiki_page` Airtable
// field). Research reads it as primary evidence on subsequent runs and
// rewrites it from the latest emit_result payload.
//
// Format: minimal YAML frontmatter (one key per line, no nesting) followed
// by a markdown body. We hand-roll the parser/formatter so the worker
// doesn't need a YAML dependency.
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export interface WikiDocument {
  frontmatter: Record<string, string | null>;
  body: string;
}

/**
 * Parse a stored wiki document into frontmatter (machine-readable key/values)
 * and the markdown body. Defensive — returns an empty doc when the input
 * lacks frontmatter so callers can treat the body as plain markdown.
 */
export function parseWiki(text: string): WikiDocument {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: text };
  const frontmatter: Record<string, string | null> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const valueRaw = line.slice(i + 1).trim();
    if (!key) continue;
    if (valueRaw === '' || valueRaw === 'null' || valueRaw === '~') {
      frontmatter[key] = null;
    } else {
      // Strip surrounding quotes if the value was quoted.
      const unquoted = valueRaw.replace(/^["'](.*)["']$/, '$1');
      frontmatter[key] = unquoted;
    }
  }
  const body = text.slice(m[0].length);
  return { frontmatter, body };
}

export function formatWiki(doc: WikiDocument): string {
  const lines: string[] = ['---'];
  for (const [k, v] of Object.entries(doc.frontmatter)) {
    if (v === null || v === undefined) {
      lines.push(`${k}: null`);
    } else {
      // Quote values that contain colons or leading-special chars to keep
      // the parser unambiguous.
      const needsQuotes = /[:#\n]/.test(v) || /^[\s>!&*]/.test(v);
      lines.push(`${k}: ${needsQuotes ? JSON.stringify(v) : v}`);
    }
  }
  lines.push('---');
  lines.push('');
  lines.push(doc.body.trim());
  return lines.join('\n');
}

/** Days since the wiki was last refreshed (rounded down). null = never. */
export function wikiAgeDays(lastResearched: string | null | undefined): number | null {
  if (!lastResearched) return null;
  const t = Date.parse(lastResearched);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** A wiki is "fresh" when it exists and was researched within the last N days. */
export function isWikiFresh(
  wiki: string | null | undefined,
  lastResearched: string | null | undefined,
  maxAgeDays = 90,
): boolean {
  if (!wiki || wiki.trim().length === 0) return false;
  const age = wikiAgeDays(lastResearched);
  if (age === null) return false;
  return age <= maxAgeDays;
}
