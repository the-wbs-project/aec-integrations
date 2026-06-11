import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from '../auth/auth.service';

import { ReviewCta } from './review-cta';

/**
 * AECI-201 — the cache-neutral review CTA. The load-bearing guarantee is that
 * the SSR/pre-hydration render is the **neutral, non-personalized** "Write a
 * review" link; the personalized labels appear only *after* the
 * `afterNextRender` session probe resolves (browser-only). These tests pin both
 * halves: the neutral default before the probe, and each personalized state
 * after it.
 */

interface AuthMock {
  isConfigured: ReturnType<typeof vi.fn>;
  isSignedIn: ReturnType<typeof vi.fn>;
}

function makeAuthMock(opts: { configured?: boolean; signedIn?: boolean } = {}): AuthMock {
  return {
    isConfigured: vi.fn(() => opts.configured ?? true),
    isSignedIn: vi.fn(async () => opts.signedIn ?? false),
  };
}

/** Macrotask boundary — lets the async `afterNextRender` probe settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function create(slug = 'procore', auth: AuthMock = makeAuthMock()) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuthService, useValue: auth },
    ],
  });
  const fixture = TestBed.createComponent(ReviewCta);
  fixture.componentRef.setInput('slug', slug);
  return { fixture, auth, el: fixture.nativeElement as HTMLElement };
}

/** Drain the afterNextRender probe and re-render. */
async function hydrate(fixture: ReturnType<typeof create>['fixture']) {
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
}

function anchor(el: HTMLElement): HTMLAnchorElement {
  return el.querySelector('a') as HTMLAnchorElement;
}

describe('ReviewCta', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the neutral "Write a review" link before the session probe resolves', () => {
    const { fixture, el } = create();
    // First CD only — the async afterNextRender probe has not set state yet.
    fixture.detectChanges();

    expect(el.textContent).toContain('Write a review');
    expect(el.textContent).not.toContain('Sign in to review');
    expect(el.textContent).not.toContain('Submit a review');
    expect(anchor(el).getAttribute('href')).toBe('/products/procore/review');
  });

  it('hydrates to "Submit a review" for a signed-in visitor', async () => {
    const { fixture, el, auth } = create('procore', makeAuthMock({ signedIn: true }));
    await hydrate(fixture);

    expect(auth.isSignedIn).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain('Submit a review');
    expect(el.textContent).not.toContain('Sign in to review');
    expect(anchor(el).getAttribute('href')).toBe('/products/procore/review');
  });

  it('hydrates to "Sign in to review" with a return path for an anonymous visitor', async () => {
    const { fixture, el } = create('procore', makeAuthMock({ signedIn: false }));
    await hydrate(fixture);

    expect(el.textContent).toContain('Sign in to review');
    expect(el.textContent).not.toContain('Submit a review');
    // Routes to login, carrying the (encoded) return path to the review form.
    expect(anchor(el).getAttribute('href')).toBe(
      '/auth/login?return=%2Fproducts%2Fprocore%2Freview',
    );
  });

  it('stays neutral when auth is unconfigured (graceful degradation)', async () => {
    const { fixture, el, auth } = create('procore', makeAuthMock({ configured: false }));
    await hydrate(fixture);

    expect(auth.isSignedIn).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Write a review');
    expect(el.textContent).not.toContain('Sign in to review');
    expect(el.textContent).not.toContain('Submit a review');
  });
});
