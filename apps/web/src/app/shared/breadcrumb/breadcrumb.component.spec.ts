/**
 * AECI-1777 - `aec-breadcrumb`, the one breadcrumb. Pins the landmark, the
 * separator, `aria-current` and the Forest tone. jsdom runs no Tailwind, so the
 * 7.96:1 link colour is measured in the browser, not here.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AecBreadcrumb, homeCrumb, type BreadcrumbItem } from './breadcrumb';

describe('AecBreadcrumb', () => {
  let fixture: ComponentFixture<AecBreadcrumb>;

  function render(
    items: BreadcrumbItem[],
    opts: { tone?: 'default' | 'on-brand'; truncate?: boolean } = {},
  ): HTMLElement {
    fixture.componentRef.setInput('items', items);
    if (opts.tone) fixture.componentRef.setInput('tone', opts.tone);
    if (opts.truncate) fixture.componentRef.setInput('truncate', true);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    fixture = TestBed.createComponent(AecBreadcrumb);
  });

  it('is a nav named Breadcrumb holding an ordered list', () => {
    const host = render([homeCrumb(), { label: 'Products' }]);
    const nav = host.querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('Breadcrumb');
    expect(nav?.querySelector('ol')).not.toBeNull();
    expect(host.querySelectorAll('li')).toHaveLength(2);
  });

  it('links ancestors and marks the last item as the current page, as text', () => {
    const host = render([homeCrumb(), { label: 'Products', link: '/products' }, { label: 'Revu' }]);
    const links = Array.from(host.querySelectorAll('a')).map((a) => [
      a.textContent?.trim(),
      a.getAttribute('href'),
    ]);
    expect(links).toEqual([
      ['Home', '/'],
      ['Products', '/products'],
    ]);
    const current = host.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0].tagName).toBe('SPAN');
    expect(current[0].textContent?.trim()).toBe('Revu');
    expect(current[0].closest('li')).toBe(host.querySelectorAll('li')[2]);
  });

  it('draws one separator between items, an aria-hidden › and never a slash or arrow', () => {
    const host = render([homeCrumb(), { label: 'A', link: '/a' }, { label: 'B' }]);
    const seps = Array.from(host.querySelectorAll('[aria-hidden="true"]'));
    expect(seps).toHaveLength(2);
    for (const sep of seps) expect(sep.textContent).toBe('›');
    expect(host.textContent).not.toMatch(/[/→>]/);
  });

  it('keeps a text ancestor as plain text, without aria-current', () => {
    const host = render([homeCrumb(), { label: 'Admin area' }, { label: 'Page' }]);
    const middle = host.querySelectorAll('li')[1];
    expect(middle.querySelector('a')).toBeNull();
    expect(middle.querySelector('[aria-current]')).toBeNull();
  });

  it('marks nothing current when the last item is a link', () => {
    // The docs top bar ends an article's trail on its section link.
    const host = render([homeCrumb(), { label: 'Section', link: '/docs/trust' }]);
    expect(host.querySelector('[aria-current]')).toBeNull();
    expect(host.querySelectorAll('a')).toHaveLength(2);
  });

  it('carries a fragment on a link', () => {
    const host = render([
      { label: 'Revu', link: ['/products', 'revu'], fragment: 'integrations' },
      { label: 'Other' },
    ]);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/products/revu#integrations');
  });

  it('takes the secondary Forest ink on a Forest ground, and never the tertiary one', () => {
    const host = render(
      [homeCrumb(), { label: 'Products', link: '/products' }, { label: 'Revu' }],
      {
        tone: 'on-brand',
      },
    );
    const html = host.innerHTML;
    expect(html).toContain('text-(--text-on-brand-secondary)');
    expect(html).toContain('focus-visible:outline-(--focus-ring-on-brand)');
    expect(html).not.toContain('text-tertiary');
    expect(html).not.toContain('--text-tertiary');
    expect(host.querySelector('[aria-current="page"]')?.className).toContain(
      'text-(--text-on-brand)',
    );
  });

  it('uses the tertiary separator on white', () => {
    const host = render([homeCrumb(), { label: 'Revu' }]);
    expect(host.querySelector('[aria-hidden="true"]')?.className).toContain(
      'text-(--text-tertiary)',
    );
  });

  it('wraps by default and stays on one line when asked to truncate', () => {
    expect(render([homeCrumb(), { label: 'A' }]).querySelector('ol')?.className).toContain(
      'flex-wrap',
    );
    const f2 = TestBed.createComponent(AecBreadcrumb);
    f2.componentRef.setInput('items', [homeCrumb(), { label: 'A' }]);
    f2.componentRef.setInput('truncate', true);
    f2.detectChanges();
    const ol = (f2.nativeElement as HTMLElement).querySelector('ol');
    expect(ol?.className).toContain('flex-nowrap');
    expect(ol?.className).not.toContain('flex-wrap');
  });
});
