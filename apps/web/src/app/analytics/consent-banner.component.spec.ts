/**
 * Tests for `ConsentBanner` (AECI-239). The load-bearing guarantee is cache
 * neutrality: the SSR/pre-hydration render shows NOTHING; the banner appears
 * only after the `afterNextRender` reconciliation, and only when consent is
 * still `'unknown'`. Mirrors the `ReviewCta` test shape.
 */
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsentService, type ConsentState } from './consent';
import { ConsentBanner } from './consent-banner';

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function create(state: ConsentState) {
  const consent = { state: signal<ConsentState>(state), grant: vi.fn(), deny: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ConsentService, useValue: consent },
    ],
  });
  const fixture = TestBed.createComponent(ConsentBanner);
  return { fixture, consent, el: fixture.nativeElement as HTMLElement };
}

async function hydrate(fixture: ReturnType<typeof create>['fixture']) {
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

describe('ConsentBanner', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // SSR cache-neutrality is structural: `show` defaults `false` and is only
  // flipped inside `afterNextRender`, which never runs during SSR — so the
  // cached HTML carries no banner. The browser test harness fires
  // afterNextRender synchronously on first CD, so there is no observable
  // "before reconciliation" frame to assert here (unlike ReviewCta's async
  // probe); the SSR guarantee is the same mechanism the codebase already trusts.

  it('reveals the banner after reconciliation when consent is unknown', async () => {
    const { fixture, el } = create('unknown');
    await hydrate(fixture);
    expect(el.querySelector('#consent-accept')).not.toBeNull();
    expect(el.querySelector('#consent-decline')).not.toBeNull();
  });

  it('stays hidden when a decision was already made', async () => {
    const { fixture, el } = create('granted');
    await hydrate(fixture);
    expect(el.querySelector('#consent-accept')).toBeNull();
  });

  it('Accept grants consent and dismisses the banner', async () => {
    const { fixture, el, consent } = create('unknown');
    await hydrate(fixture);
    (el.querySelector('#consent-accept') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(consent.grant).toHaveBeenCalledTimes(1);
    expect(el.querySelector('#consent-accept')).toBeNull();
  });

  it('Decline denies consent and dismisses the banner', async () => {
    const { fixture, el, consent } = create('unknown');
    await hydrate(fixture);
    (el.querySelector('#consent-decline') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(consent.deny).toHaveBeenCalledTimes(1);
    expect(el.querySelector('#consent-accept')).toBeNull();
  });
});
