import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
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
        // The signed-in affordance is now `<aec-user-menu>`; stub its deps so the
        // header spec stays focused on which affordance renders (the menu's own
        // behaviour is covered by user-menu.component.spec.ts).
        {
          provide: AdminStatus,
          useValue: { isAdmin: signal(false), ensureProbed: () => Promise.resolve() },
        },
        { provide: AdminSummaryStore, useValue: { pendingReviews: signal<number | null>(null) } },
        { provide: AuthService, useValue: {} },
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

  it('swaps to the account menu (no "Sign in") once the probe reports a session', () => {
    const fixture = render();
    signedIn.set(true);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const menu = el.querySelector('aec-user-menu');
    expect(menu).not.toBeNull();
    // The icon-only trigger must carry an accessible name.
    const trigger = menu?.querySelector('button');
    expect(trigger?.getAttribute('aria-label')).toBe('Account menu');
    expect(trigger?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('a[href="/auth/login"]')).toBeNull();
  });

  /**
   * The row is width-budgeted (DESIGN.md §Navigation): four taxonomy flyouts
   * plus the overflow menu is what fits at `lg`. Pin the item set and its order
   * so a new top-level entry can't slip in without the re-measure that rule
   * requires — and so Updates stays where it moved to, inside "More".
   */
  it('renders exactly the six primary destinations plus the More overflow menu', () => {
    const el = render().nativeElement as HTMLElement;
    const nav = el.querySelector('nav[aria-label="Primary"]')!;

    const topLevel = Array.from(nav.children).map((child) =>
      child.tagName === 'A'
        ? child.textContent?.trim()
        : (child.querySelector('a, button')?.textContent?.trim() ?? child.tagName.toLowerCase()),
    );
    expect(topLevel).toEqual([
      'Home',
      'Products',
      'Categories',
      'Trades',
      'Audiences',
      'Phases',
      'More',
    ]);

    expect(nav.querySelector('aec-nav-more-trigger')).not.toBeNull();
    // Updates is no longer a top-level link — it lives inside the More panel,
    // which renders server-side (hidden, not unmounted) so it stays crawlable.
    expect(nav.querySelector(':scope > a[href="/updates"]')).toBeNull();
    expect(nav.querySelector('aec-nav-more-trigger a[href="/updates"]')).not.toBeNull();
  });

  /**
   * Search mounts three times at three widths (hamburger / icon / inline box).
   * The header owns two of them, and their visibility classes are complementary
   * by construction: the icon is `lg:block xl:hidden`, the box is `xl:block`.
   * If either drifts, one width band renders two search inputs or none — the
   * second being the bug this trigger was added to fix (1024–1279 was bare).
   */
  it('mounts both the compact search trigger and the inline box, on complementary bands', () => {
    const el = render().nativeElement as HTMLElement;

    const compact = el.querySelector('aec-search-trigger')!;
    expect(compact).not.toBeNull();
    const compactClasses = compact.className.split(/\s+/);
    expect(compactClasses).toContain('lg:block');
    expect(compactClasses).toContain('xl:hidden');

    const inline = el.querySelector('aec-search-autocomplete')!;
    const inlineClasses = inline.className.split(/\s+/);
    expect(inlineClasses).toContain('hidden');
    expect(inlineClasses).toContain('xl:block');
  });

  /**
   * The `<label for>` in each `aec-search-autocomplete` is only correct while the
   * ids are unique. The inline box is the header's own; `header-search-compact`
   * lives in the trigger's overlay and `mobile-search` in the hamburger's, both
   * unmounted until opened — so the only id in the SSR'd header must be this one.
   */
  it('renders exactly one search input server-side, with the inline id', () => {
    const el = render().nativeElement as HTMLElement;
    const inputs = Array.from(el.querySelectorAll('input[type="search"]'));
    expect(inputs.map((i) => i.id)).toEqual(['header-search']);
  });
});
