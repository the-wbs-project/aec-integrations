/**
 * The claim dialog's steps (`claim-dialog-flow.ts`, AECI-1293,
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.2): each step, Back, the plan preselect,
 * both submit paths, the 404 fallback and the analytics payloads. The BrnDialog shell
 * and the triggers are pinned in `claim-dialog.component.spec.ts`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../../analytics/analytics';
import { SessionStatus } from '../../auth/session-status';
import { RequestsApi } from '../../requests/requests-api';
import type { AutocompleteSuggestion } from '../../search/autocomplete-mapping';
import { SearchAutocomplete } from '../../search/search-autocomplete';
import { ClaimDialogFlow } from './claim-dialog-flow';
import type { ClaimDialogOpening } from './claim-dialog.service';

const PRODUCT: AutocompleteSuggestion = {
  kind: 'product',
  objectID: 'p1',
  title: 'Acme Takeoff',
  subtitle: 'Acme Software',
  routerLink: ['/products', 'acme-takeoff'],
};

function setup(opening: ClaimDialogOpening, opts: { email?: string | null } = {}) {
  const analytics = {
    claimDialogStep: vi.fn(),
    claimRequested: vi.fn(),
    listingRequested: vi.fn(),
  };
  const api = {
    submitClaim: vi.fn().mockResolvedValue({ request_id: 'req-1', message: 'ok' }),
    submitListing: vi.fn().mockResolvedValue({ request_id: 'lr-1', message: 'ok' }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: Analytics, useValue: analytics },
      { provide: RequestsApi, useValue: api },
      { provide: SessionStatus, useValue: { email: signal(opts.email ?? null) } },
    ],
  });
  const fixture = TestBed.createComponent(ClaimDialogFlow);
  fixture.componentRef.setInput('opening', opening);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  document.body.appendChild(host);

  const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
  const heading = () => text($('h3'));
  const progress = () => text($('[data-testid="claim-dialog-progress"] p'));
  const fill = (id: string, value: string) => {
    const el = host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const primary = async () => {
    $<HTMLButtonElement>('[data-testid="claim-dialog-primary"]')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const back = () => {
    $<HTMLButtonElement>('[data-testid="claim-dialog-back"]')!.click();
    fixture.detectChanges();
  };
  const choose = (hit: AutocompleteSuggestion) => {
    const box = fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
    box.suggestionChosen.emit(hit);
    fixture.detectChanges();
  };
  const fillYou = () => {
    fill('claim-dialog-name', 'Dana Reyes');
    fill('claim-dialog-role', 'Head of Partnerships');
    fill('claim-dialog-email', 'dana@acme.example');
  };
  const checkedPlan = () =>
    host.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value ?? null;
  return {
    fixture,
    host,
    $,
    heading,
    progress,
    fill,
    primary,
    back,
    choose,
    fillYou,
    checkedPlan,
    analytics,
    api,
  };
}

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('ClaimDialogFlow', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() =>
    document.body
      .querySelectorAll('aec-claim-dialog-flow, div[ng-version]')
      .forEach((n) => n.remove()),
  );

  it('starts at step 1 with the search box, no Back and no footer', () => {
    const { $, heading, progress, analytics } = setup({ page: 'vendor_program', entry: 'top' });
    expect(heading()).toBe('Find your listing');
    expect(progress()).toBe('Step 1 of 4 · Find it');
    expect($('#claim-dialog-search')).not.toBeNull();
    expect(text($('label[for="claim-dialog-search"]'))).toBe('Your product or company');
    expect($('[data-testid="claim-dialog-footer"]')).toBeNull();
    expect(analytics.claimDialogStep).toHaveBeenCalledWith({
      step: 'find',
      page: 'vendor_program',
      entry: 'top',
    });
  });

  // §15.2 step 1: Enter with no suggestion chosen does nothing, and never leaves
  // the open form for /search.
  it('does nothing on Enter in the search box when no suggestion is chosen', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    const box = t.fixture.debugElement.query(By.directive(SearchAutocomplete))
      .componentInstance as SearchAutocomplete;
    box.querySubmitted.emit('acme');
    t.$<HTMLFormElement>('form[action="/search"]')!.dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await t.fixture.whenStable();
    t.fixture.detectChanges();
    expect(t.heading()).toBe('Find your listing');
    expect(navigate).not.toHaveBeenCalled();
    expect(t.api.submitClaim).not.toHaveBeenCalled();
    expect(t.api.submitListing).not.toHaveBeenCalled();
  });

  it('walks a found listing through every step and sends the claim with the plan and comments', async () => {
    const t = setup({ page: 'vendor_program', entry: 'card', plan: 'managed' });
    t.choose(PRODUCT);
    expect(t.heading()).toBe('About you');
    expect(t.progress()).toBe('Step 2 of 4 · You');
    expect(text(t.$('[data-testid="claim-dialog-listing"]'))).toContain('Acme Takeoff');

    // Continue checks this step's fields and stays on an error.
    await t.primary();
    expect(t.heading()).toBe('About you');
    expect(t.$('#claim-dialog-name-error')).not.toBeNull();
    expect(document.activeElement?.id).toBe('claim-dialog-name');

    t.fillYou();
    // The LinkedIn host allowlist still applies.
    t.fill('claim-dialog-linkedin', 'https://example.com/in/dana');
    await t.primary();
    expect(t.heading()).toBe('About you');
    expect(t.$('#claim-dialog-linkedin-error')).not.toBeNull();
    t.fill('claim-dialog-linkedin', '');
    await t.primary();

    expect(t.heading()).toBe('Your plan');
    // Opened from a Managed control: Managed is preselected.
    expect(t.checkedPlan()).toBe('managed');
    await t.primary();

    expect(t.heading()).toBe('Anything to add?');
    expect(text(t.$('label[for="claim-dialog-comments"]'))).toBe('Additional comments (optional)');
    t.fill('claim-dialog-comments', 'We make four products.');
    expect(text(t.$('[data-testid="claim-dialog-primary"]'))).toBe('Send claim');
    await t.primary();

    expect(t.api.submitClaim).toHaveBeenCalledWith(
      { targetType: 'product', slug: 'acme-takeoff' },
      {
        submitter_name: 'Dana Reyes',
        submitter_email: 'dana@acme.example',
        submitter_role: 'Head of Partnerships',
        submitter_linkedin_url: '',
        plan_interest: 'managed',
        body: 'We make four products.',
      },
    );
    expect(t.heading()).toBe('Claim sent');
    expect(text(t.host)).toContain('dana@acme.example');
    expect(t.$('[data-testid="claim-dialog-progress"]')).toBeNull();
    expect(t.$('[data-testid="claim-dialog-back"]')).toBeNull();
    expect(t.analytics.claimRequested).toHaveBeenCalledWith({
      target_type: 'product',
      slug: 'acme-takeoff',
      request_id: 'req-1',
      plan_interest: 'managed',
    });
    expect(t.analytics.claimDialogStep.mock.calls.map(([c]) => [c.step, c.path])).toEqual([
      ['find', undefined],
      ['you', 'found'],
      ['plan', 'found'],
      ['comments', 'found'],
      ['done', 'found'],
    ]);
  });

  it('Back returns one step at a time and keeps what was typed', async () => {
    const t = setup({ page: 'docs_plans', entry: 'top' });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();
    expect(t.heading()).toBe('Anything to add?');
    t.back();
    expect(t.heading()).toBe('Your plan');
    // Nothing preselected from the hero.
    expect(t.checkedPlan()).toBeNull();
    t.back();
    expect(t.heading()).toBe('About you');
    expect(t.host.querySelector<HTMLInputElement>('#claim-dialog-name')!.value).toBe('Dana Reyes');
    t.back();
    expect(t.heading()).toBe('Find your listing');
  });

  it('preselects Free from the Free card', async () => {
    const t = setup({ page: 'vendor_program', entry: 'card', plan: 'free' });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    expect(t.checkedPlan()).toBe('free');
  });

  it('sends an unanswered plan as "" and reports it as none', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();
    await t.primary();
    expect(t.api.submitClaim.mock.calls[0]![1].plan_interest).toBe('');
    expect(t.analytics.claimRequested.mock.calls[0]![0].plan_interest).toBe('none');
  });

  it('a chosen listing shows on step 2, and Change returns to search', () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.choose(PRODUCT);
    expect(t.heading()).toBe('About you');
    expect(text(t.$('[data-testid="claim-dialog-listing"]'))).toContain('Acme Takeoff');
    const change = [...t.host.querySelectorAll('button')].find((b) => text(b) === 'Change')!;
    change.click();
    t.fixture.detectChanges();
    expect(t.heading()).toBe('Find your listing');
  });

  it('types in a listing and sends a listing request, with the typed-in receipt', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.$<HTMLButtonElement>('[data-testid="claim-dialog-type-it-in"]')!.click();
    t.fixture.detectChanges();
    expect(t.heading()).toBe('About you');

    t.fillYou();
    await t.primary();
    // The name and website are required on this path.
    expect(t.heading()).toBe('About you');
    expect(document.activeElement?.id).toBe('claim-dialog-listing-name');
    t.fill('claim-dialog-listing-name', 'Site Diary Pro');
    t.fill('claim-dialog-website', 'http://sitediary.example.com');
    await t.primary();
    expect(t.$('#claim-dialog-website-error')).not.toBeNull();
    t.fill('claim-dialog-website', 'https://sitediary.example.com');
    await t.primary();
    t.host.querySelector<HTMLInputElement>('input[value="not_sure"]')!.click();
    t.fixture.detectChanges();
    await t.primary();
    expect(text(t.$('[data-testid="claim-dialog-primary"]'))).toBe('Send request');
    await t.primary();

    expect(t.api.submitListing).toHaveBeenCalledWith({
      submitter_name: 'Dana Reyes',
      submitter_email: 'dana@acme.example',
      submitter_role: 'Head of Partnerships',
      submitter_linkedin_url: '',
      plan_interest: 'not_sure',
      body: '',
      listing_name: 'Site Diary Pro',
      website: 'https://sitediary.example.com',
    });
    expect(t.api.submitClaim).not.toHaveBeenCalled();
    expect(t.heading()).toBe('Request sent');
    expect(text(t.host)).toContain(
      "We'll add Site Diary Pro to the directory, then email dana@acme.example so you can finish your claim.",
    );
    expect(t.analytics.listingRequested).toHaveBeenCalledWith({
      plan_interest: 'not_sure',
      page: 'vendor_program',
    });
    // Never a typed value in any event.
    const payloads = JSON.stringify([
      ...t.analytics.claimDialogStep.mock.calls,
      ...t.analytics.listingRequested.mock.calls,
    ]);
    for (const typed of ['Site Diary Pro', 'sitediary', 'dana@', 'Dana Reyes']) {
      expect(payloads).not.toContain(typed);
    }
  });

  it('a listing gone since the search offers the typed-in path with its name', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.api.submitClaim.mockRejectedValueOnce(new HttpErrorResponse({ status: 404 }));
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();
    await t.primary();
    expect(text(t.$('[role="alert"]'))).toContain('That listing is no longer available.');
    [...t.host.querySelectorAll('button')].find((b) => text(b) === 'Type it in instead')!.click();
    t.fixture.detectChanges();
    expect(t.host.querySelector<HTMLInputElement>('#claim-dialog-listing-name')!.value).toBe(
      'Acme Takeoff',
    );
  });

  it('any other failure keeps the visitor on the last step with a retry notice', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.api.submitClaim.mockRejectedValueOnce(new HttpErrorResponse({ status: 500 }));
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();
    await t.primary();
    expect(t.heading()).toBe('Anything to add?');
    expect(text(t.$('[role="alert"]'))).toBe('Something went wrong. Please try again.');
  });

  it('prefills a signed-in email once, never over what the visitor typed', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' }, { email: 'me@acme.example' });
    await t.fixture.whenStable();
    t.choose(PRODUCT);
    expect(t.host.querySelector<HTMLInputElement>('#claim-dialog-email')!.value).toBe(
      'me@acme.example',
    );
  });
});
