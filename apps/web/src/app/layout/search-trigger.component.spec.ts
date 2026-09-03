import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { SearchTrigger } from './search-trigger';

/**
 * The compact (`lg`–`xl`) header search trigger.
 *
 * Like `user-menu.component.spec.ts`, the panel renders into a CDK overlay that
 * only mounts on click, so what's pinned here is the always-rendered trigger:
 * its accessible name, its popup semantics, and — most importantly — the host
 * band. That band is the whole point of the component: below `lg` the hamburger
 * overlay carries search and at `xl`+ the inline box does, so this must be
 * visible in exactly the window where neither is. A regression there is silent
 * (nothing throws; search just vanishes at 1100px again), which is why the class
 * string is asserted literally rather than inferred.
 */
describe('SearchTrigger', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(SearchTrigger);
    fixture.detectChanges();
    return fixture;
  }

  function trigger(el: HTMLElement): HTMLButtonElement {
    return el.querySelector('button[brnPopoverTrigger]') ?? el.querySelector('button')!;
  }

  it('renders a labelled, button-type trigger with collapsed popup semantics', () => {
    const el = render().nativeElement as HTMLElement;
    const button = trigger(el);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Open search');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  /**
   * The handover contract with `nav-menu.ts` (`lg:hidden`) and the inline box in
   * `site-header.ts` (`hidden xl:block`). Change any one of the three and search
   * either disappears from a width band or doubles up in one.
   */
  it('is visible only across the lg–xl band, where no other search mounts', () => {
    const host = render().nativeElement as HTMLElement;
    const classes = host.className.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes).toContain('lg:block');
    expect(classes).toContain('xl:hidden');
  });

  it('renders nothing but the trigger before the panel is opened (SSR-safe)', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelectorAll('button')).toHaveLength(1);
    expect(el.querySelector('aec-search-autocomplete')).toBeNull();
    expect(el.querySelector('form[role="search"]')).toBeNull();
  });
});
