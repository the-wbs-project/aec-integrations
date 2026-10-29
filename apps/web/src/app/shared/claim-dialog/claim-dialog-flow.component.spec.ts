/**
 * The claim dialog's steps (`claim-dialog-flow.ts`, AECI-1293,
 * `docs/VENDOR_PROGRAM_PAGE_SPEC.md` §15.2): each of the three steps (AECI-1365
 * removed the plan step), Back, both submit paths, the 404 fallback and the
 * analytics payloads. AECI-1366 adds the vendor terms box, the routed notice and
 * receipt, and the stale-bundle `accepted_terms` 400. AECI-1474 adds the embedded
 * flow that starts on the typed-in step, for the listing request page. The BrnDialog
 * shell and the triggers are pinned in `claim-dialog.component.spec.ts`.
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
import { FoundViaField } from '../found-via/found-via-field';
import { ClaimDialogFlow } from './claim-dialog-flow';
import {
  ClaimDialogService,
  type ClaimDialogOpening,
  type ClaimListing,
} from './claim-dialog.service';

const PRODUCT: AutocompleteSuggestion = {
  kind: 'product',
  objectID: 'p1',
  title: 'Acme Takeoff',
  subtitle: 'Acme Software',
  routerLink: ['/products', 'acme-takeoff'],
};

function setup(
  opening: ClaimDialogOpening,
  opts: {
    email?: string | null;
    hasSeats?: boolean | 'error';
    confirm?: boolean;
    embedded?: boolean;
    /** A listing the page seeded (`/vendor-program?vendor=`). */
    seed?: ClaimListing;
  } = {},
) {
  const analytics = {
    claimDialogStep: vi.fn(),
    claimRequested: vi.fn(),
    listingRequested: vi.fn(),
  };
  const api = {
    // AECI-1435: `confirm` makes the API park the submit until the emailed link.
    submitClaim: vi.fn().mockResolvedValue({
      request_id: 'req-1',
      message: 'ok',
      confirmation_required: opts.confirm ?? false,
    }),
    submitListing: vi.fn().mockResolvedValue({
      request_id: 'lr-1',
      message: 'ok',
      confirmation_required: opts.confirm ?? false,
    }),
    getClaimTarget:
      opts.hasSeats === 'error'
        ? vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 500 }))
        : vi.fn().mockResolvedValue({ vendor_id: 'v-1', has_seats: opts.hasSeats ?? false }),
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
  if (opts.seed) TestBed.inject(ClaimDialogService).setSeed(opts.seed);
  const fixture = TestBed.createComponent(ClaimDialogFlow);
  fixture.componentRef.setInput('opening', opening);
  if (opts.embedded) fixture.componentRef.setInput('embedded', true);
  const host = fixture.nativeElement as HTMLElement;
  // Attached before the first render, so a focus moved on it lands (AECI-1474).
  document.body.appendChild(host);
  fixture.detectChanges();

  const $ = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
  const heading = () => text($('h3'));
  const progress = () => text($('[data-testid="claim-dialog-progress"] p'));
  /** The progress bar's fill, as its inline width (`"50%"`). */
  const progressWidth = () =>
    $<HTMLElement>('[data-testid="claim-dialog-progress"] div div')?.style.width ?? null;
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
  /** AECI-1063: answer "How did you find us?" on the comments step. */
  const answerFoundVia = (value: 'ai_tool' | 'search' | 'linkedin', detail = '') => {
    const field = fixture.debugElement.query(By.directive(FoundViaField))
      .componentInstance as FoundViaField;
    field.value.set(value);
    field.detail.set(detail);
    fixture.detectChanges();
  };
  const toggleTerms = () => {
    host.querySelector<HTMLInputElement>('#claim-dialog-terms')!.click();
    fixture.detectChanges();
  };
  /** The You step's fields, and the vendor terms box unless `terms` is false. */
  const fillYou = (terms = true) => {
    fill('claim-dialog-name', 'Dana Reyes');
    fill('claim-dialog-role', 'Head of Partnerships');
    fill('claim-dialog-email', 'dana@acme.example');
    if (terms) toggleTerms();
  };
  return {
    fixture,
    host,
    $,
    heading,
    progress,
    progressWidth,
    fill,
    primary,
    back,
    choose,
    fillYou,
    toggleTerms,
    answerFoundVia,
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
    expect(progress()).toBe('Step 1 of 3 · Find it');
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

  it('walks a found listing through every step and sends the claim with the comments', async () => {
    const t = setup({ page: 'vendor_program', entry: 'card' });
    t.choose(PRODUCT);
    expect(t.heading()).toBe('About you');
    expect(t.progress()).toBe('Step 2 of 3 · You');
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

    // AECI-1365: no plan step. "About you" goes straight to the comments.
    expect(t.heading()).toBe('Anything to add?');
    expect(t.progress()).toBe('Step 3 of 3 · Comments');
    expect(t.host.querySelector('input[type="radio"]')).toBeNull();
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
        body: 'We make four products.',
        accepted_terms: true,
        found_via: '',
        found_via_detail: '',
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
      confirmation_required: false,
      found_via: null,
    });
    expect(t.analytics.claimDialogStep.mock.calls.map(([c]) => [c.step, c.path])).toEqual([
      ['find', undefined],
      ['you', 'found'],
      ['comments', 'found'],
      ['done', 'found'],
    ]);
  });

  it('Back returns one step at a time and keeps what was typed', async () => {
    const t = setup({ page: 'docs_plans', entry: 'top' });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    expect(t.heading()).toBe('Anything to add?');
    t.back();
    expect(t.heading()).toBe('About you');
    expect(t.host.querySelector<HTMLInputElement>('#claim-dialog-name')!.value).toBe('Dana Reyes');
    t.back();
    expect(t.heading()).toBe('Find your listing');
  });

  it('sends and reports no plan answer (AECI-1365)', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();
    expect(t.api.submitClaim.mock.calls[0]![1]).not.toHaveProperty('plan_interest');
    expect(t.analytics.claimRequested.mock.calls[0]![0]).not.toHaveProperty('plan_interest');
  });

  // AECI-1364: a claim is on the company. A product hit names its vendor (from the
  // search record) and the product page; the dialog title follows.
  it('names the company and the product page for a product hit, and titles the dialog', () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    const service = TestBed.inject(ClaimDialogService);
    expect(service.company()).toBeNull();
    t.choose(PRODUCT);
    expect(text(t.$('[data-testid="claim-dialog-listing"]'))).toContain(
      'Claiming Acme Software from the Acme Takeoff page',
    );
    expect(service.company()).toBe('Acme Software');
    // The wire still addresses the product; the API resolves the company.
    const change = [...t.host.querySelectorAll('button')].find((b) => text(b) === 'Change')!;
    change.click();
    t.fixture.detectChanges();
    expect(service.company()).toBeNull();
  });

  it('names a company hit as the company, with no product line', () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.choose({
      kind: 'vendor',
      objectID: 'v1',
      title: 'Acme Software',
      subtitle: null,
      routerLink: ['/vendors', 'acme-software'],
    });
    const summary = text(t.$('[data-testid="claim-dialog-listing"]'));
    // "Claiming" and the name are flex items: the gap, not a text space, separates them.
    expect(summary).toMatch(/^Claiming\s*Acme Software/);
    expect(summary).not.toContain('page');
    expect(TestBed.inject(ClaimDialogService).company()).toBe('Acme Software');
  });

  it('falls back to the product name when a product hit has no vendor name', () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.choose({ ...PRODUCT, subtitle: null });
    expect(text(t.$('[data-testid="claim-dialog-listing"]'))).toMatch(/^Claiming\s*Acme Takeoff/);
    expect(TestBed.inject(ClaimDialogService).company()).toBeNull();
  });

  it('keeps "Claim your company" on the typed-in path', () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.$<HTMLButtonElement>('[data-testid="claim-dialog-type-it-in"]')!.click();
    t.fixture.detectChanges();
    expect(TestBed.inject(ClaimDialogService).company()).toBeNull();
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

  // `/vendor-program?vendor=` (VENDOR_PROGRAM_PAGE_SPEC.md §2.4): the page seeds the
  // company, so the dialog opens on You and Change still reaches the search.
  it('opens on step 2 with a seeded company, and Change returns to search', async () => {
    const t = setup(
      { page: 'vendor_program', entry: 'top' },
      {
        seed: {
          targetType: 'vendor',
          slug: 'acme-software',
          name: 'Acme Software',
          company: 'Acme Software',
          product: null,
        },
      },
    );
    expect(t.heading()).toBe('About you');
    expect(t.progress()).toBe('Step 2 of 3 · You');
    expect(text(t.$('[data-testid="claim-dialog-listing"]'))).toMatch(/^Claiming\s*Acme Software/);
    expect(TestBed.inject(ClaimDialogService).company()).toBe('Acme Software');
    expect(t.api.getClaimTarget).toHaveBeenCalledWith({
      targetType: 'vendor',
      slug: 'acme-software',
    });
    expect(t.analytics.claimDialogStep).toHaveBeenCalledWith({
      step: 'you',
      page: 'vendor_program',
      entry: 'top',
      path: 'found',
    });

    t.fillYou();
    await t.primary();
    await t.primary();
    expect(t.api.submitClaim).toHaveBeenCalledWith(
      { targetType: 'vendor', slug: 'acme-software' },
      expect.objectContaining({ submitter_email: 'dana@acme.example' }),
    );
  });

  it('a seeded dialog still lets the visitor change the company', () => {
    const t = setup(
      { page: 'vendor_program', entry: 'top' },
      {
        seed: {
          targetType: 'vendor',
          slug: 'acme-software',
          name: 'Acme Software',
          company: 'Acme Software',
          product: null,
        },
      },
    );
    const change = [...t.host.querySelectorAll('button')].find((b) => text(b) === 'Change')!;
    change.click();
    t.fixture.detectChanges();
    expect(t.heading()).toBe('Find your listing');
    expect(TestBed.inject(ClaimDialogService).company()).toBeNull();
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
    expect(text(t.$('[data-testid="claim-dialog-primary"]'))).toBe('Send request');
    await t.primary();

    expect(t.api.submitListing).toHaveBeenCalledWith({
      submitter_name: 'Dana Reyes',
      submitter_email: 'dana@acme.example',
      submitter_role: 'Head of Partnerships',
      submitter_linkedin_url: '',
      body: '',
      accepted_terms: true,
      found_via: '',
      found_via_detail: '',
      listing_name: 'Site Diary Pro',
      website: 'https://sitediary.example.com',
    });
    expect(t.api.submitClaim).not.toHaveBeenCalled();
    expect(t.heading()).toBe('Request sent');
    expect(text(t.host)).toContain(
      "We've emailed a receipt to dana@acme.example. We'll add Site Diary Pro to the directory, then write to you there so you can finish your claim.",
    );
    expect(t.analytics.listingRequested).toHaveBeenCalledWith({
      page: 'vendor_program',
      confirmation_required: false,
      found_via: null,
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

  it('carries the "How did you find us?" answer on the found path, the event gets the channel only (AECI-1063)', async () => {
    const t = setup({ page: 'vendor_program', entry: 'card' });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    expect(t.heading()).toBe('Anything to add?');
    // The question lives on the comments step.
    expect(t.$('#claim-dialog-found-via-label')).not.toBeNull();
    t.answerFoundVia('ai_tool', '  who lists AEC integrations  ');
    await t.primary();

    expect(t.api.submitClaim).toHaveBeenCalledWith(
      { targetType: 'product', slug: 'acme-takeoff' },
      expect.objectContaining({
        found_via: 'ai_tool',
        found_via_detail: 'who lists AEC integrations',
      }),
    );
    expect(t.analytics.claimRequested).toHaveBeenCalledWith(
      expect.objectContaining({ found_via: 'ai_tool' }),
    );
    expect(JSON.stringify(t.analytics.claimRequested.mock.calls)).not.toContain(
      'who lists AEC integrations',
    );
  });

  it('carries the "How did you find us?" answer on the typed-in path (AECI-1063)', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top', start: 'typed' });
    t.fill('claim-dialog-listing-name', 'Site Diary Pro');
    t.fill('claim-dialog-website', 'https://sitediary.example.com');
    t.fillYou();
    await t.primary();
    t.answerFoundVia('search', 'site diary software');
    await t.primary();

    expect(t.api.submitListing).toHaveBeenCalledWith(
      expect.objectContaining({ found_via: 'search', found_via_detail: 'site diary software' }),
    );
    expect(t.analytics.listingRequested).toHaveBeenCalledWith({
      page: 'vendor_program',
      confirmation_required: false,
      found_via: 'search',
    });
  });

  it('an anonymous claim shows "Check your inbox": nothing is sent until the link (AECI-1435)', async () => {
    const t = setup({ page: 'vendor_program', entry: 'card' }, { confirm: true });
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();

    expect(t.heading()).toBe('Check your inbox');
    expect(document.activeElement).toBe(t.$('h3'));
    const receipt = text(t.$('[data-testid="claim-dialog-check-inbox"]'));
    expect(receipt).toContain(
      "We've sent a link to dana@acme.example. Your claim is not sent until you click it.",
    );
    expect(receipt).toContain('The link works for 7 days.');
    expect(text(t.host)).not.toContain('Claim sent');
    expect(text(t.host)).not.toContain('What happens next');
    expect(t.analytics.claimRequested).toHaveBeenCalledWith({
      target_type: 'product',
      slug: 'acme-takeoff',
      request_id: 'req-1',
      confirmation_required: true,
      found_via: null,
    });
  });

  it('an anonymous typed-in listing says the request is not sent until the link (AECI-1435)', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' }, { confirm: true });
    t.$<HTMLButtonElement>('[data-testid="claim-dialog-type-it-in"]')!.click();
    t.fixture.detectChanges();
    t.fillYou();
    t.fill('claim-dialog-listing-name', 'Site Diary Pro');
    t.fill('claim-dialog-website', 'https://sitediary.example.com');
    await t.primary();
    await t.primary();

    expect(t.heading()).toBe('Check your inbox');
    expect(text(t.$('[data-testid="claim-dialog-check-inbox"]'))).toContain(
      'Your request is not sent until you click it.',
    );
    expect(t.analytics.listingRequested).toHaveBeenCalledWith({
      page: 'vendor_program',
      confirmation_required: true,
      found_via: null,
    });
  });

  it('a listing gone since the search offers the typed-in path with its name', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.api.submitClaim.mockRejectedValueOnce(new HttpErrorResponse({ status: 404 }));
    t.choose(PRODUCT);
    t.fillYou();
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
    expect(t.heading()).toBe('Anything to add?');
    expect(text(t.$('[role="alert"]'))).toBe('Something went wrong. Please try again.');
  });

  // ── AECI-1366 ───────────────────────────────────────────────────────────────
  it.each(['found', 'typed'] as const)(
    'Continue stops on an unchecked vendor terms box on the %s path, with the error tied to it',
    async (path) => {
      const t = setup({ page: 'vendor_program', entry: 'top' });
      if (path === 'found') t.choose(PRODUCT);
      else {
        t.$<HTMLButtonElement>('[data-testid="claim-dialog-type-it-in"]')!.click();
        t.fixture.detectChanges();
        t.fill('claim-dialog-listing-name', 'Site Diary Pro');
        t.fill('claim-dialog-website', 'https://sitediary.example.com');
      }
      const box = t.$<HTMLInputElement>('#claim-dialog-terms')!;
      expect(box.type).toBe('checkbox');
      expect(box.checked).toBe(false);
      const link = t.$<HTMLAnchorElement>('label[for="claim-dialog-terms"] a')!;
      expect(link.getAttribute('href')).toBe('/legal/vendor-terms');
      expect(link.target).toBe('_blank');
      expect(text(t.$('label[for="claim-dialog-terms"]'))).toContain(
        'I represent this company and accept the vendor terms',
      );

      t.fillYou(false);
      await t.primary();
      expect(t.heading()).toBe('About you');
      expect(document.activeElement?.id).toBe('claim-dialog-terms');
      expect(box.getAttribute('aria-invalid')).toBe('true');
      expect(box.getAttribute('aria-describedby')).toBe('claim-dialog-terms-error');
      expect(text(t.$('#claim-dialog-terms-error'))).toContain('Tick the box');

      t.toggleTerms();
      expect(t.$('#claim-dialog-terms-error')).toBeNull();
      await t.primary();
      expect(t.heading()).toBe('Anything to add?');
      expect(t.api.submitClaim).not.toHaveBeenCalled();
      expect(t.api.submitListing).not.toHaveBeenCalled();
    },
  );

  it('a company with an owner seat shows the routed notice, then the routed receipt', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' }, { hasSeats: true });
    t.choose(PRODUCT);
    await t.fixture.whenStable();
    t.fixture.detectChanges();
    expect(t.api.getClaimTarget).toHaveBeenCalledWith({
      targetType: 'product',
      slug: 'acme-takeoff',
    });
    expect(text(t.$('[data-testid="claim-routed-notice"]'))).toBe(
      'Acme Software already maintains this listing. Send your request and their team will confirm you. We step in if they do not answer within 7 days.',
    );

    t.fillYou();
    await t.primary();
    await t.primary();
    expect(t.heading()).toBe('Claim sent');
    expect(text(t.host)).toContain("We've emailed a receipt to dana@acme.example.");
    expect(text(t.$('[data-testid="claim-dialog-sent-routed"]'))).toBe(
      'The team at Acme Software has been asked to confirm you.',
    );
    expect(text(t.host)).toContain('If they accept, you get an invitation email to join.');
    expect(text(t.host)).toContain(
      'If nobody answers within 7 days, we review your claim and write to you.',
    );
    expect(text(t.host)).not.toContain('with our decision');
    expect(text(t.host)).not.toContain('link to your vendor portal');
  });

  it('no seat: no notice, and the standard receipt', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' }, { hasSeats: false });
    t.choose(PRODUCT);
    await t.fixture.whenStable();
    t.fixture.detectChanges();
    expect(t.$('[data-testid="claim-routed-notice"]')).toBeNull();
    t.fillYou();
    await t.primary();
    await t.primary();
    expect(t.$('[data-testid="claim-dialog-sent-routed"]')).toBeNull();
    expect(text(t.host)).toContain('A person at AEC Integrations reviews every claim.');
  });

  it('a failed claim-target lookup shows no notice and never blocks the submit', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' }, { hasSeats: 'error' });
    t.choose(PRODUCT);
    await t.fixture.whenStable();
    t.fixture.detectChanges();
    expect(t.$('[data-testid="claim-routed-notice"]')).toBeNull();
    t.fillYou();
    await t.primary();
    await t.primary();
    expect(t.api.submitClaim).toHaveBeenCalledTimes(1);
    expect(t.heading()).toBe('Claim sent');
  });

  it('a 400 on accepted_terms (a stale bundle) returns to the box with its error, not the generic notice', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' });
    t.api.submitClaim.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 400,
        error: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request failed validation',
            field: 'accepted_terms',
          },
        },
      }),
    );
    t.choose(PRODUCT);
    t.fillYou();
    await t.primary();
    await t.primary();
    await t.fixture.whenStable();
    t.fixture.detectChanges();

    expect(t.heading()).toBe('About you');
    const box = t.$<HTMLInputElement>('#claim-dialog-terms')!;
    expect(box.checked).toBe(false);
    expect(box.getAttribute('aria-describedby')).toBe('claim-dialog-terms-error');
    expect(t.$('#claim-dialog-terms-error')).not.toBeNull();
    expect(text(t.host)).not.toContain('Something went wrong');
    expect(document.activeElement?.id).toBe('claim-dialog-terms');
  });

  it('prefills a signed-in email once, never over what the visitor typed', async () => {
    const t = setup({ page: 'vendor_program', entry: 'top' }, { email: 'me@acme.example' });
    await t.fixture.whenStable();
    t.choose(PRODUCT);
    expect(t.host.querySelector<HTMLInputElement>('#claim-dialog-email')!.value).toBe(
      'me@acme.example',
    );
  });

  describe('embedded, from the typed-in step (AECI-1474)', () => {
    const LIST_PAGE: ClaimDialogOpening = {
      page: 'list_your_product',
      entry: 'list_page',
      start: 'typed',
    };

    it('opens on the typed-in You step with focus in the first field, and one step event', async () => {
      const t = setup(LIST_PAGE, { embedded: true });
      await t.fixture.whenStable();
      expect(t.heading()).toBe('About you');
      expect(t.progress()).toBe('Step 1 of 2 · You');
      expect(t.progressWidth()).toBe('50%');
      expect(t.$('#claim-dialog-search')).toBeNull();
      expect(t.$('#claim-dialog-listing-name')).not.toBeNull();
      expect(t.$('#claim-dialog-website')).not.toBeNull();
      expect(document.activeElement?.id).toBe('claim-dialog-listing-name');
      expect(t.analytics.claimDialogStep).toHaveBeenCalledTimes(1);
      expect(t.analytics.claimDialogStep).toHaveBeenCalledWith({
        step: 'you',
        page: 'list_your_product',
        entry: 'list_page',
        path: 'typed',
      });
    });

    it('counts two steps on the typed-in path: You 1 of 2, Comments 2 of 2', async () => {
      const t = setup(LIST_PAGE, { embedded: true });
      t.fill('claim-dialog-listing-name', 'Site Diary Pro');
      t.fill('claim-dialog-website', 'https://sitediary.example.com');
      t.fillYou();
      await t.primary();
      expect(t.heading()).toBe('Anything to add?');
      expect(t.progress()).toBe('Step 2 of 2 · Comments');
      expect(t.progressWidth()).toBe('100%');
    });

    it('Back goes to the Find step, which searches as in the dialog and shows no progress', async () => {
      const t = setup(LIST_PAGE, { embedded: true });
      t.back();
      expect(t.heading()).toBe('Find your listing');
      expect(t.$('#claim-dialog-search')).not.toBeNull();
      // Find is a detour here, not step 1.
      expect(t.$('[data-testid="claim-dialog-progress"]')).toBeNull();
      expect(t.analytics.claimDialogStep).toHaveBeenLastCalledWith({
        step: 'find',
        page: 'list_your_product',
        entry: 'list_page',
      });
      t.choose(PRODUCT);
      expect(text(t.$('[data-testid="claim-dialog-listing"]'))).toContain('Acme Takeoff');
      // A found listing keeps the two-step count.
      expect(t.progress()).toBe('Step 1 of 2 · You');
      expect(t.progressWidth()).toBe('50%');
      t.fillYou();
      await t.primary();
      expect(t.progress()).toBe('Step 2 of 2 · Comments');
      expect(t.progressWidth()).toBe('100%');
    });

    it('the dialog without a start still counts three steps, Find first', async () => {
      const t = setup({ page: 'vendor_program', entry: 'top' });
      expect(t.progress()).toBe('Step 1 of 3 · Find it');
      expect(parseFloat(t.progressWidth()!)).toBeCloseTo(100 / 3, 1);
      t.choose(PRODUCT);
      expect(t.progress()).toBe('Step 2 of 3 · You');
      t.fillYou();
      await t.primary();
      expect(t.progress()).toBe('Step 3 of 3 · Comments');
      expect(t.progressWidth()).toBe('100%');
      t.back();
      t.back();
      expect(t.progress()).toBe('Step 1 of 3 · Find it');
    });

    it('drops the dialog scroll classes', () => {
      const t = setup(LIST_PAGE, { embedded: true });
      const host = t.fixture.nativeElement as HTMLElement;
      expect(host.className).not.toContain('min-h-0');
      expect(t.$('[data-testid="claim-dialog-body"]')!.className).not.toContain('overflow-y-auto');
    });

    it('sends a listing request with the page, and the receipt has no Done', async () => {
      const t = setup(LIST_PAGE, { embedded: true });
      t.fill('claim-dialog-listing-name', 'Site Diary Pro');
      t.fill('claim-dialog-website', 'https://sitediary.example.com');
      t.fillYou();
      await t.primary();
      await t.primary();
      expect(t.api.submitListing).toHaveBeenCalledTimes(1);
      expect(t.heading()).toBe('Request sent');
      expect(t.$('[data-testid="claim-dialog-footer"]')).toBeNull();
      expect(text(t.host)).not.toContain('Done');
      expect(t.analytics.listingRequested).toHaveBeenCalledWith({
        page: 'list_your_product',
        confirmation_required: false,
        found_via: null,
      });
    });

    it('the dialog receipt keeps its Done', async () => {
      const t = setup({ page: 'vendor_program', entry: 'top', start: 'typed' });
      t.fill('claim-dialog-listing-name', 'Site Diary Pro');
      t.fill('claim-dialog-website', 'https://sitediary.example.com');
      t.fillYou();
      await t.primary();
      await t.primary();
      expect(t.heading()).toBe('Request sent');
      expect(text(t.$('[data-testid="claim-dialog-footer"]'))).toBe('Done');
    });
  });
});
