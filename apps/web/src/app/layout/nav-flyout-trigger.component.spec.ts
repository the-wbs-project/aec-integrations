import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { NavFlyoutTrigger } from './nav-flyout-trigger';

function term(slug: string, name: string): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count: 0 };
}

@Component({
  imports: [NavFlyoutTrigger],
  template: `<aec-nav-flyout-trigger [kind]="kind" [items]="items" />`,
})
class Host {
  kind: TaxonomyKind = 'category';
  items: TaxonomyTermWithCount[] = [term('bim', 'BIM Authoring'), term('est', 'Estimating')];
}

function render(kind: TaxonomyKind): {
  root: HTMLElement;
  detect: () => void;
  whenStable: () => Promise<void>;
} {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.kind = kind;
  fixture.detectChanges();
  return {
    root: fixture.nativeElement as HTMLElement,
    detect: () => fixture.detectChanges(),
    whenStable: async () => {
      await fixture.whenStable();
    },
  };
}

describe('NavFlyoutTrigger', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the index link as a collapsed disclosure trigger without an arrow button', () => {
    const { root } = render('category');

    const link = root.querySelector('a[href="/categories"]') as HTMLAnchorElement;
    expect(link?.textContent?.trim()).toBe('Categories');
    expect(link.getAttribute('aria-expanded')).toBe('false');
    expect(link.getAttribute('aria-controls')).toBe('nav-flyout-category');
    expect(link.getAttribute('aria-haspopup')).toBe('true');

    // Yahoo Finance pattern: no separate arrow button
    expect(root.querySelector('button')).toBeNull();

    const panel = root.querySelector('#nav-flyout-category') as HTMLElement;
    expect(panel.hidden).toBe(true);
  });

  it('opens on host hover (pointer enhancement) and reveals the value links', () => {
    const { root, detect } = render('category');
    const host = root.querySelector('aec-nav-flyout-trigger')!;
    const link = root.querySelector('a[href="/categories"]')!;

    host.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    detect();

    expect(link.getAttribute('aria-expanded')).toBe('true');
    const panel = root.querySelector('#nav-flyout-category') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('a[href="/categories/bim"]')?.textContent?.trim()).toBe(
      'BIM Authoring',
    );
    // "View all" links to the index.
    expect(panel.querySelector('a[href="/categories"]')?.textContent).toContain('View all');
  });

  it('opens on ArrowDown keydown and focuses the first value link', async () => {
    const { root, detect, whenStable } = render('category');
    const link = root.querySelector<HTMLAnchorElement>('a[href="/categories"]')!;

    link.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
    );
    detect();

    expect(link.getAttribute('aria-expanded')).toBe('true');
    const panel = root.querySelector('#nav-flyout-category') as HTMLElement;
    expect(panel.hidden).toBe(false);

    // The focus move waits for the render that clears `[hidden]` (afterNextRender),
    // so it lands only once the panel is actually displayed.
    await whenStable();
    const firstLink = panel.querySelector<HTMLAnchorElement>('a[href="/categories/bim"]')!;
    expect(document.activeElement).toBe(firstLink);
  });

  it('Escape closes an open flyout and returns focus to the trigger link', () => {
    const { root, detect } = render('category');
    const host = root.querySelector('aec-nav-flyout-trigger')!;
    const link = root.querySelector<HTMLAnchorElement>('a[href="/categories"]')!;

    host.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    detect();
    expect(link.getAttribute('aria-expanded')).toBe('true');

    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    detect();

    expect(link.getAttribute('aria-expanded')).toBe('false');
    const panel = root.querySelector('#nav-flyout-category') as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it.each([
    ['audience', '/audiences', 'Audiences'],
    ['phase', '/phases', 'Phases'],
    ['trade', '/trades', 'Trades'],
  ] as const)('maps kind %s to its index link and label', (kind, href, label) => {
    const { root } = render(kind);
    expect(root.querySelector(`a[href="${href}"]`)?.textContent?.trim()).toBe(label);
  });
});
