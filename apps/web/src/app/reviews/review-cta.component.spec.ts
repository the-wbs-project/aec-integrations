import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountReview } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
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

interface AccountMock {
  findMyReviewForProduct: ReturnType<typeof vi.fn>;
}

const PRODUCT_ID = '00000000-0000-4000-8000-000000000001';

/** A mock `AccountApi` whose per-product lookup resolves to `review` (or
 *  rejects when `throws` is set, to exercise the degrade path). */
function makeAccountMock(
  opts: { review?: AccountReview | null; throws?: boolean } = {},
): AccountMock {
  return {
    findMyReviewForProduct: vi.fn(async () => {
      if (opts.throws) throw new Error('probe failed');
      return opts.review ?? null;
    }),
  };
}

const existingReview: AccountReview = {
  id: '00000000-0000-4000-8000-0000000000aa',
  product: { id: PRODUCT_ID, name: 'Procore', slug: 'procore' },
  rating_overall: 5,
  rating_onboarding: 4,
  title: 'Solid',
  status: 'approved',
  rejection_reason: null,
  created_at: '2026-06-01T00:00:00.000Z',
};

/** Macrotask boundary — lets the async `afterNextRender` probe settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function create(
  slug = 'procore',
  auth: AuthMock = makeAuthMock(),
  account: AccountMock = makeAccountMock(),
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AuthService, useValue: auth },
      { provide: AccountApi, useValue: account },
    ],
  });
  const fixture = TestBed.createComponent(ReviewCta);
  fixture.componentRef.setInput('slug', slug);
  fixture.componentRef.setInput('productId', PRODUCT_ID);
  return { fixture, auth, account, el: fixture.nativeElement as HTMLElement };
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

  it('hydrates to "Submit a review" for a signed-in visitor with no prior review', async () => {
    const account = makeAccountMock({ review: null });
    const { fixture, el, auth } = create('procore', makeAuthMock({ signedIn: true }), account);
    await hydrate(fixture);

    expect(auth.isSignedIn).toHaveBeenCalledTimes(1);
    expect(account.findMyReviewForProduct).toHaveBeenCalledTimes(1);
    expect(account.findMyReviewForProduct).toHaveBeenCalledWith(PRODUCT_ID);
    expect(el.textContent).toContain('Submit a review');
    expect(el.textContent).not.toContain('already reviewed');
    expect(anchor(el).getAttribute('href')).toBe('/products/procore/review');
  });

  it('hydrates to "already reviewed" with an /account link when the caller has a review', async () => {
    const account = makeAccountMock({ review: existingReview });
    const { fixture, el } = create('procore', makeAuthMock({ signedIn: true }), account);
    await hydrate(fixture);

    expect(el.textContent).toContain("You've already reviewed this");
    expect(el.textContent).not.toContain('Submit a review');
    // The affordance is a link to /account, not the primary submit button.
    expect(anchor(el).getAttribute('href')).toBe('/account');
  });

  it('falls back to "Submit a review" when the per-product lookup fails', async () => {
    const account = makeAccountMock({ throws: true });
    const { fixture, el } = create('procore', makeAuthMock({ signedIn: true }), account);
    await hydrate(fixture);

    // A lookup failure must not strand the user — the working link stays.
    expect(el.textContent).not.toContain('already reviewed');
    expect(anchor(el).getAttribute('href')).toBe('/products/procore/review');
  });

  it('hydrates to "Sign in to review" with a return path for an anonymous visitor', async () => {
    const account = makeAccountMock();
    const { fixture, el } = create('procore', makeAuthMock({ signedIn: false }), account);
    await hydrate(fixture);

    expect(el.textContent).toContain('Sign in to review');
    expect(el.textContent).not.toContain('Submit a review');
    // Anonymous visitors never trigger the authenticated lookup.
    expect(account.findMyReviewForProduct).not.toHaveBeenCalled();
    // Routes to login, carrying the (encoded) return path to the review form.
    expect(anchor(el).getAttribute('href')).toBe(
      '/auth/login?return=%2Fproducts%2Fprocore%2Freview',
    );
  });

  it('stays neutral when auth is unconfigured (graceful degradation)', async () => {
    const account = makeAccountMock();
    const { fixture, el, auth } = create('procore', makeAuthMock({ configured: false }), account);
    await hydrate(fixture);

    expect(auth.isSignedIn).not.toHaveBeenCalled();
    expect(account.findMyReviewForProduct).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Write a review');
    expect(el.textContent).not.toContain('Sign in to review');
    expect(el.textContent).not.toContain('Submit a review');
  });
});
