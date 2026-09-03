/**
 * AECI-694 — `<aec-relative-time>`.
 *
 * The a11y contract is the thing worth pinning, because it is the part a
 * reasonable-looking refactor would break: the control's ACCESSIBLE NAME is the
 * full instant, so a screen-reader or keyboard user never depends on a transient
 * overlay being mounted to learn when something happened. If that name were ever
 * replaced by "More info" or an `aria-describedby` pointing at the panel, the
 * compact "2d" would become the only thing announced.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RelativeTime } from './relative-time';

function setup(value: string) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(RelativeTime);
  fixture.componentRef.setInput('value', value);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

/** An ISO instant the given number of hours before the frozen clock. */
function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe('RelativeTime', () => {
  beforeEach(() => {
    // `now` is read once, at construction, so the clock has to be frozen before
    // the component exists.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T12:00:00.000Z'));
    TestBed.resetTestingModule();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders the compact span in a <time> carrying the machine-readable value', () => {
    const iso = hoursAgo(4);
    const { el } = setup(iso);
    const time = el.querySelector('time')!;
    expect(time.textContent?.trim()).toBe('4h');
    expect(time.getAttribute('datetime')).toBe(iso);
  });

  it('spells each unit compactly', () => {
    expect(setup(hoursAgo(0)).el.querySelector('time')?.textContent?.trim()).toBe('now');
    expect(setup(hoursAgo(0.5)).el.querySelector('time')?.textContent?.trim()).toBe('30m');
    expect(setup(hoursAgo(48)).el.querySelector('time')?.textContent?.trim()).toBe('2d');
    expect(
      setup(hoursAgo(24 * 14))
        .el.querySelector('time')
        ?.textContent?.trim(),
    ).toBe('2w');
    expect(
      setup(hoursAgo(24 * 60))
        .el.querySelector('time')
        ?.textContent?.trim(),
    ).toBe('2mo');
    expect(
      setup(hoursAgo(24 * 800))
        .el.querySelector('time')
        ?.textContent?.trim(),
    ).toBe('2y');
  });

  it('names the info control with the exact instant, in UTC', () => {
    // The console reports UTC everywhere else, and an operator correlating a row
    // against a Worker log is reading UTC on the other side.
    const { el } = setup('2026-08-27T14:32:11.000Z');
    const label = el.querySelector('button')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('2026');
    expect(label).toContain('UTC');
    expect(label).not.toBe('');
  });

  it('opens the panel on hover and closes it on leave', () => {
    const { fixture, el } = setup(hoursAgo(4));
    const button = el.querySelector('button')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');

    button.dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');

    button.dispatchEvent(new Event('mouseleave'));
    // A grace timer lets the pointer travel onto the panel without a flicker.
    vi.advanceTimersByTime(200);
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on focus too, so the panel is not mouse-only', () => {
    const { fixture, el } = setup(hoursAgo(4));
    const button = el.querySelector('button')!;
    button.dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('renders an unparseable value verbatim rather than throwing', () => {
    // `created_at` is a bare `z.string()` and nothing prunes `audit_log`, so a
    // historical row is allowed to hold something this build cannot parse.
    const { el } = setup('whenever');
    expect(el.querySelector('time')?.textContent?.trim()).toBe('whenever');
    expect(el.querySelector('button')?.getAttribute('aria-label')).toBe('whenever');
  });
});
