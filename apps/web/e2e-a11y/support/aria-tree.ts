/**
 * AECI-1879: the pure half of the ARIA checks. No browser, no Playwright.
 *
 * The browser half reads the page with Playwright's `ariaSnapshot()` (the YAML
 * text the committed snapshots hold) and `ariaSnapshotJSON()` (the same tree as
 * JSON, which the rules walk). Both come from the accessibility tree, so a node
 * that is hidden from assistive technology is absent from both.
 *
 * Pinned by `aria-tree.unit.spec.ts`, which runs in the plain Vitest runner.
 */

/** One node of `locator.ariaSnapshotJSON()`. A bare string is a text fragment. */
export interface AriaNode {
  readonly role: string;
  readonly name?: string;
  readonly text?: string;
  readonly level?: number;
  readonly url?: string;
  readonly children?: readonly (AriaNode | string)[];
}

/** The landmark a node sits in, innermost of these three. */
export type Region = 'banner' | 'main' | 'contentinfo' | 'none';

export interface HeadingFact {
  readonly level: number;
  readonly name: string;
}

export interface LandmarkFact {
  readonly role: string;
  readonly name: string;
  /** Links anywhere inside the landmark. */
  readonly links: number;
}

export interface LinkFact {
  readonly name: string;
  readonly url: string;
  readonly region: Region;
}

export interface PageFacts {
  readonly headings: readonly HeadingFact[];
  readonly landmarks: readonly LandmarkFact[];
  readonly links: readonly LinkFact[];
}

const LANDMARKS = new Set([
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'search',
  'complementary',
  'form',
  'region',
]);
const REGIONS = new Set<string>(['banner', 'main', 'contentinfo']);

/** Walk the tree once and collect what the rules read. */
export function collectPageFacts(tree: readonly (AriaNode | string)[]): PageFacts {
  const headings: HeadingFact[] = [];
  const landmarks: LandmarkFact[] = [];
  const links: LinkFact[] = [];

  const visit = (nodes: readonly (AriaNode | string)[], region: Region): number => {
    let linkCount = 0;
    for (const node of nodes) {
      if (typeof node === 'string') continue;
      const here: Region = REGIONS.has(node.role) ? (node.role as Region) : region;
      if (node.role === 'heading' && typeof node.level === 'number') {
        headings.push({ level: node.level, name: node.name ?? '' });
      }
      if (node.role === 'link') {
        linkCount++;
        if (node.url) links.push({ name: node.name ?? '', url: node.url, region: here });
      }
      // A landmark is recorded before its children, so the list is in document order.
      const slot = LANDMARKS.has(node.role) ? landmarks.length : -1;
      if (slot >= 0) landmarks.push({ role: node.role, name: node.name ?? '', links: 0 });
      const inner = visit(node.children ?? [], here);
      if (slot >= 0) landmarks[slot] = { ...landmarks[slot]!, links: inner };
      linkCount += inner;
    }
    return linkCount;
  };
  visit(tree, 'none');
  return { headings, landmarks, links };
}

/**
 * Rule 3: one `h1`, no skipped heading level, the four landmarks, and a unique
 * name on every `navigation` and `search` landmark. WCAG 1.3.1, 2.4.6.
 * Returns one sentence per problem, empty when the page passes.
 */
export function structureProblems(facts: PageFacts): string[] {
  const problems: string[] = [];
  const h1s = facts.headings.filter((h) => h.level === 1);
  if (h1s.length !== 1) {
    problems.push(
      `the page has ${h1s.length} h1 headings, not one` +
        (h1s.length > 1 ? `: ${h1s.map((h) => `"${h.name}"`).join(', ')}` : ''),
    );
  }
  // The outline starts at level 1, so a first heading at h2 skips a level too.
  let previous = 0;
  for (const h of facts.headings) {
    if (h.level > previous + 1) {
      problems.push(`h${h.level} "${h.name}" follows h${previous || '(none)'}, skipping a level`);
    }
    previous = h.level;
  }
  for (const role of ['banner', 'navigation', 'main', 'contentinfo']) {
    if (!facts.landmarks.some((l) => l.role === role)) problems.push(`no ${role} landmark`);
  }
  const mains = facts.landmarks.filter((l) => l.role === 'main').length;
  if (mains > 1) problems.push(`${mains} main landmarks, not one`);
  for (const role of ['navigation', 'search']) {
    const named = facts.landmarks.filter((l) => l.role === role);
    for (const l of named)
      if (l.name.trim() === '') problems.push(`a ${role} landmark has no name`);
    const seen = new Set<string>();
    for (const l of named) {
      const key = l.name.trim().toLowerCase();
      if (key === '') continue;
      if (seen.has(key)) problems.push(`two ${role} landmarks are both named "${l.name}"`);
      seen.add(key);
    }
  }
  return problems;
}

/** A trailing slash does not make a different target. A different hash does. */
export function normalizeTarget(url: string): string {
  const [path = '', hash = ''] = url.split('#');
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return hash ? `${trimmed}#${hash}` : trimmed;
}

/** Collapse spacing and case, the way a screen-reader user hears a name. */
export function normalizeLinkName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Rule 5: no two links on a page share a name while pointing to different
 * targets (WCAG 2.4.4, 2.4.9). AECI-830 is the precedent: three "Source" links
 * to three different studies. A link with no name is axe's job, not this rule's.
 */
export function sharedNameProblems(links: readonly LinkFact[]): string[] {
  const byName = new Map<string, Set<string>>();
  const shown = new Map<string, string>();
  for (const link of links) {
    const key = normalizeLinkName(link.name);
    if (key === '') continue;
    if (!byName.has(key)) byName.set(key, new Set());
    byName.get(key)!.add(normalizeTarget(link.url));
    if (!shown.has(key)) shown.set(key, link.name.trim());
  }
  const problems: string[] = [];
  for (const [key, targets] of byName) {
    if (targets.size > 1) {
      problems.push(`"${shown.get(key)}" links to ${[...targets].sort().join(' and ')}`);
    }
  }
  return problems;
}

/**
 * Mask the parts of a name that change without any change to the page: counts,
 * calendar dates and relative times. The cross-page name rule compares masked
 * names, so "Project Management 2 products" and "Project Management" agree.
 */
export function maskVolatile(text: string): string {
  return (
    text
      .replace(/\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '<ago>')
      .replace(/\b(just now|yesterday|today)\b/gi, '<ago>')
      .replace(
        /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/g,
        '<date>',
      )
      .replace(
        /\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?,?\s+\d{4}\b/g,
        '<date>',
      )
      .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, '<date>')
      // A clock time, with its AM or PM: the half of the day flips with the hour of the run.
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M\b)?/gi, '<time>')
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
      // Every other run of digits is a count, a rating or a price.
      .replace(/\d+(?:[.,]\d+)*/g, '<n>')
  );
}

/** The state flags `ariaSnapshot()` writes in brackets. Their values are structure, not data. */
const STATE_FLAG =
  /(\[(?:level|checked|disabled|expanded|pressed|selected|active|invalid)(?:=[^\]]*)?\])/;

/**
 * Mask an `ariaSnapshot()` YAML text for a committed snapshot. Names and text
 * go through `maskVolatile`. State flags (`[level=2]`, `[expanded]`) and link
 * targets (`/url:`) keep their digits, apart from a UUID in a target, which a
 * reseed may change. The `return=` parameter a sign-in link carries names the
 * page it sits on, so it is dropped.
 */
export function maskAriaSnapshot(yaml: string): string {
  const lines = yaml.split('\n').map((line) => {
    if (/^\s*- \/url: /.test(line)) {
      return (
        line
          .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
          // Home's sign-in link carries no `return=`, so the parameter is dropped, not masked.
          .replace(/([?&])return=[^&#\s]*&?/g, '$1')
          .replace(/[?&](?=#|\s|$)/, '')
      );
    }
    return line
      .split(STATE_FLAG)
      .map((part, i) => (i % 2 === 1 ? part : maskVolatile(part)))
      .join('');
  });
  const text = lines.join('\n').replace(/\s+$/, '');
  return `${text}\n`;
}

/** One link name a page gives a target, for the cross-page rule. */
export interface PageLinkName {
  readonly page: string;
  readonly url: string;
  readonly name: string;
  readonly region: Region;
}

/**
 * The leading words a link may add to a page's name without naming a different
 * page. Each is an accepted case, listed so a new one is a reviewed change:
 *
 *   "View all categories"   an index link, beside the footer's "Categories"
 *   "View Fixture Procore"  a card's call to action, beside the plain name
 *   "Back to Fixture …"     a back link, beside the plain name
 *
 * Two more accepted cases need no entry, because the containment rule below
 * covers them: a name followed by a count ("Project Management 2 products"
 * beside "Project Management") and a name followed by a description ("Trades
 * Tools built for the work you sell." beside "Trades").
 */
const ACCEPTED_LEADS: readonly (readonly string[])[] = [['view', 'all'], ['view'], ['back', 'to']];

/** The masked, case-folded words of a name, with an accepted lead removed. */
export function nameWords(name: string): string[] {
  const words = normalizeLinkName(maskVolatile(name))
    .split(/[^\p{L}\p{N}<>&]+/u)
    .filter((w) => w !== '');
  for (const lead of ACCEPTED_LEADS) {
    if (lead.every((w, i) => words[i] === w) && words.length > lead.length) {
      return words.slice(lead.length);
    }
  }
  return words;
}

/**
 * Two names identify the same target consistently when, masked and case-folded,
 * every word of one is a word of the other. "Fixture Procore" and "View Fixture
 * Procore" agree. "Vendor portal" and "Vendor Overview" do not, and nor do
 * "General contractors" and "General Contracting". WCAG 3.2.4.
 */
export function namesConsistent(a: string, b: string): boolean {
  const x = nameWords(a);
  const y = nameWords(b);
  if (x.length === 0 || y.length === 0) return normalizeLinkName(a) === normalizeLinkName(b);
  const [short, long] = x.length <= y.length ? [x, new Set(y)] : [y, new Set(x)];
  return short.every((w) => long.has(w));
}

/**
 * Rule 4, the link half: the same target carries a consistent name on every
 * page, compared within the same landmark (`banner` with `banner`, `main` with
 * `main`). The header and footer are compared whole by their snapshots, so this
 * rule's yield is in `main`. A header link and a footer link to the same page
 * are two components, so they are not compared with each other.
 */
export function inconsistentNameProblems(names: readonly PageLinkName[]): string[] {
  const groups = new Map<string, PageLinkName[]>();
  for (const n of names) {
    if (normalizeLinkName(n.name) === '') continue;
    const key = `${n.region} ${normalizeTarget(n.url)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  const problems: string[] = [];
  for (const [key, group] of groups) {
    const distinct = new Map<string, PageLinkName>();
    for (const n of group) {
      const k = normalizeLinkName(maskVolatile(n.name));
      if (!distinct.has(k)) distinct.set(k, n);
    }
    const list = [...distinct.values()];
    const clash = list.some((a, i) =>
      list.slice(i + 1).some((b) => !namesConsistent(a.name, b.name)),
    );
    if (clash) {
      const [region, url] = key.split(' ');
      problems.push(
        `${url} (in ${region}) is named ${list.map((n) => `"${n.name}" on ${n.page}`).join(', ')}`,
      );
    }
  }
  return problems.sort();
}

/** Rule 4, the title half: every page has a non-empty title no other page has. */
export function titleProblems(pages: readonly { page: string; title: string }[]): string[] {
  const problems: string[] = [];
  const byTitle = new Map<string, string[]>();
  for (const p of pages) {
    const title = p.title.trim();
    if (title === '') {
      problems.push(`${p.page} has no title`);
      continue;
    }
    if (!byTitle.has(title)) byTitle.set(title, []);
    byTitle.get(title)!.push(p.page);
  }
  for (const [title, where] of byTitle) {
    if (where.length > 1) problems.push(`"${title}" is the title of ${where.join(', ')}`);
  }
  return problems;
}
