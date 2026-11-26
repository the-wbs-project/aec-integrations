/**
 * AECI-1813: one admin category menu open at a time. Opening a category closes its
 * siblings at once, even while one of them is inside its 260ms close grace.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminNavDropdown } from './admin-nav-dropdown';
import type { AdminNavGroup } from './admin-nav';
import { AdminSummaryStore } from './admin-summary.store';

const FIRST: AdminNavGroup = {
  id: 'operations',
  heading: 'Operations',
  items: [
    { path: '/admin/reviews', label: 'Reviews' },
    { path: '/admin/requests', label: 'Requests' },
  ],
};

const SECOND: AdminNavGroup = {
  id: 'insights',
  heading: 'Insights',
  items: [
    { path: '/admin/overview', label: 'Overview' },
    { path: '/admin/activity', label: 'Activity' },
  ],
};

@Component({ template: '' })
class Blank {}

@Component({
  imports: [AdminNavDropdown],
  template: `<nav>
    <aec-admin-nav-dropdown id="first" [group]="first" />
    <aec-admin-nav-dropdown id="second" [group]="second" />
  </nav>`,
})
class TwoMenus {
  first = FIRST;
  second = SECOND;
}

describe('AdminNavDropdown: one category open at a time (AECI-1813)', () => {
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

  async function render() {
    const fixture = TestBed.createComponent(TwoMenus);
    document.body.appendChild(fixture.nativeElement as HTMLElement);
    fixture.detectChanges();
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const settle = async () => {
      TestBed.tick();
      await fixture.whenStable();
      TestBed.tick();
    };
    const hostOf = (id: string) => root.querySelector<HTMLElement>(`#${id}`)!;
    const trigger = (id: string) => hostOf(id).querySelector<HTMLButtonElement>('button')!;
    const open = (id: string) => trigger(id).getAttribute('aria-expanded') === 'true';
    const done = () => (fixture.nativeElement as HTMLElement).remove();
    return { settle, hostOf, trigger, open, done };
  }

  it('closes the first menu at once when the pointer reaches the second, inside the grace', async () => {
    const { settle, hostOf, open, done } = await render();
    hostOf('first').dispatchEvent(new MouseEvent('mouseenter'));
    await settle();
    expect(open('first')).toBe(true);
    // Leaving starts the 260ms grace, so the first menu is still open.
    hostOf('first').dispatchEvent(new MouseEvent('mouseleave'));
    await settle();
    expect(open('first')).toBe(true);
    hostOf('second').dispatchEvent(new MouseEvent('mouseenter'));
    await settle();
    expect(open('second')).toBe(true);
    expect(open('first')).toBe(false);
    done();
  });

  it('closes the other menu when one opens from a click or the keyboard', async () => {
    const { settle, trigger, open, done } = await render();
    trigger('first').click();
    await settle();
    expect(open('first')).toBe(true);
    // Enter on a focused button is a click.
    trigger('second').focus();
    trigger('second').click();
    await settle();
    expect(open('second')).toBe(true);
    expect(open('first')).toBe(false);
    trigger('first').click();
    await settle();
    expect(open('first')).toBe(true);
    expect(open('second')).toBe(false);
    done();
  });

  it('carries no aria-haspopup: the panel is a list of links, not a menu', async () => {
    const { trigger, done } = await render();
    expect(trigger('first').hasAttribute('aria-haspopup')).toBe(false);
    expect(trigger('first').getAttribute('aria-controls')).toBe(`${FIRST.id}-panel`);
    done();
  });
});
