import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { SegmentedRouteNav, type SegmentedRouteNavItem } from './segmented-route-nav';

const ITEMS: readonly SegmentedRouteNavItem[] = [
  { path: 'summary', label: 'Summary' },
  { path: 'activity', label: 'Activity' },
  { path: 'settings', label: 'Settings' },
];

@Component({
  selector: 'aec-test-segmented-route-nav-host',
  imports: [SegmentedRouteNav],
  template: `<aec-segmented-route-nav ariaLabel="Project sections" [items]="items" />`,
})
class TestHost {
  protected readonly items = ITEMS;
}

async function mount(url = '/projects/summit/summary') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'projects/:projectSlug',
          component: TestHost,
          children: [
            { path: 'summary', children: [] },
            { path: 'activity', children: [] },
            { path: 'settings', children: [] },
          ],
        },
      ]),
    ],
  });
  return RouterTestingHarness.create(url);
}

afterEach(() => TestBed.resetTestingModule());

const root = (harness: RouterTestingHarness) => harness.routeNativeElement as HTMLElement;
const links = (harness: RouterTestingHarness) => [
  ...root(harness).querySelectorAll<HTMLAnchorElement>('nav a'),
];

describe('SegmentedRouteNav', () => {
  it('renders the named landmark and items in their supplied order', async () => {
    const harness = await mount();
    const nav = root(harness).querySelector('nav');

    expect(nav?.getAttribute('aria-label')).toBe('Project sections');
    expect(links(harness).map((link) => link.textContent?.trim())).toEqual([
      'Summary',
      'Activity',
      'Settings',
    ]);
  });

  it('resolves every item relative to the route that hosts it', async () => {
    expect(links(await mount()).map((link) => link.getAttribute('href'))).toEqual([
      '/projects/summit/summary',
      '/projects/summit/activity',
      '/projects/summit/settings',
    ]);
  });

  it('marks only the current route as the page', async () => {
    const harness = await mount('/projects/summit/activity');
    const current = links(harness).filter((link) => link.getAttribute('aria-current') === 'page');

    expect(current).toHaveLength(1);
    expect(current[0]?.textContent?.trim()).toBe('Activity');
    expect(current[0]?.className).toContain('aec-segmented-route-item');
    expect(current[0]?.className).toContain('bg-(--accent-primary)');
  });

  it('keeps each segment as a native focusable link without tab or button semantics', async () => {
    const harness = await mount();

    for (const link of links(harness)) {
      expect(link.tabIndex).toBe(0);
      expect(link.getAttribute('role')).toBeNull();
      expect(link.getAttribute('aria-pressed')).toBeNull();
    }
    expect(root(harness).querySelector('[role="tablist"], [role="tab"]')).toBeNull();
  });

  it('uses a non-wrapping track that clips vertically and scrolls horizontally', async () => {
    const list = root(await mount()).querySelector('nav ul') as HTMLElement;

    expect(list.className).toContain('overflow-x-auto');
    expect(list.className).toContain('overflow-y-hidden');
    expect(list.className).toContain('whitespace-nowrap');
    expect(list.className).toContain('bg-(--surface-sunken)');
    expect(list.className).toContain('border-(--border-default)');
    expect(list.className).toContain('rounded-(--radius-md)');
  });
});
