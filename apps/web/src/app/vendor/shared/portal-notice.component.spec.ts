import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { BAND_WRAP_CLASS } from '../../shared/band-wrap';
import {
  PORTAL_FIELDSET_CLASS,
  PORTAL_FORM_CLASS,
  PORTAL_FORM_GRID_CLASS,
  PORTAL_SAVE_BAR_CLASS,
  PORTAL_SAVE_BUTTON_CLASS,
} from './portal-form';
import { PORTAL_WRAP_CLASS } from './portal-layout';
import { AecPortalNotice, PORTAL_NOTICE_CLASS } from './portal-notice';

@Component({
  selector: 'aec-test-notice-host',
  imports: [AecPortalNotice],
  template: `<section aecPortalNotice aria-labelledby="h"><h2 id="h">Heading</h2></section>`,
})
class TestNoticeHost {}

/**
 * AECI-1809: the shared portal pieces later slices build on. Each assertion is a rule
 * the mock-up and the 2026-11-24 rulings set, so a later edit that drifts fails here.
 */
describe('AecPortalNotice (AECI-1809)', () => {
  it('draws the one calm notice: Bone fill, strong edge, panel radius, 24px padding', () => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    const fixture = TestBed.createComponent(TestNoticeHost);
    fixture.detectChanges();
    const section = (fixture.nativeElement as HTMLElement).querySelector('section')!;

    for (const cls of [
      'aec-portal-notice',
      'bg-(--accent-warm)',
      'border',
      'border-(--border-strong)',
      'rounded-panel',
      'p-6',
    ]) {
      expect(section.classList.contains(cls), cls).toBe(true);
    }
    // Calm: no status colour, no alert role, no shadow.
    expect(section.getAttribute('role')).toBeNull();
    expect(section.className).not.toMatch(/status-|shadow/);
    expect(section.className).toBe(PORTAL_NOTICE_CLASS);
  });
});

describe('the portal layout and form helpers (AECI-1809)', () => {
  it('puts the portal on the site page wrap', () => {
    expect(PORTAL_WRAP_CLASS.startsWith(BAND_WRAP_CLASS)).toBe(true);
  });

  it('lays fields out in two columns from 768px', () => {
    expect(PORTAL_FORM_GRID_CLASS).toContain('md:grid-cols-2');
  });

  it('sticks the save bar to the foot of the form card, button full width below 640px', () => {
    expect(PORTAL_SAVE_BAR_CLASS).toContain('sticky');
    expect(PORTAL_SAVE_BAR_CLASS).toContain('bottom-0');
    expect(PORTAL_SAVE_BAR_CLASS).toContain('justify-end');
    expect(PORTAL_SAVE_BUTTON_CLASS).toBe('max-sm:w-full');
  });

  it('keeps focused controls clear of the sticky bar, but not the bar’s own button', () => {
    // WCAG 2.4.11: the scroll margin is taller than the bar, and taller again below sm.
    expect(PORTAL_FORM_CLASS).toContain(':scroll-mb-24');
    expect(PORTAL_FORM_CLASS).toContain('max-sm:');
    expect(PORTAL_FORM_CLASS).toContain(':not(.aec-portal-save-bar_*)');
    expect(PORTAL_SAVE_BAR_CLASS.split(' ')).toContain('aec-portal-save-bar');
  });

  it('separates fieldsets with a hairline', () => {
    expect(PORTAL_FIELDSET_CLASS).toContain('[&+&]:border-t');
  });

  it('floats the legend so it sits under the hairline, not on it', () => {
    const parts = PORTAL_FIELDSET_CLASS.split(' ');
    expect(parts).toContain('[&>legend]:float-start');
    expect(parts).toContain('[&>legend]:w-full');
    expect(parts).toContain('[&>legend+*]:clear-both');
  });

  it('keeps every helper on the 4-point spacing scale (no half steps, no 5, 7, 9, 10, 11)', () => {
    const all = [PORTAL_FORM_GRID_CLASS, PORTAL_SAVE_BAR_CLASS, PORTAL_FIELDSET_CLASS];
    const step = /(?:^|:)-?(?:p|m|gap|space)[a-z]?(?:-[xy])?-([\d.]+)$/;
    for (const cls of all.join(' ').split(/\s+/)) {
      const found = cls.match(step)?.[1];
      if (found === undefined) continue;
      expect(['0', '1', '2', '3', '4', '6', '8', '12', '16', '24'], cls).toContain(found);
    }
  });
});
