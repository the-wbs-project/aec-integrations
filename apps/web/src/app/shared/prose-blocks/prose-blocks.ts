import { Component, input } from '@angular/core';

import type { DocsBlock } from '../../docs/docs-markdown';

/**
 * A Markdown body rendered as blocks, with an `id` on every `h2` and `h3`
 * (AECI-1720 layout pass). Used by `/legal/*` and `/methodology`, whose "On this
 * page" list links to those ids.
 *
 * Angular's `[innerHTML]` sanitizer drops `id`, and this repo never bypasses it
 * (`src/content/README.md`). So the body arrives cut at each heading
 * (`renderDocsBody`, `docs/docs-markdown.ts`), this template renders each heading
 * itself with a bound `[id]`, and only the HTML between headings goes through
 * the sanitizer. The ids are in the SSR HTML, so a deep link lands without
 * script. It is the docs article's own rendering (`docs-page.ts`), without the
 * docs widgets.
 *
 * The selector is an attribute on the caller's `<article>`, so the blocks are
 * the article's direct children and the `.aec-prose` child rules in
 * `styles.css` (`.aec-prose > :first-child`, `.aec-prose > .contents:first-child`)
 * still apply. Each run of HTML is a `display: contents` wrapper, so the prose
 * lays out as one flow, as it did as a single `[innerHTML]`.
 */
@Component({
  // An attribute on the caller's `<article>`, so the blocks are its direct
  // children (above). The `aec-` prefix keeps the rule's namespacing intent, as
  // `tr[aec-product-card]` does.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'article[aec-prose-blocks]',
  template: `
    @for (block of blocks(); track $index) {
      @if (block.heading; as heading) {
        @if (heading.level === 2) {
          <h2 [id]="heading.id">{{ heading.text }}</h2>
        } @else {
          <h3 [id]="heading.id">{{ heading.text }}</h3>
        }
      }
      @if (block.html) {
        <div class="contents" [innerHTML]="block.html"></div>
      }
    }
  `,
})
export class AecProseBlocks {
  /** The body, cut at each heading. */
  readonly blocks = input.required<readonly DocsBlock[]>();
}
