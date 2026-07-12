import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { HomeClosingCta } from './home-closing-cta';

/**
 * The home closing CTA is now a thin wrapper (AECI-327): the email signup itself
 * lives in the shared `aec-mailing-list-signup` band (covered by its own spec).
 * Here we only assert the wrapper's own responsibilities — it renders the band and
 * projects the home-only "suggest a tool" feedback trigger, which flips the
 * `@defer`-gated feedback dialog on.
 */
function setup() {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideHttpClient(), provideHttpClientTesting()],
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

  it('renders the shared mailing-list band with the subscribe form', () => {
    const { el } = setup();
    expect(el.querySelector('aec-mailing-list-signup')).not.toBeNull();
    expect(el.querySelector('#mailing-list-email')).not.toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Subscribe');
  });

  it('projects the "suggest a tool" feedback entry into the band', () => {
    const { el } = setup();
    expect(suggestButton(el)).toBeTruthy();
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
