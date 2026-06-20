import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { SiteHeader } from './site-header';

/**
 * The header's auth affordance (Phase 5 §4.4). `SessionStatus.signedIn()` is
 * the cache-neutral signal: `false` is the SSR/pre-hydration default (so the
 * cached HTML carries the neutral "Sign in" link for every visitor), and it
 * flips to `true` only after the browser-only probe. Here we stub the signal
 * directly and pin both rendered branches; the probe timing itself is covered
 * by `auth/session-status.component.spec.ts`.
 */
describe('SiteHeader auth affordance', () => {
  let signedIn: WritableSignal<boolean>;

  beforeEach(() => {
    signedIn = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: SessionStatus, useValue: { signedIn } },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(SiteHeader);
    fixture.detectChanges();
    return fixture;
  }

  it('shows the neutral "Sign in" link and no account link when signed out', () => {
    const el = render().nativeElement as HTMLElement;
    const signIn = el.querySelector('a[href="/auth/login"]');
    expect(signIn?.textContent?.trim()).toBe('Sign in');
    expect(el.querySelector('a[href="/account"]')).toBeNull();
  });

  it('swaps to a labelled account link (no "Sign in") once the probe reports a session', () => {
    const fixture = render();
    signedIn.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const account = el.querySelector('a[href="/account"]');
    expect(account).not.toBeNull();
    // Icon-only control must carry an accessible name.
    expect(account?.getAttribute('aria-label')).toBe('Account');
    expect(account?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('a[href="/auth/login"]')).toBeNull();
  });
});
