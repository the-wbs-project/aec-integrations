import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MoreMenuGroup } from './more-menu-links';
import { NavMoreList } from './nav-more-list';

const GROUPS: readonly MoreMenuGroup[] = [
  {
    id: 'lead',
    heading: null,
    items: [{ path: '/updates', label: 'Updates' }],
  },
  {
    id: 'ops',
    heading: 'Operations',
    items: [
      { path: '/admin/reviews', label: 'Review queue', badge: true },
      { path: '/admin/requests', label: 'Requests' },
    ],
  },
];

@Component({
  imports: [NavMoreList],
  template: `<aec-nav-more-list
    [groups]="groups"
    [pendingCount]="pending"
    (navigate)="navigated = navigated + 1"
  />`,
})
class Host {
  groups = GROUPS;
  pending = 0;
  navigated = 0;
}

describe('NavMoreList', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // A catch-all route so an activated link resolves instead of erroring.
      providers: [provideZonelessChangeDetection(), provideRouter([{ path: '**', children: [] }])],
    });
  });

  function render(pending = 0) {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.pending = pending;
    fixture.detectChanges();
    return fixture;
  }

  it('names a labelled group via aria-labelledby and leaves an unlabelled one bare', () => {
    const root = render().nativeElement as HTMLElement;
    const lists = root.querySelectorAll('ul');
    expect(lists.length).toBe(2);
    // The lead group has no heading, so nothing to point at.
    expect(lists[0]!.getAttribute('aria-labelledby')).toBeNull();
    expect(root.querySelector('#lead')).toBeNull();
    // The labelled group's <p> names its list. A <p>, not a heading — the page
    // owns its heading outline (same reasoning as the admin shell).
    expect(lists[1]!.getAttribute('aria-labelledby')).toBe('ops');
    const label = root.querySelector('#ops')!;
    expect(label.tagName).toBe('P');
    expect(label.textContent?.trim()).toBe('Operations');
  });

  it('renders one link per item with its label', () => {
    const root = render().nativeElement as HTMLElement;
    expect(root.querySelector('a[href="/updates"]')?.textContent?.trim()).toBe('Updates');
    expect(root.querySelector('a[href="/admin/requests"]')?.textContent?.trim()).toBe('Requests');
  });

  it('shows the pending count only on the badge item, and only when non-zero', () => {
    const zero = render(0).nativeElement as HTMLElement;
    expect(zero.querySelector('a[href="/admin/reviews"]')?.textContent).not.toContain('(');

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // A catch-all route so an activated link resolves instead of erroring.
      providers: [provideZonelessChangeDetection(), provideRouter([{ path: '**', children: [] }])],
    });
    const four = render(4).nativeElement as HTMLElement;
    const reviews = four.querySelector('a[href="/admin/reviews"]')!;
    expect(reviews.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('(4)');
    expect(reviews.querySelector('span.sr-only')?.textContent?.trim()).toContain(
      '4 reviews pending moderation',
    );
    // The count decorates one entry only.
    expect(four.querySelector('a[href="/admin/requests"]')?.textContent).not.toContain('(');
  });

  it('emits navigate when a link is activated (so the mobile overlay can close)', async () => {
    const fixture = render();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLAnchorElement>('a[href="/updates"]')!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.navigated).toBe(1);
    // RouterLink also starts a real navigation; let it settle inside the test so
    // it can't reject against a torn-down injector afterwards.
    await fixture.whenStable();
  });
});
