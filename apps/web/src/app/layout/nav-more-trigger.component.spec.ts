import { provideZonelessChangeDetection, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';

import { NavMoreTrigger } from './nav-more-trigger';

/**
 * The header's "More" overflow menu. Unlike the account menu (a CDK overlay that
 * only mounts on click), this panel is an inline `[hidden]` disclosure — so the
 * spec can assert the real link set, not just the trigger.
 *
 * Two things matter most here and both are covered below:
 *   - the admin section is invisible unless `AdminStatus.isAdmin()`, which is
 *     `false` during SSR / pre-hydration, so no admin path can reach cached HTML;
 *   - the public links render even while closed, keeping /updates, /roadmap,
 *     /about, /contact and /legal/* crawlable from the header.
 */
describe('NavMoreTrigger', () => {
  let isAdmin: WritableSignal<boolean>;
  let pendingReviews: WritableSignal<number | null>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    isAdmin = signal(false);
    pendingReviews = signal<number | null>(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        // `ensureProbed` is the AECI-617 retry seam the trigger calls on every
        // open — stubbed as a resolved no-op so the disclosure specs stay
        // focused on open/close behaviour.
        { provide: AdminStatus, useValue: { isAdmin, ensureProbed: () => Promise.resolve() } },
        { provide: AdminSummaryStore, useValue: { pendingReviews } },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(NavMoreTrigger);
    fixture.detectChanges();
    return {
      root: fixture.nativeElement as HTMLElement,
      detect: () => fixture.detectChanges(),
    };
  }

  function trigger(root: HTMLElement): HTMLButtonElement {
    return root.querySelector<HTMLButtonElement>('button[aria-haspopup]')!;
  }

  it('renders a labelled, collapsed disclosure button', () => {
    const { root } = render();
    const button = trigger(root);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent?.trim()).toContain('More');
    expect(button.getAttribute('aria-label')).toBe('More menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('nav-more-panel');
    expect((root.querySelector('#nav-more-panel') as HTMLElement).hidden).toBe(true);
  });

  it('renders the public destinations (crawlable while collapsed)', () => {
    const { root } = render();
    const panel = root.querySelector('#nav-more-panel')!;
    for (const href of [
      '/updates',
      '/roadmap',
      '/about',
      '/contact',
      '/legal/terms',
      '/legal/privacy',
      '/legal/review-guidelines',
      '/legal/listing-accuracy',
    ]) {
      expect(panel.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    }
  });

  it('hides every admin link from a non-admin', () => {
    pendingReviews.set(5);
    const { root } = render();
    expect(root.querySelectorAll('a[href^="/admin"]').length).toBe(0);
    expect(trigger(root).querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('renders all nine admin screens for an admin', () => {
    isAdmin.set(true);
    const { root } = render();
    const panel = root.querySelector('#nav-more-panel')!;
    for (const href of [
      '/admin/overview',
      '/admin/activity',
      '/admin/traffic',
      '/admin/audience',
      '/admin/catalog',
      '/admin/reviews',
      '/admin/requests',
      '/admin/reviewers',
      '/admin/system',
    ]) {
      expect(panel.querySelector(`a[href="${href}"]`), href).not.toBeNull();
    }
  });

  it('opens on the disclosure button and on host hover', () => {
    const { root, detect } = render();
    const button = trigger(root);

    button.click();
    detect();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect((root.querySelector('#nav-more-panel') as HTMLElement).hidden).toBe(false);

    button.click();
    detect();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    root.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    detect();
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('Escape closes an open menu', () => {
    const { root, detect } = render();
    const button = trigger(root);
    button.click();
    detect();
    expect(button.getAttribute('aria-expanded')).toBe('true');

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    detect();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows no badge for an admin with zero pending reviews', () => {
    isAdmin.set(true);
    pendingReviews.set(0);
    const { root } = render();
    expect(trigger(root).querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(trigger(root).getAttribute('aria-describedby')).toBeNull();
  });

  it('shows the exact count, an sr-only label, and the described-by wiring', () => {
    isAdmin.set(true);
    pendingReviews.set(3);
    const { root } = render();
    const button = trigger(root);
    expect(button.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('3');
    const srLabel = button.querySelector('span.sr-only');
    expect(srLabel?.textContent?.trim()).toContain('3 reviews pending moderation');
    // The label sits inside a button with its own aria-label, so it's only
    // announced when referenced — the trigger must point at it via described-by.
    expect(srLabel?.id).toBe(button.getAttribute('aria-describedby'));
    // The exact count also renders beside the Review queue entry.
    const reviews = root.querySelector('a[href="/admin/reviews"]')!;
    expect(reviews.textContent).toContain('(3)');
  });

  it('caps the badge at "9+" beyond nine pending reviews', () => {
    isAdmin.set(true);
    pendingReviews.set(12);
    const { root } = render();
    expect(trigger(root).querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('9+');
  });
});
