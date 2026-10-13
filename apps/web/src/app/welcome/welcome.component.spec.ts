/**
 * AECI-1296 — `/welcome`, the first-sign-in "About you" form. Pins: the pending
 * gate, the Google-name suggestion, the vendor branch, save and skip both going
 * to `next`, and the analytics events never carrying firm or LinkedIn.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { AccountProfileResponse } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { AccountApi } from '../account/account-api';
import { WelcomePage, welcomeNextPath } from './welcome';

const PROFILE: AccountProfileResponse = {
  user_id: 'u-1',
  email: 'ada@example.com',
  display_name: null,
  listing_view_preference: null,
  role: 'reviewer',
  pending_reviews: null,
  pending_requests: null,
  pending_claims: null,
  pending_reindex: null,
  details: {
    company_type: null,
    company_size: null,
    primary_role: null,
    firm_name: null,
    linkedin_url: null,
    audience_ids: [],
  },
  onboarding: 'pending',
  suggested_display_name: 'Ada Lovelace',
};

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(
  profile: Partial<AccountProfileResponse> = {},
  next = '/products/acme',
  navResult = true,
) {
  const api = {
    getProfile: vi.fn(async () => ({ ...PROFILE, ...profile })),
    updateProfile: vi.fn(async () => ({ ...PROFILE, onboarding: 'completed' })),
    listAudiences: vi.fn(async () => []),
  };
  const analytics = { onboardingCompleted: vi.fn(), onboardingSkipped: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AccountApi, useValue: api },
      { provide: Analytics, useValue: analytics },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap({ next }) } },
      },
    ],
  });
  const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(navResult);
  const fixture = TestBed.createComponent(WelcomePage);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  await settle();
  fixture.detectChanges();
  return { fixture, api, analytics, navigate, el: fixture.nativeElement as HTMLElement };
}

describe('WelcomePage', () => {
  it('pre-fills the display name from the Google name when none is set', async () => {
    const { el } = await setup();
    expect(el.querySelector<HTMLInputElement>('#welcome-display-name')!.value).toBe('Ada Lovelace');
  });

  it('prefers the stored display name over the suggestion', async () => {
    const { el } = await setup({ display_name: 'Ada L.' });
    expect(el.querySelector<HTMLInputElement>('#welcome-display-name')!.value).toBe('Ada L.');
  });

  it('goes straight to next when onboarding is not pending', async () => {
    const { navigate, el } = await setup({ onboarding: 'skipped' });
    expect(navigate).toHaveBeenCalledWith('/products/acme');
    expect(el.querySelector('form')).toBeNull();
  });

  it('hides size, audiences and firm for a software vendor', async () => {
    const { el } = await setup({
      details: { ...PROFILE.details!, company_type: 'software_vendor' },
    });
    expect(el.querySelector('#welcome-company-size-trigger')).toBeNull();
    expect(el.querySelector('[data-testid="audiences"]')).toBeNull();
    expect(el.querySelector('#welcome-firm')).toBeNull();
    // No claim note or link replaces them.
    expect(el.querySelector('form a')).toBeNull();
  });

  it('saves with onboarding completed, then goes to next', async () => {
    const { fixture, el, api, analytics, navigate } = await setup({
      details: {
        ...PROFILE.details!,
        company_type: 'architect',
        primary_role: 'manager',
        firm_name: 'Acme Studio',
        linkedin_url: 'https://www.linkedin.com/in/ada',
      },
    });
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: 'Ada Lovelace',
        company_type: 'architect',
        primary_role: 'manager',
        firm_name: 'Acme Studio',
        onboarding: 'completed',
      }),
    );
    expect(navigate).toHaveBeenCalledWith('/products/acme');
    const props = analytics.onboardingCompleted.mock.calls[0]![0];
    expect(props).toEqual({
      source: 'welcome',
      company_type: 'architect',
      company_size: null,
      primary_role: 'manager',
      audience_count: 0,
    });
    expect(JSON.stringify(props)).not.toContain('Acme');
    expect(JSON.stringify(props)).not.toContain('linkedin');
  });

  it('keeps Save enabled and, on an empty display name, shows the error and focuses it', async () => {
    const { fixture, el, api } = await setup({ suggested_display_name: null });
    const save = el.querySelector<HTMLButtonElement>('[data-testid="welcome-save"]')!;
    expect(save.disabled).toBe(false);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(el.querySelector('#welcome-display-name-error')).not.toBeNull();
    const name = el.querySelector('#welcome-display-name')!;
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(name);
  });

  it('on a bad LinkedIn link, shows its error and focuses it instead of saving', async () => {
    const { fixture, el, api } = await setup({
      details: { ...PROFILE.details!, linkedin_url: 'example.com/me' },
    });
    expect(el.querySelector<HTMLButtonElement>('[data-testid="welcome-save"]')!.disabled).toBe(
      false,
    );
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();
    expect(api.updateProfile).not.toHaveBeenCalled();
    expect(el.querySelector('#welcome-linkedin-error')).not.toBeNull();
    expect(document.activeElement).toBe(el.querySelector('#welcome-linkedin'));
  });

  it('has one persistent polite status region and focuses the heading when the form shows', async () => {
    const { el } = await setup();
    const regions = el.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    const status = el.querySelector('[data-testid="welcome-status"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent?.trim()).toBe(
      'The form is ready. Only the display name is required.',
    );
    expect(document.activeElement).toBe(el.querySelector('#welcome-title'));
  });

  it('carries the new lede and stacks the footer below sm with Save on top', async () => {
    const { el } = await setup();
    expect(el.textContent).toContain('A few questions about where you work.');
    expect(el.textContent).not.toContain('It takes a minute');
    const save = el.querySelector('[data-testid="welcome-save"]')!;
    const footer = save.parentElement!;
    expect(footer.classList).toContain('flex-col-reverse');
    expect(footer.classList).toContain('sm:flex-row');
    // DOM order stays Skip, then Save, so the keyboard order matches the row.
    expect(footer.firstElementChild?.getAttribute('data-testid')).toBe('welcome-skip');
  });

  it('skips with onboarding skipped, then goes to next', async () => {
    const { el, api, analytics, navigate } = await setup();
    (el.querySelector('[data-testid="welcome-skip"]') as HTMLButtonElement).click();
    await settle();
    expect(api.updateProfile).toHaveBeenCalledWith({ onboarding: 'skipped' });
    expect(analytics.onboardingSkipped).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/products/acme');
  });

  it('falls back to a full load when the client navigation throws, and re-enables Skip', async () => {
    const { fixture, el, navigate } = await setup();
    navigate.mockRejectedValueOnce(new Error('nav failed'));
    const assign = vi
      .spyOn(
        fixture.componentInstance as unknown as { hardNavigate(u: string): void },
        'hardNavigate',
      )
      .mockImplementation(() => undefined);
    (el.querySelector('[data-testid="welcome-skip"]') as HTMLButtonElement).click();
    await settle();
    fixture.detectChanges();
    expect(assign).toHaveBeenCalledWith('/products/acme');
    expect((el.querySelector('[data-testid="welcome-skip"]') as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('keeps the spinner, not the load-failed alert, when an answered user leaves by full load', async () => {
    const hard = vi
      .spyOn(WelcomePage.prototype as unknown as { hardNavigate(u: string): void }, 'hardNavigate')
      .mockImplementation(() => undefined);
    const { el } = await setup({ onboarding: 'completed' }, '/products/acme', false);
    expect(hard).toHaveBeenCalledWith('/products/acme');
    expect(el.querySelector('[role="alert"]')).toBeNull();
    hard.mockRestore();
  });

  it('clears a save failure when Skip starts', async () => {
    const { fixture, el, api, navigate } = await setup();
    api.updateProfile.mockRejectedValueOnce(new Error('offline'));
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();
    expect(el.textContent).toContain('Something went wrong');
    navigate.mockReturnValueOnce(new Promise(() => undefined));
    (el.querySelector('[data-testid="welcome-skip"]') as HTMLButtonElement).click();
    await settle();
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Something went wrong');
  });

  it('still leaves when the skip write fails', async () => {
    const { el, api, navigate } = await setup();
    api.updateProfile.mockRejectedValueOnce(new Error('offline'));
    (el.querySelector('[data-testid="welcome-skip"]') as HTMLButtonElement).click();
    await settle();
    expect(navigate).toHaveBeenCalledWith('/products/acme');
  });
});

describe('welcomeNextPath', () => {
  it('keeps a same-origin path and refuses an open redirect or a loop', () => {
    expect(welcomeNextPath('/products/acme?view=table')).toBe('/products/acme?view=table');
    expect(welcomeNextPath('//evil.com')).toBe('/');
    expect(welcomeNextPath('https://evil.com')).toBe('/');
    expect(welcomeNextPath('/welcome?next=%2Fx')).toBe('/');
    expect(welcomeNextPath(null)).toBe('/');
  });
});
