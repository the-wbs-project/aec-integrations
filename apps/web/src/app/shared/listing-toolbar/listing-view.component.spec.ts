/**
 * `createListingView()` + `ListingViewPreference` tests — the remembered
 * Cards/Table default (`?view=` on `/products` + taxonomy browse).
 *
 * Named `.component.spec.ts`-style TestBed so the browser harness fires
 * `afterNextRender` synchronously on the first change detection — the exact
 * seam the post-hydration restore lives in. Cache-neutrality is structural
 * (the remembered value is read ONLY inside `afterNextRender`, never during
 * SSR); these tests assert the reconciled result, mirroring the pair page's
 * "Remembered view" harness (`products-pair.component.spec.ts`).
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccountProfileResponse } from '@aeci/shared';

import { AccountApi } from '../../account/account-api';
import { RoleStatus } from '../../auth/role-status';
import { SessionStatus } from '../../auth/session-status';
import { createListingView } from './listing-view';
import { ListingViewPreference } from './listing-view-preference';

const LISTING_VIEW_COOKIE = 'aeci_listing_view';

function setCookie(view: 'cards' | 'table'): void {
  document.cookie = `${LISTING_VIEW_COOKIE}=${view}; path=/`;
}
function clearCookie(): void {
  document.cookie = `${LISTING_VIEW_COOKIE}=; path=/; max-age=0`;
}

/** A minimal valid profile payload; only `listing_view_preference` varies. */
function profile(view: 'cards' | 'table' | null): AccountProfileResponse {
  return {
    user_id: 'u',
    email: null,
    display_name: null,
    listing_view_preference: view,
    role: 'reviewer',
    pending_reviews: null,
    pending_requests: null,
    pending_claims: null,
    pending_reindex: null,
  };
}

describe('ListingViewPreference', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearCookie();
  });

  it('persist writes the cookie when signed out and never touches the account endpoint', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { signedIn: signal(false) } },
        { provide: RoleStatus, useValue: { profile: signal(null), ensureProbed: vi.fn() } },
        { provide: AccountApi, useValue: { updateProfile: vi.fn() } },
      ],
    });
    const pref = TestBed.inject(ListingViewPreference);
    pref.persist('table');
    expect(document.cookie).toContain(`${LISTING_VIEW_COOKIE}=table`);
  });

  it('persist PATCHes the profile (view only) when signed in, and also writes the cookie', () => {
    const updateProfile = vi.fn(() => Promise.resolve(profile('table')));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { signedIn: signal(true) } },
        {
          provide: RoleStatus,
          useValue: { profile: signal(profile('table')), ensureProbed: vi.fn() },
        },
        { provide: AccountApi, useValue: { updateProfile } },
      ],
    });
    const pref = TestBed.inject(ListingViewPreference);
    pref.persist('table');
    expect(updateProfile).toHaveBeenCalledWith({ listing_view_preference: 'table' });
    expect(document.cookie).toContain(`${LISTING_VIEW_COOKIE}=table`);
  });

  it('persist swallows a failed profile write (the cookie + URL param still hold)', () => {
    const updateProfile = vi.fn(() => Promise.reject(new Error('network')));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { signedIn: signal(true) } },
        { provide: RoleStatus, useValue: { profile: signal(null), ensureProbed: vi.fn() } },
        { provide: AccountApi, useValue: { updateProfile } },
      ],
    });
    const pref = TestBed.inject(ListingViewPreference);
    expect(() => pref.persist('cards')).not.toThrow();
    expect(document.cookie).toContain(`${LISTING_VIEW_COOKIE}=cards`);
  });

  // The regression this guards: `RoleStatus` probes once per page load and is
  // never re-fetched after our PATCH, so its snapshot still holds the pre-toggle
  // value. On the next SPA navigation to a listing page `ensureProbed()` resolves
  // instantly from the latch, and without `lastPersisted` the stale snapshot
  // would overwrite the fresh cookie and revert the user's choice.
  it('prefers a toggle made in this tab over the now-stale probed profile', () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { signedIn: signal(true) } },
        {
          provide: RoleStatus,
          // The probe landed BEFORE the toggle, so it still says `cards`.
          useValue: { profile: signal(profile('cards')), ensureProbed: vi.fn() },
        },
        {
          provide: AccountApi,
          useValue: { updateProfile: vi.fn(() => Promise.resolve(profile('table'))) },
        },
      ],
    });
    const pref = TestBed.inject(ListingViewPreference);
    expect(pref.rememberedFromProfile()).toBe('cards');
    pref.persist('table');
    expect(pref.rememberedFromProfile()).toBe('table');
    expect(pref.remembered()).toBe('table');
  });

  it('remembered prefers the profile when signed in, the cookie when not', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { signedIn: signal(true) } },
        {
          provide: RoleStatus,
          useValue: { profile: signal(profile('table')), ensureProbed: vi.fn() },
        },
        { provide: AccountApi, useValue: { updateProfile: vi.fn() } },
      ],
    });
    expect(TestBed.inject(ListingViewPreference).remembered()).toBe('table');

    TestBed.resetTestingModule();
    setCookie('cards');
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { signedIn: signal(false) } },
        { provide: RoleStatus, useValue: { profile: signal(null), ensureProbed: vi.fn() } },
        { provide: AccountApi, useValue: { updateProfile: vi.fn() } },
      ],
    });
    expect(TestBed.inject(ListingViewPreference).remembered()).toBe('cards');
  });
});

describe('createListingView', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearCookie();
  });

  function makeController(
    opts: {
      queryParams?: Record<string, string>;
      signedIn?: boolean;
      profile?: AccountProfileResponse | null;
    } = {},
  ) {
    TestBed.resetTestingModule();
    const updateProfile = vi.fn(() => Promise.resolve(profile(null)));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: { queryParamMap: of(convertToParamMap(opts.queryParams ?? {})) },
        },
        { provide: SessionStatus, useValue: { signedIn: signal(!!opts.signedIn) } },
        {
          provide: RoleStatus,
          useValue: {
            profile: signal(opts.profile ?? null),
            ensureProbed: vi.fn(async () => {}),
          },
        },
        { provide: AccountApi, useValue: { updateProfile } },
      ],
    });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const controller = TestBed.runInInjectionContext(() => createListingView());
    // A render cycle is what fires `afterNextRender` in the browser harness.
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    return { controller, navigate, updateProfile, fixture };
  }

  it('reads ?view= from the URL and keeps cards as the default', () => {
    const plain = makeController();
    expect(plain.controller.view()).toBe('cards');
    expect(plain.navigate).not.toHaveBeenCalled();

    const table = makeController({ queryParams: { view: 'table' } });
    expect(table.controller.view()).toBe('table');
  });

  it('restores a remembered table view (cookie) after hydration when the URL has no ?view=', async () => {
    setCookie('table');
    const { controller, navigate } = makeController();
    await Promise.resolve();
    expect(controller.view()).toBe('table');
    // The restore must NOT navigate — that would cancel and re-issue the
    // index page's in-flight `/api/products` fetch.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('lets an explicit ?view= in the URL win over the remembered cookie', async () => {
    setCookie('table');
    const { controller, navigate } = makeController({ queryParams: { view: 'cards' } });
    await Promise.resolve();
    expect(controller.view()).toBe('cards');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('restores from the profile after the probe when signed in', async () => {
    const { controller, navigate, fixture } = makeController({
      signedIn: true,
      profile: profile('table'),
    });
    await fixture.whenStable();
    expect(controller.view()).toBe('table');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('persists on an explicit set (cookie + profile PATCH when signed in) and navigates', () => {
    const { controller, navigate, updateProfile } = makeController({ signedIn: true });
    controller.set('table');
    expect(updateProfile).toHaveBeenCalledWith({ listing_view_preference: 'table' });
    expect(document.cookie).toContain(`${LISTING_VIEW_COOKIE}=table`);
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: { view: 'table' }, queryParamsHandling: 'merge' }),
    );
    expect(controller.view()).toBe('table');
  });
});

/** Minimal host so the harness runs a change-detection cycle (which fires the
 *  controller's `afterNextRender`). */
@Component({ template: '' })
class Host {}
