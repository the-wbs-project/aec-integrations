/**
 * Builds the docs search records (AECI-1270; `docs/STAGE_2_PRODUCT_DOCS_SPEC.md`
 * §3 "Search"). The input is the real manifest, so every anchor is an id that
 * `renderDocsBody` already gave a heading on the rendered page. Nothing here
 * re-slugs a heading.
 *
 * One record per page lede (the text before the first `h2`), with no fragment
 * and the page title as its heading. One record per `h2`, with the `h3` blocks
 * under it folded in. The closing `## Related` list is skipped: it is links,
 * not prose. The vendor guide's landing intro on `/docs/vendors` is included,
 * the same way.
 *
 * Pure and free of `.md` imports. The CI push script bundles
 * `apps/web/scripts/docs-search-records.entry.ts`, which hands it the real
 * sections, and the component spec checks it against the same manifest.
 */
import type { DocsSearchRecord } from '@aeci/shared/algolia';

import type { DocsBlock, DocsSection } from './docs-content';

export type { DocsSearchRecord } from '@aeci/shared/algolia';

/**
 * The `content` cap, in UTF-8 bytes. Algolia rejects a record over 10 KB on
 * this plan, and the other fields need room too.
 */
export const DOCS_RECORD_CONTENT_BYTES = 8000;

/** The closing list every page ends in. Never a record. */
const RELATED = 'Related';

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the entities `marked` emits: the named few, and numeric ones. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain text from rendered body HTML. No DOM: this runs in Node too. */
export function docsHtmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|li|h[1-6]|tr|td|th|pre|blockquote|div)>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts `text` to at most `bytes` UTF-8 bytes, on a character boundary. */
function capBytes(text: string, bytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= bytes) return text;
  let end = Math.min(text.length, bytes);
  while (end > 0 && encoder.encode(text.slice(0, end)).length > bytes) end -= 64;
  return text.slice(0, Math.max(end, 0)).trimEnd();
}

/**
 * The text of a run of blocks. An `h3` heading's text leads its block. An
 * `h2` heading's text does not: it is the record's `heading` already.
 */
function blocksText(blocks: readonly DocsBlock[]): string {
  return blocks
    .map((block) =>
      [block.heading?.level === 3 ? block.heading.text : '', docsHtmlToText(block.html)].join(' '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One page's text, cut at each `h2`: the lede, then each section. */
interface Cut {
  readonly lede: readonly DocsBlock[];
  readonly sections: readonly {
    readonly id: string;
    readonly text: string;
    readonly blocks: readonly DocsBlock[];
  }[];
}

function cutAtH2(blocks: readonly DocsBlock[]): Cut {
  const lede: DocsBlock[] = [];
  const sections: { id: string; text: string; blocks: DocsBlock[] }[] = [];
  for (const block of blocks) {
    if (block.heading?.level === 2) {
      sections.push({ id: block.heading.id, text: block.heading.text, blocks: [block] });
    } else if (sections.length > 0) {
      sections.at(-1)!.blocks.push(block);
    } else {
      lede.push(block);
    }
  }
  return { lede, sections };
}

/**
 * Every docs search record, in reading order: section by section, each page's
 * lede before its sections. `order` is that position, so ties rank in reading
 * order.
 */
export function buildDocsSearchRecords(
  sections: readonly DocsSection[],
): readonly DocsSearchRecord[] {
  const records: DocsSearchRecord[] = [];
  const push = (record: Omit<DocsSearchRecord, 'order' | 'content'>, content: string): void => {
    records.push({
      ...record,
      content: capBytes(content, DOCS_RECORD_CONTENT_BYTES),
      order: records.length + 1,
    });
  };

  for (const section of sections) {
    const base = { guide: section.guide, section: section.label };

    if (section.intro) {
      const cut = cutAtH2([...section.intro.lead, ...section.intro.rest]);
      const page = { ...base, page_title: section.label };
      push(
        { ...page, objectID: section.path, heading: section.label, url: section.path },
        blocksText(cut.lede) || section.summary,
      );
      for (const part of cut.sections) {
        if (part.text === RELATED) continue;
        const url = `${section.path}#${part.id}`;
        push({ ...page, objectID: url, heading: part.text, url }, blocksText(part.blocks));
      }
    }

    for (const docsPage of section.pages) {
      const page = { ...base, page_title: docsPage.title };
      const cut = cutAtH2(docsPage.blocks);
      push(
        { ...page, objectID: docsPage.path, heading: docsPage.title, url: docsPage.path },
        blocksText(cut.lede) || docsPage.description,
      );
      for (const part of cut.sections) {
        if (part.text === RELATED) continue;
        const url = `${docsPage.path}#${part.id}`;
        push({ ...page, objectID: url, heading: part.text, url }, blocksText(part.blocks));
      }
    }
  }
  return records;
}
