import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InfoHint } from './info-hint';

/**
 * `InfoHint` (AECI-915) exists so explanatory copy can sit next to a label
 * without taking a paragraph of vertical space. The one thing that must hold is
 * the a11y contract it inherits from `shared/relative-time/`: the text is the
 * control's ACCESSIBLE NAME, so it is available to a screen reader and to a
 * keyboard user without the overlay ever being mounted. A regression to a
 * `title` attribute or to an `aria-describedby` on the panel would pass a visual
 * review and silently lose that.
 */
const TEXT = 'Federating models from multiple disciplines, clash detection, and review.';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('InfoHint', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function create(width: 'default' | 'wide' = 'default'): ComponentFixture<InfoHint> {
    const fixture = TestBed.createComponent(InfoHint);
    fixture.componentRef.setInput('text', TEXT);
    fixture.componentRef.setInput('width', width);
    fixture.detectChanges();
    return fixture;
  }

  function trigger(fixture: ComponentFixture<InfoHint>): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  }

  function panel(): HTMLElement | null {
    return document.querySelector('.cdk-overlay-container');
  }

  it('names the control with the text itself, not with a title attribute', () => {
    const fixture = create();

    expect(trigger(fixture).getAttribute('aria-label')).toBe(TEXT);
    expect(trigger(fixture).getAttribute('title')).toBeNull();
    // The icon is decorative; the button carries the name.
    expect(fixture.nativeElement.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the panel closed until asked, and reports its state', async () => {
    const fixture = create();
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('false');
    expect(panel()?.textContent ?? '').not.toContain(TEXT);

    trigger(fixture).click();
    await flush();
    fixture.detectChanges();

    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');
    expect(panel()?.textContent).toContain(TEXT);
  });

  it('hides the panel from assistive tech, because the name already says it', async () => {
    // Exposing it again would double the announcement — the same call
    // `relative-time.html` makes.
    const fixture = create();
    trigger(fixture).click();
    await flush();
    fixture.detectChanges();

    const content = panel()?.querySelector('[aria-hidden="true"]');
    expect(content?.textContent?.trim()).toBe(TEXT);
  });

  it('opens on hover and on focus, not on click alone', async () => {
    const fixture = create();

    trigger(fixture).dispatchEvent(new Event('mouseenter'));
    fixture.detectChanges();
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');

    trigger(fixture).dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('false');

    trigger(fixture).dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(trigger(fixture).getAttribute('aria-expanded')).toBe('true');
  });

  it('widens the panel for the multi-sentence facet hints', async () => {
    const fixture = create('wide');
    trigger(fixture).click();
    await flush();
    fixture.detectChanges();

    expect(panel()?.querySelector('[aria-hidden="true"]')?.className).toContain('max-w-sm');
  });
});
