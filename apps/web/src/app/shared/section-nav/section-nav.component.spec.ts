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

  it('marks no link active before any interaction', () => {
    const el = setup().nativeElement as HTMLElement;
    expect(el.querySelector('a[aria-current]')).toBeNull();
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
});
