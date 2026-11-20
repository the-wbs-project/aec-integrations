/**
 * Tests for `ConsentBanner` (AECI-239). The load-bearing guarantee is cache
 * neutrality: the SSR/pre-hydration render shows NOTHING; the banner appears
 * only after the `afterNextRender` reconciliation, and only when consent is
 * still `'unknown'`. Mirrors the `ReviewCta` test shape.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConsentService, type ConsentState } from './consent';
import { ConsentBanner, bannerHeldOn } from './consent-banner';

@Component({ template: '' })
class Blank {}

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

  it('lets clicks beside the card reach the page and reserves space below the footer', async () => {
    const { fixture, el } = create('unknown');
    await hydrate(fixture);
    const region = el.querySelector('[role="region"]') as HTMLElement;
    expect(region.classList).toContain('pointer-events-none');
    expect((region.firstElementChild as HTMLElement).classList).toContain('pointer-events-auto');
    const spacer = region.previousElementSibling as HTMLElement;
    expect(spacer.getAttribute('aria-hidden')).toBe('true');
    expect(spacer.style.height).toBe(`${region.offsetHeight}px`);
  });

  // AECI-1818 (WCAG 2.4.11): the banner publishes its height on <html> so the unlayered
  // `html[data-consent-reserve]` rule in styles.css keeps a focused control clear of it.
  // jsdom has no layout and no ResizeObserver, so both are stubbed with a 120px banner.
  describe('focus is not hidden under the banner', () => {
    const root = document.documentElement;

    function withLayout(): void {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe(): void {}
          disconnect(): void {}
        },
      );
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      root.removeAttribute('data-consent-reserve');
      root.style.removeProperty('--aec-consent-reserve');
    });

    it('publishes its height on <html> while it shows', async () => {
      withLayout();
      const { fixture } = create('unknown');
      await hydrate(fixture);
      expect(root.hasAttribute('data-consent-reserve')).toBe(true);
      expect(root.style.getPropertyValue('--aec-consent-reserve')).toBe('120px');
    });

    it('clears it when the visitor decides', async () => {
      withLayout();
      const { fixture, el } = create('unknown');
      await hydrate(fixture);
      (el.querySelector('#consent-accept') as HTMLButtonElement).click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(root.hasAttribute('data-consent-reserve')).toBe(false);
      expect(root.style.getPropertyValue('--aec-consent-reserve')).toBe('');
    });

    it('never sets it when a decision was already made', async () => {
      withLayout();
      const { fixture } = create('denied');
      await hydrate(fixture);
      expect(root.hasAttribute('data-consent-reserve')).toBe(false);
    });

    it('clears it when the banner is destroyed', async () => {
      withLayout();
      const { fixture } = create('unknown');
      await hydrate(fixture);
      fixture.destroy();
      expect(root.hasAttribute('data-consent-reserve')).toBe(false);
    });
  });

  // AECI-1637 (legal agent 2026-11-20): one "Accept" on the Terms tick-box page.
  it('is held off /auth/terms, and comes back on the next page while still undecided', async () => {
    const consent = { state: signal<ConsentState>('unknown'), grant: vi.fn(), deny: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: 'auth/terms', component: Blank },
          { path: 'account', component: Blank },
        ]),
        { provide: ConsentService, useValue: consent },
      ],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/auth/terms?version=1.2&next=%2Faccount');
    const fixture = TestBed.createComponent(ConsentBanner);
    const el = fixture.nativeElement as HTMLElement;
    await hydrate(fixture);
    expect(el.querySelector('#consent-accept')).toBeNull();
    // Nothing was decided for the visitor.
    expect(consent.grant).not.toHaveBeenCalled();
    expect(consent.deny).not.toHaveBeenCalled();

    await router.navigateByUrl('/account');
    await settle();
    fixture.detectChanges();
    expect(el.querySelector('#consent-accept')).not.toBeNull();
  });

  it('bannerHeldOn matches /auth/terms only', () => {
    expect(bannerHeldOn('/auth/terms')).toBe(true);
    expect(bannerHeldOn('/auth/terms?version=1.2')).toBe(true);
    expect(bannerHeldOn('/auth/terms-of-x')).toBe(false);
    expect(bannerHeldOn('/auth/login')).toBe(false);
    expect(bannerHeldOn('/legal/terms')).toBe(false);
  });
});
