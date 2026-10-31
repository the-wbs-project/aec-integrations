import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { HomeClosingCta } from './home-closing-cta';

/**
 * The home closing band (AECI-1564): a vendor call to action linking to
 * `/vendor-program`, plus the "suggest a tool" trigger that flips the
 * `@defer`-gated feedback dialog on. The mailing-list signup is gone from the home.
 */
function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const fixture = TestBed.createComponent(HomeClosingCta);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function suggestButton(el: HTMLElement): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button[type="button"]')].find((b) =>
    b.textContent?.includes('Suggest a tool'),
  ) as HTMLButtonElement | undefined;
}

describe('HomeClosingCta', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the vendor call to action linking to /vendor-program', () => {
    const { el } = setup();
    expect(el.querySelector('h2')?.textContent).toContain('If you build AEC software');
    const link = el.querySelector('a[href="/vendor-program"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Claim or list your product');
    expect(link?.className).toContain('bg-(--accent-primary)');
  });

  it('carries no mailing-list form', () => {
    const { el } = setup();
    expect(el.querySelector('aec-mailing-list-signup')).toBeNull();
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('input[type="email"]')).toBeNull();
  });

  it('never prices the plan or upsells', () => {
    const { el } = setup();
    const text = el.textContent ?? '';
    expect(text).not.toMatch(/\$|price|pricing|\bGet\b/i);
  });

  it('opens the feedback path when "Suggest a tool" is clicked', () => {
    const { fixture, el } = setup();
    const cmp = fixture.componentInstance as unknown as { feedbackOpen: () => boolean };
    expect(cmp.feedbackOpen()).toBe(false);

    suggestButton(el)!.click();
    fixture.detectChanges();

    expect(cmp.feedbackOpen()).toBe(true);
  });
});
