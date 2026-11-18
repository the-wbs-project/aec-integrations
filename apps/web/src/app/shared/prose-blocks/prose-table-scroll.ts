import { DestroyRef, Directive, ElementRef, afterNextRender, inject } from '@angular/core';

import { PROSE_TABLE_SCROLL_CLASS } from '../../docs/docs-markdown';

/**
 * Makes each prose table's scroll box a keyboard stop when, and only when, its
 * table is wider than the box (AECI-1918). Put it on the element that holds the
 * rendered Markdown (`.aec-prose`).
 *
 * `renderDocsBody` wraps every table in `div.aec-prose-table-scroll`, which
 * scrolls sideways so the page does not. A box that scrolls must be reachable
 * by keyboard (WCAG 2.1.1), and once it is a stop it needs a name. So an
 * overflowing box gets `tabindex="0"`, `role="region"` and an `aria-label`
 * taken from the table's caption, else the nearest heading above it, else the
 * page's `h1`. A box that fits gets none of the three, so it adds no tab stop
 * and no landmark. A `ResizeObserver` re-checks on resize and zoom.
 *
 * Browser only. The SSR HTML carries the plain wrapper, which is the same for
 * every visitor, so the cached page stays visitor-neutral. The attributes go on
 * after hydration. The text is never touched.
 */
@Directive({ selector: '[aecProseTableScroll]' })
export class AecProseTableScroll {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    const destroyRef = this.destroyRef;
    afterNextRender(() => {
      if (typeof ResizeObserver === 'undefined') return;
      const resize = new ResizeObserver((entries) => {
        for (const entry of entries) markScrollBox(entry.target as HTMLElement, this.host);
      });
      const observed = new Set<Element>();
      const scan = (): void => {
        for (const box of this.host.querySelectorAll<HTMLElement>(`.${PROSE_TABLE_SCROLL_CLASS}`)) {
          if (observed.has(box)) continue;
          observed.add(box);
          resize.observe(box);
          const table = box.querySelector('table');
          if (table) resize.observe(table);
        }
      };
      scan();
      // A new body (a version link on the same route) replaces the boxes.
      const mutations = new MutationObserver(scan);
      mutations.observe(this.host, { childList: true, subtree: true });
      destroyRef.onDestroy(() => {
        mutations.disconnect();
        resize.disconnect();
      });
    });
  }
}

/**
 * Sets or clears the keyboard stop on one scroll box, given the box or its
 * table. `root` is the prose element: the heading search stops there.
 */
export function markScrollBox(target: HTMLElement, root: HTMLElement): void {
  const box = target.classList.contains(PROSE_TABLE_SCROLL_CLASS)
    ? target
    : target.closest<HTMLElement>(`.${PROSE_TABLE_SCROLL_CLASS}`);
  if (!box) return;
  if (box.scrollWidth > box.clientWidth) {
    box.setAttribute('tabindex', '0');
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', scrollBoxName(box, root));
  } else {
    box.removeAttribute('tabindex');
    box.removeAttribute('role');
    box.removeAttribute('aria-label');
  }
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/**
 * The table's caption, else the nearest heading before the box inside `root`,
 * else the page's `h1`. The words are the page's own, so no new copy.
 */
export function scrollBoxName(box: HTMLElement, root: HTMLElement): string {
  const caption = box.querySelector('caption')?.textContent?.trim();
  if (caption) return caption;
  for (let node: Element | null = box; node && node !== root; node = node.parentElement) {
    for (let prev = node.previousElementSibling; prev; prev = prev.previousElementSibling) {
      const heading = prev.matches(HEADINGS) ? prev : [...prev.querySelectorAll(HEADINGS)].at(-1);
      const text = heading?.textContent?.trim();
      if (text) return text;
    }
  }
  const doc = box.ownerDocument;
  return (doc.querySelector('main h1') ?? doc.querySelector('h1'))?.textContent?.trim() ?? '';
}
