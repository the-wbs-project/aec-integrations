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

function render(kind: TaxonomyKind): { root: HTMLElement; detect: () => void } {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.kind = kind;
  fixture.detectChanges();
  return {
    root: fixture.nativeElement as HTMLElement,
    detect: () => fixture.detectChanges(),
  };
}

describe('NavFlyoutTrigger', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the index link and a collapsed disclosure button', () => {
    const { root } = render('category');

    const link = root.querySelector('a[routerlink], a[href="/categories"]');
    expect(root.querySelector('a[href="/categories"]')?.textContent?.trim()).toBe('Categories');

    const button = root.querySelector('button[aria-haspopup]')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('nav-flyout-category');
    expect(button.getAttribute('aria-label')).toBe('Categories menu');

    const panel = root.querySelector('#nav-flyout-category') as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(link).not.toBeNull();
  });

  it('toggles the flyout open on the disclosure button and reveals the value links', () => {
    const { root, detect } = render('category');
    const button = root.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;

    button.click();
    detect();

    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = root.querySelector('#nav-flyout-category') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector('a[href="/categories/bim"]')?.textContent?.trim()).toBe(
      'BIM Authoring',
    );
    // "View all" links to the index.
    expect(panel.querySelector('a[href="/categories"]')?.textContent).toContain('View all');
  });

  it('Escape closes an open flyout', () => {
    const { root, detect } = render('category');
    const button = root.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;
    button.click();
    detect();
    expect(button.getAttribute('aria-expanded')).toBe('true');

    const host = root.querySelector('aec-nav-flyout-trigger')!;
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    detect();

    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on host hover (pointer enhancement)', () => {
    const { root, detect } = render('audience');
    const host = root.querySelector('aec-nav-flyout-trigger')!;
    const button = root.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;

    host.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    detect();

    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it.each([
    ['audience', '/audiences', 'Audiences', 'Audiences menu'],
    ['phase', '/phases', 'Phases', 'Phases menu'],
  ] as const)('maps kind %s to its index link and labels', (kind, href, label, aria) => {
    const { root } = render(kind);
    expect(root.querySelector(`a[href="${href}"]`)?.textContent?.trim()).toBe(label);
    expect(root.querySelector('button[aria-haspopup]')?.getAttribute('aria-label')).toBe(aria);
  });
});
