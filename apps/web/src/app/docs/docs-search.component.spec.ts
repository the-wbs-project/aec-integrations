/**
 * AECI-1270 — the docs search box. The SDK is never loaded: a fake
 * `DOCS_SEARCH_FACTORY` returns a fake search function that records each call.
 * The CDK overlay renders into a body-level container under jsdom, so the
 * popup is queried on `document`.
 */
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocsGuide } from './docs-content';
import { DocsSearchComponent } from './docs-search';
import { DOCS_SEARCH_FACTORY } from './docs-search.factory';
import type { DocsSearchHit } from './docs-search-hits';
import { docsGuideFilter } from './docs-search-hits';

type GlobalWithConfig = { __AECI_ALGOLIA__?: unknown };

const CONFIG = {
  appId: 'APP',
  searchKey: 'search-key',
  indexes: { products: 'p', vendors: 'v', integrations: 'i' },
  docsIndex: 'staging_docs',
};

const HITS: readonly DocsSearchHit[] = [
  {
    objectID: '/docs/reviewers/writing-a-review#before-you-start',
    path: '/docs/reviewers/writing-a-review',
    fragment: 'before-you-start',
    section: 'Reviewer guide',
    pageTitle: 'Writing a review',
    heading: [
      { text: 'Before', match: true },
      { text: ' you start', match: false },
    ],
    snippet: [{ text: '<b>not html</b>', match: false }],
  },
  {
    objectID: '/docs/account/signing-in',
    path: '/docs/account/signing-in',
    section: 'Your account',
    pageTitle: 'Signing in',
    heading: [{ text: 'Signing in', match: false }],
    snippet: [],
  },
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function render(guide: DocsGuide, hits: readonly DocsSearchHit[] = HITS) {
  const calls: [string, string][] = [];
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      {
        provide: DOCS_SEARCH_FACTORY,
        useValue: () =>
          Promise.resolve(async (query: string, g: DocsGuide) => {
            calls.push([query, docsGuideFilter(g)]);
            return hits;
          }),
      },
    ],
  });
  const fixture = TestBed.createComponent(DocsSearchComponent);
  fixture.componentRef.setInput('guide', guide);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  return { fixture, host, calls };
}

async function type(
  fixture: Awaited<ReturnType<typeof render>>['fixture'],
  input: HTMLInputElement,
  text: string,
) {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event('input'));
  fixture.detectChanges();
  await sleep(220);
  await fixture.whenStable();
  fixture.detectChanges();
}

function key(input: HTMLInputElement, name: string): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }));
}

/** One key, then the relay effect, the first-key microtask and a render. */
async function press(
  fixture: Awaited<ReturnType<typeof render>>['fixture'],
  input: HTMLInputElement,
  name: string,
) {
  key(input, name);
  fixture.detectChanges();
  await fixture.whenStable();
  await Promise.resolve();
  fixture.detectChanges();
  await fixture.whenStable();
}

describe('DocsSearchComponent', () => {
  // jsdom has no scrollIntoView. The first arrow key scrolls the entered row into view.
  const hadScroll = 'scrollIntoView' in Element.prototype;
  beforeEach(() => {
    TestBed.resetTestingModule();
    if (!hadScroll) Element.prototype.scrollIntoView = () => undefined;
  });
  afterEach(() => {
    delete (globalThis as GlobalWithConfig).__AECI_ALGOLIA__;
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
    if (!hadScroll) delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('renders nothing when the config has no docs index', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = { ...CONFIG, docsIndex: undefined };
    const { host } = await render('help');
    expect(host.querySelector('input')).toBeNull();
    expect(host.querySelector('[data-docs-search-slot]')).toBeNull();
  });

  it('renders nothing when there is no config at all', async () => {
    const { host } = await render('help');
    expect(host.innerHTML.replace(/<!--[\s\S]*?-->/g, '').trim()).toBe('');
  });

  it('names the box after the guide with a real label', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const input = host.querySelector('input')!;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(host.querySelector(`label[for="${input.id}"]`)?.textContent?.trim()).toBe(
      'Search General',
    );
    fixture.componentRef.setInput('guide', 'vendor');
    fixture.detectChanges();
    expect(host.querySelector('label')?.textContent?.trim()).toBe('Search For vendors');
  });

  // AECI-1803: the box is the shared field recipe (44px, the 3:1 field edge),
  // with its text moved past the leading glyph, as on /search.
  it('draws the input on the shared field recipe', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { host } = await render('help');
    const input = host.querySelector('input')!;
    expect(input.classList).toContain('aec-field-control');
    expect(input.classList).toContain('ps-12');
    expect(input.classList).toContain('text-t-16');
    expect(input.className).not.toMatch(/\bh-9\b|border-\(--border-default\)/);
  });

  it('sends the guide filter of the shell it sits in', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const general = await render('help');
    await type(general.fixture, general.host.querySelector('input')!, 'review');
    expect(general.calls).toEqual([['review', 'guide:help']]);

    TestBed.resetTestingModule();
    const vendor = await render('vendor');
    await type(vendor.fixture, vendor.host.querySelector('input')!, 'seat');
    expect(vendor.calls).toEqual([['seat', 'guide:vendor']]);
  });

  it('lists hits as options with marks as text, and announces the count', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    await type(fixture, host.querySelector('input')!, 'before');
    const options = document.querySelectorAll('[role="option"]');
    expect(options.length).toBe(2);
    expect(options[0]?.querySelector('mark')?.textContent).toBe('Before');
    // No collapsed whitespace between runs: the heading reads as written.
    expect(options[0]?.querySelector('mark')?.parentElement?.textContent).toBe('Before you start');
    expect(options[0]?.textContent).toContain('<b>not html</b>');
    expect(options[0]?.querySelector('b')).toBeNull();
    expect(host.querySelector('[data-docs-search-status]')?.textContent?.trim()).toBe(
      '2 matching sections',
    );
  });

  it('says No matching sections when nothing matches', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help', []);
    await type(fixture, host.querySelector('input')!, 'zzz');
    const input = host.querySelector('input')!;
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.textContent).toContain('No matching sections');
    expect(host.querySelector('[data-docs-search-status]')?.textContent?.trim()).toBe(
      'No matching sections',
    );
  });

  it('stays collapsed while the first query is in flight (AECI-1308)', async () => {
    // Aria expands on the keystroke, before any row exists. aria-expanded="true"
    // with no listbox has no aria-controls, a critical axe aria-required-attr.
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: DOCS_SEARCH_FACTORY,
          useValue: () => Promise.resolve(() => new Promise<never>(() => {})),
        },
      ],
    });
    const fixture = TestBed.createComponent(DocsSearchComponent);
    fixture.componentRef.setInput('guide', 'help');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    await type(fixture, input, 'before');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.hasAttribute('aria-controls')).toBe(false);
  });

  // AECI-1860: nothing is active until the first arrow key (the cause AECI-1687 found).
  it('has no active row when the list opens', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');
    await fixture.whenStable();
    fixture.detectChanges();

    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
    expect(document.querySelector('[role="listbox"]')?.getAttribute('data-navigated')).toBe(
      'false',
    );
  });

  it('enters at the first row on the first Down, then moves on', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');
    const options = () => [...document.querySelectorAll('[role="option"]')];

    await press(fixture, input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[0]!.id);
    expect(document.querySelector('[role="listbox"]')?.getAttribute('data-navigated')).toBe('true');
    await press(fixture, input, 'ArrowDown');
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1]!.id);
  });

  it('enters at the last row on the first Up', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');

    await press(fixture, input, 'ArrowUp');
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(input.getAttribute('aria-activedescendant')).toBe(options.at(-1)!.id);
  });

  it('starts over with no active row when the query changes', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');
    await press(fixture, input, 'ArrowDown');
    expect(input.hasAttribute('aria-activedescendant')).toBe(true);

    await type(fixture, input, 'befor');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('opens the arrowed-to row on Enter', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');

    await press(fixture, input, 'ArrowDown');
    await press(fixture, input, 'ArrowDown');
    await press(fixture, input, 'Enter');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/docs/account/signing-in'], {});
    expect(input.value).toBe('');
  });

  it('opens the first row once on Enter when none is active, with its fragment', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');
    expect(input.hasAttribute('aria-activedescendant')).toBe(false);

    await press(fixture, input, 'Enter');
    // Once: Aria's relayed Enter must not commit its silent default row as well.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/docs/reviewers/writing-a-review'], {
      fragment: 'before-you-start',
    });
  });

  it('closes on Escape', async () => {
    (globalThis as GlobalWithConfig).__AECI_ALGOLIA__ = CONFIG;
    const { fixture, host } = await render('help');
    const input = host.querySelector('input')!;
    await type(fixture, input, 'before');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    key(input, 'Escape');
    fixture.detectChanges();
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });
});
