import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { SectionNav, type SectionNavItem } from './section-nav';

const sections: SectionNavItem[] = [
  { id: 'about', label: 'About' },
  { id: 'how-teams-use-it', label: 'How teams use it' },
  { id: 'integrations', label: 'Integrations' },
];

@Component({
  imports: [SectionNav],
  template: `<aec-section-nav [basePath]="'/products/egnyte'" [sections]="items()" />`,
})
class Host {
  items = signal<readonly SectionNavItem[]>(sections);
}

function setup(items: readonly SectionNavItem[] = sections) {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.items.set(items);
  fixture.detectChanges();
  return fixture;
}

describe('SectionNav', () => {
  it('renders one anchor per section with a path-preserving absolute href + label', () => {
    const links = (setup().nativeElement as HTMLElement).querySelectorAll('nav a');
    expect(links).toHaveLength(3);
    // Absolute path (not "/#about") so <base href="/"> can't drop the route;
    // native same-document fragment scrolling then handles the jump + offset.
    expect(links[0]?.getAttribute('href')).toBe('/products/egnyte#about');
    expect(links[0]?.textContent?.trim()).toBe('About');
    expect(links[2]?.getAttribute('href')).toBe('/products/egnyte#integrations');
    expect(links[2]?.textContent?.trim()).toBe('Integrations');
  });

  it('exposes a nav landmark labelled "On this page"', () => {
    const nav = (setup().nativeElement as HTMLElement).querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('On this page');
  });

  it('marks the first link current before any interaction (AECI-831)', () => {
    const el = setup().nativeElement as HTMLElement;
    const current = el.querySelectorAll('a[aria-current="location"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(el.querySelector('nav a'));
  });

  it('marks the clicked link aria-current="location" for instant feedback', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const link = el.querySelectorAll('nav a')[2] as HTMLAnchorElement; // Integrations

    link.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
    fixture.detectChanges();

    expect(link.getAttribute('aria-current')).toBe('location');
    // Only one link is active at a time.
    expect(el.querySelectorAll('a[aria-current="location"]')).toHaveLength(1);
  });

  it('never prevents the native jump, so the browser does the scrolling (AECI-1655)', () => {
    const fixture = setup();
    const link = (fixture.nativeElement as HTMLElement).querySelectorAll('nav a')[1]!;

    const click = new MouseEvent('click', { cancelable: true, bubbles: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
  });

  it('marks the link current when the click lands on a child of the anchor', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const link = el.querySelectorAll('nav a')[1] as HTMLAnchorElement;
    const inner = document.createElement('span');
    link.appendChild(inner);

    inner.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
    fixture.detectChanges();

    expect(link.getAttribute('aria-current')).toBe('location');
  });

  it('ignores a click on the nav outside any link', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector('ul')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    // Still the first-link default.
    expect(el.querySelector('a[aria-current="location"]')).toBe(el.querySelector('nav a'));
  });
});
