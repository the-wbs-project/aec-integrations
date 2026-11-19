/**
 * AECI-1918 — a prose table's scroll box is a named keyboard stop only while
 * its table overflows. jsdom does no layout, so the widths are stubbed. The
 * real overflow, focus ring and arrow-key scroll are measured in
 * `e2e/docs.spec.ts`.
 */
import { describe, expect, it } from 'vitest';

import { markScrollBox, scrollBoxName } from './prose-table-scroll';

/** A `.aec-prose` element holding fixed fixture markup, attached to the document. */
function prose(markup: string, parent: HTMLElement = document.body): HTMLElement {
  const root = document.createElement('div');
  root.className = 'aec-prose';
  root.appendChild(document.createRange().createContextualFragment(markup));
  parent.appendChild(root);
  return root;
}

const TABLE = '<div class="aec-prose-table-scroll"><table><tr><td>x</td></tr></table></div>';

function widths(box: HTMLElement, scroll: number, client: number): void {
  Object.defineProperty(box, 'scrollWidth', { configurable: true, value: scroll });
  Object.defineProperty(box, 'clientWidth', { configurable: true, value: client });
}

const boxIn = (root: HTMLElement): HTMLElement =>
  root.querySelector<HTMLElement>('.aec-prose-table-scroll')!;

describe('markScrollBox', () => {
  it('makes an overflowing box a focusable, named region', () => {
    const root = prose(`<h2>Events</h2><div class="contents"><p>Lead.</p>${TABLE}</div>`);
    const box = boxIn(root);
    widths(box, 363, 288);
    markScrollBox(box, root);
    expect(box.getAttribute('tabindex')).toBe('0');
    expect(box.getAttribute('role')).toBe('region');
    expect(box.getAttribute('aria-label')).toBe('Events');
    root.remove();
  });

  it('clears all three once the table fits, and accepts the table as the target', () => {
    const root = prose(`<h2>Events</h2>${TABLE}`);
    const box = boxIn(root);
    widths(box, 400, 288);
    markScrollBox(box, root);
    widths(box, 600, 600);
    markScrollBox(root.querySelector('table')!, root);
    expect(box.hasAttribute('tabindex')).toBe(false);
    expect(box.hasAttribute('role')).toBe(false);
    expect(box.hasAttribute('aria-label')).toBe(false);
    root.remove();
  });

  it('leaves the words alone', () => {
    const root = prose(`<h2>Events</h2>${TABLE}`);
    const before = root.textContent;
    const box = boxIn(root);
    widths(box, 400, 288);
    markScrollBox(box, root);
    expect(root.textContent).toBe(before);
    root.remove();
  });
});

describe('scrollBoxName', () => {
  it('prefers the table caption', () => {
    const root = prose(
      '<h2>Events</h2><div class="aec-prose-table-scroll"><table><caption> Who gets what </caption></table></div>',
    );
    expect(scrollBoxName(boxIn(root), root)).toBe('Who gets what');
    root.remove();
  });

  it('takes the nearest heading above, across block wrappers, any level', () => {
    const root = prose(
      `<h2>First</h2><div class="contents"><p>a</p></div><h3>Second</h3><div class="contents"><h4>Third</h4><p>b</p>${TABLE}</div>`,
    );
    expect(scrollBoxName(boxIn(root), root)).toBe('Third');
    root.remove();
  });

  it('falls back to the page h1 when the prose has no heading above the table', () => {
    const main = document.createElement('main');
    const h1 = document.createElement('h1');
    h1.textContent = 'Checking before you buy';
    main.appendChild(h1);
    document.body.appendChild(main);
    const root = prose(TABLE, main);
    expect(scrollBoxName(boxIn(root), root)).toBe('Checking before you buy');
    main.remove();
  });
});
