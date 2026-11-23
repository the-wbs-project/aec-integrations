/**
 * AECI-1855: a pressed link in an admin nav dropdown closes its panel, as the Browse menu's
 * links do, so the panel never stays open over the new page. Its focus is then on a hidden
 * link, which `RouteFocus` treats as lost and moves to the page h1.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { focusIsLost } from '../core/route-focus';
import { AdminNavDropdown } from './admin-nav-dropdown';
import type { AdminNavGroup } from './admin-nav';
import { AdminSummaryStore } from './admin-summary.store';

const GROUP: AdminNavGroup = {
  id: 'operations',
  heading: 'Operations',
  items: [
    { path: '/admin/reviews', label: 'Reviews' },
    { path: '/admin/requests', label: 'Requests' },
  ],
};

@Component({ template: '' })
class Blank {}

@Component({
  imports: [AdminNavDropdown],
  template: `<nav data-route-focus-keep><aec-admin-nav-dropdown [group]="group()" /></nav>`,
})
class Host {
  group = signal(GROUP);
}

describe('AdminNavDropdown: a pressed link closes the panel (AECI-1855)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '**', component: Blank }]),
        { provide: AdminSummaryStore, useValue: { count: () => signal(null) } },
      ],
    });
  });

  async function openPanel() {
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();
    const panel = host.querySelector<HTMLElement>(`#${GROUP.id}-panel`)!;
    return { fixture, host, trigger, panel };
  }

  it('opens on the trigger and closes when one of its links is pressed', async () => {
    const { fixture, trigger, panel } = await openPanel();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);

    const link = panel.querySelector<HTMLAnchorElement>('a[href="/admin/requests"]')!;
    link.focus();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/admin/requests');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    (fixture.nativeElement as HTMLElement).remove();
  });

  it('leaves the pressed link in a hidden panel, which counts as lost focus, even in a keep row', async () => {
    const { fixture, panel } = await openPanel();
    const link = panel.querySelector<HTMLAnchorElement>('a[href="/admin/reviews"]')!;
    link.focus();
    expect(focusIsLost(document)).toBe(false);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    fixture.detectChanges();
    await fixture.whenStable();
    // The link is inside a `data-route-focus-keep` row, but its panel is now `[hidden]`, so
    // RouteFocus does not keep focus there: it moves it to the page h1.
    expect(panel.hidden).toBe(true);
    expect(link.closest('[data-route-focus-keep]')).not.toBeNull();
    expect(focusIsLost(document)).toBe(true);
    (fixture.nativeElement as HTMLElement).remove();
  });
});
