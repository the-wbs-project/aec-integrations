import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountProfileResponse } from '@aeci/shared';

import { RoleStatus } from '../auth/role-status';
import { SessionStatus } from '../auth/session-status';

import { AccountIdentity } from './account-identity';

/**
 * The account-menu identity block (AECI-850).
 *
 * This is the piece of the account menu that CAN be tested. The panel around it
 * renders into a CDK overlay that only mounts on click, and opening it needs a
 * real signed-in session no harness can fake — which is why `user-menu.component.spec.ts`
 * pins only the trigger. Rendering this component directly sidesteps the overlay
 * entirely, so the fallback chain gets real coverage instead of a manual check.
 *
 * The chain is the whole point of the component and every rung is reachable:
 * a Google account with a photo and a provider name; a magic-link account with
 * neither; an account whose `display_name` should beat the provider's name; and
 * the in-flight state where the role arrived from the `sessionStorage` hint but
 * the async session snapshot has not landed yet.
 *
 * Both status services are stubbed with plain signals. That severs the real
 * RoleStatus → SessionStatus → AuthService probe chain, so nothing here touches
 * HttpClient or `afterNextRender` — the same approach `user-menu` and
 * `site-header` take with their own stubs.
 */
describe('AccountIdentity', () => {
  let email: ReturnType<typeof signal<string | null>>;
  let avatarUrl: ReturnType<typeof signal<string | null>>;
  let fullName: ReturnType<typeof signal<string | null>>;
  let role: ReturnType<typeof signal<string | null>>;
  let profile: ReturnType<typeof signal<AccountProfileResponse | null>>;

  beforeEach(() => {
    email = signal<string | null>(null);
    avatarUrl = signal<string | null>(null);
    fullName = signal<string | null>(null);
    role = signal<string | null>(null);
    profile = signal<AccountProfileResponse | null>(null);

    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: SessionStatus, useValue: { email, avatarUrl, fullName } },
        { provide: RoleStatus, useValue: { role, profile } },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(AccountIdentity);
    fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  function lines(root: HTMLElement): string[] {
    return [...root.querySelectorAll('div > div > p')].map((p) => p.textContent!.trim());
  }

  function pill(root: HTMLElement): string | null {
    return root.querySelector('p > span')?.textContent?.trim() ?? null;
  }

  function makeProfile(displayName: string | null): AccountProfileResponse {
    return {
      user_id: 'u1',
      email: 'chris@example.com',
      display_name: displayName,
      role: 'reviewer',
      pending_reviews: null,
    };
  }

  // ── The fallback chain ─────────────────────────────────────────────────────

  it('shows the Google photo, provider name and email for an OAuth account', () => {
    avatarUrl.set('https://lh3.googleusercontent.com/a/photo');
    fullName.set('Chris Walton');
    email.set('chris@example.com');
    const { root } = render();

    const img = root.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('https://lh3.googleusercontent.com/a/photo');
    // The photo must not leak which AECi page the visitor is on to the CDN host.
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer');
    // Decorative: the name is right beside it, so a described photo would make a
    // screen reader announce the same person twice.
    expect(img.getAttribute('alt')).toBe('');

    expect(lines(root)).toEqual(['Chris Walton', 'chris@example.com']);
  });

  it('falls back to an initial letter for a magic-link account with no photo', () => {
    // The MAJORITY case, not an edge case: only Google sign-ins carry a photo.
    fullName.set(null);
    email.set('chris@example.com');
    const { root } = render();

    expect(root.querySelector('img')).toBeNull();
    const initial = root.querySelector('span[aria-hidden="true"]')!;
    expect(initial.textContent!.trim()).toBe('C');
    expect(initial.classList.contains('rounded-full')).toBe(true);
  });

  it('promotes the email to the primary line and drops the second when there is no name', () => {
    email.set('chris@example.com');
    const { root } = render();
    // Exactly one line — printing the email twice is the bug this guards.
    expect(lines(root)).toEqual(['chris@example.com']);
  });

  it('prefers the user-set display_name over the provider name', () => {
    // `display_name` was typed deliberately on /account; the provider name is
    // only the first-sign-in stand-in.
    fullName.set('Christopher J Walton');
    profile.set(makeProfile('Chris'));
    email.set('chris@example.com');
    expect(lines(render().root)).toEqual(['Chris', 'chris@example.com']);
  });

  it('carries the provider name when the role came from the cached hint', () => {
    // `RoleStatus.profile()` stays null when role() was seeded from
    // sessionStorage rather than a live probe, so display_name is unreadable and
    // the provider name has to hold the line on its own.
    role.set('admin');
    profile.set(null);
    fullName.set('Chris Walton');
    email.set('chris@example.com');
    expect(lines(render().root)).toEqual(['Chris Walton', 'chris@example.com']);
  });

  it('never renders an empty primary line while the session snapshot is in flight', () => {
    // Role lands instantly from the hint; email/name wait on the async snapshot.
    // An empty line here would collapse the reserved box and jump the menu.
    role.set('reviewer');
    const { root } = render();
    expect(lines(root)).toEqual(['Signed in']);
    expect(root.querySelector('span[aria-hidden="true"]')!.textContent!.trim()).toBe('S');
  });

  // ── The role pill ──────────────────────────────────────────────────────────

  it('labels each role, including the reviewer default', () => {
    for (const [value, label] of [
      ['admin', 'Site admin'],
      ['vendor_admin', 'Vendor admin'],
      ['reviewer', 'Reviewer'],
    ] as const) {
      TestBed.resetTestingModule();
      const roleSignal = signal<string | null>(value);
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          {
            provide: SessionStatus,
            useValue: {
              email: signal<string | null>('chris@example.com'),
              avatarUrl: signal<string | null>(null),
              fullName: signal<string | null>(null),
            },
          },
          {
            provide: RoleStatus,
            useValue: { role: roleSignal, profile: signal<AccountProfileResponse | null>(null) },
          },
        ],
      });
      const fixture = TestBed.createComponent(AccountIdentity);
      fixture.detectChanges();
      expect(pill(fixture.nativeElement as HTMLElement)).toBe(label);
    }
  });

  it('renders no pill until the role probe resolves', () => {
    // This is the cache-neutrality guarantee: role() is null through SSR and
    // pre-hydration, so no role-derived string can reach the URL-keyed cached
    // header HTML for the next visitor of that URL.
    email.set('chris@example.com');
    role.set(null);
    expect(pill(render().root)).toBeNull();
  });

  it('accents only the roles that open a portal door', () => {
    role.set('admin');
    expect(
      render().root.querySelector('p > span')!.classList.contains('bg-(--accent-primary-soft)'),
    ).toBe(true);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: SessionStatus,
          useValue: {
            email: signal<string | null>('chris@example.com'),
            avatarUrl: signal<string | null>(null),
            fullName: signal<string | null>(null),
          },
        },
        {
          provide: RoleStatus,
          useValue: {
            role: signal<string | null>('reviewer'),
            profile: signal<AccountProfileResponse | null>(null),
          },
        },
      ],
    });
    const plain = TestBed.createComponent(AccountIdentity);
    plain.detectChanges();
    const span = (plain.nativeElement as HTMLElement).querySelector('p > span')!;
    expect(span.classList.contains('bg-(--accent-primary-soft)')).toBe(false);
    // Colour is never the sole signal — the label says which role this is.
    expect(span.textContent!.trim()).toBe('Reviewer');
  });
});
