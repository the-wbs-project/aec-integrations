/**
 * AECI-1673 — `/accessibility`, the accessibility statement.
 *
 * `*.component.spec.ts` tier (the Angular `ng test` builder) because the page
 * imports a `.md` through the esbuild `text` loader. The wording rules counsel
 * set (Q40) are pinned against the source file in
 * `accessibility-statement.spec.ts`; this spec checks the rendered page.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Title } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

import { AccessibilityPage } from './accessibility';

function setup(): { host: HTMLElement; title: Title } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(AccessibilityPage);
  fixture.detectChanges();
  return { host: fixture.nativeElement as HTMLElement, title: TestBed.inject(Title) };
}

describe('AccessibilityPage', () => {
  // Shared jsdom <head> across component specs: strip a sibling's robots tag.
  beforeEach(() => {
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('renders the frontmatter title as the only h1', () => {
    const { host } = setup();
    expect(host.querySelectorAll('h1')).toHaveLength(1);
    expect(host.querySelector('h1')?.textContent?.trim()).toBe('Accessibility statement');
  });

  it('puts the hero on the one Bone band and the article on the page wrap (AECI-1804)', () => {
    const { host } = setup();
    const bands = host.querySelectorAll('aec-bone-band');
    expect(bands).toHaveLength(1);
    expect(bands[0].querySelector('h1')).not.toBeNull();
    const article = host.querySelector('article.aec-prose');
    expect(article?.classList).toContain('max-w-[42rem]');
    expect(article?.parentElement?.classList).toContain('max-w-[1328px]');
    expect(host.querySelector('h1')?.className).not.toMatch(/text-\d?xl|font-normal/);
  });

  it('renders the three sections in order', () => {
    const { host } = setup();
    const h2s = Array.from(host.querySelectorAll('article.aec-prose h2')).map((h) =>
      h.textContent?.trim(),
    );
    expect(h2s).toEqual(['Our standard', 'How we test', 'Report a barrier']);
  });

  it('gives the support inbox as a mailto link and the reply window', () => {
    const { host } = setup();
    const link = host.querySelector<HTMLAnchorElement>('article a[href^="mailto:"]');
    expect(link?.getAttribute('href')).toBe('mailto:support@aecintegrations.com');
    expect(link?.textContent?.trim()).toBe('support@aecintegrations.com');
    expect(host.textContent).toContain('We reply within 10 business days.');
  });

  it('shows the last-updated date', () => {
    const { host } = setup();
    expect(host.textContent).toContain('Last updated November 11, 2026');
  });

  it('sets an indexable title with no robots tag', () => {
    const { title } = setup();
    expect(title.getTitle()).toBe('Accessibility statement · AEC Integrations');
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
  });
});
