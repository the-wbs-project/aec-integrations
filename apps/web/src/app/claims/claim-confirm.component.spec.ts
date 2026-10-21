/**
 * `/claims/confirm` (AECI-1435): the page behind the claim-confirm email. The rule
 * that matters most: rendering never sends the claim. Only the click POSTs, so a mail
 * scanner that prefetches the link changes nothing. Then one test per result state.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import { ClaimConfirmPage } from './claim-confirm';

const URL = '/api/requests/confirm';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));
const squash = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, ' ').trim();

function setup(token: string | null) {
  const analytics = { claimConfirmed: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: analytics },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { queryParamMap: convertToParamMap(token ? { token } : {}) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ClaimConfirmPage);
  fixture.detectChanges();
  return { fixture, analytics, httpMock: TestBed.inject(HttpTestingController) };
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const h1 = (f: ComponentFixture<unknown>) => squash(el(f).querySelector('h1')?.textContent);
const confirm = (f: ComponentFixture<unknown>) => el(f).querySelector('button')!.click();

async function answer(
  f: ComponentFixture<unknown>,
  httpMock: HttpTestingController,
  body: string | object,
  init?: { status: number; statusText: string },
) {
  confirm(f);
  httpMock.expectOne(URL).flush(body, init);
  await settle();
  f.detectChanges();
}

const ID = '11111111-2222-4333-8444-555555555555';

describe('ClaimConfirmPage', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    window.history.replaceState({}, '', '/claims/confirm');
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders the confirm prompt and does NOT POST on load', () => {
    const { fixture, httpMock } = setup('tok-1');
    expect(h1(fixture)).toBe('Confirm your claim');
    expect(squash(el(fixture).querySelector('button')?.textContent)).toBe('Confirm and send');
    expect(squash(el(fixture).textContent)).toContain('Nothing is sent until you do.');
    httpMock.expectNone(URL);
  });

  it('POSTs the token on the click and shows the receipt, focused', async () => {
    const { fixture, httpMock, analytics } = setup('tok-1');
    confirm(fixture);
    const req = httpMock.expectOne(URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ token: 'tok-1' });
    req.flush({
      status: 'confirmed',
      kind: 'claim',
      request_id: ID,
      routed: false,
      company_name: 'Acme',
    });
    await settle();
    fixture.detectChanges();

    expect(h1(fixture)).toBe('Claim sent');
    expect(document.activeElement).toBe(el(fixture).querySelector('h1'));
    expect(squash(el(fixture).textContent)).toContain('A person at AEC Integrations reviews');
    expect(analytics.claimConfirmed).toHaveBeenCalledWith({ kind: 'claim', outcome: 'confirmed' });
  });

  it('shows the routed receipt when the company team decides first', async () => {
    const { fixture, httpMock } = setup('tok-1');
    await answer(fixture, httpMock, {
      status: 'confirmed',
      kind: 'claim',
      request_id: ID,
      routed: true,
      company_name: 'Acme',
    });
    expect(
      squash(el(fixture).querySelector('[data-testid="claim-confirm-routed"]')?.textContent),
    ).toBe('The team at Acme has been asked to confirm you.');
    expect(el(fixture).textContent).not.toContain('Nothing is granted automatically');
  });

  it('shows the listing receipt for a typed-in listing', async () => {
    const { fixture, httpMock } = setup('tok-1');
    await answer(fixture, httpMock, {
      status: 'confirmed',
      kind: 'listing',
      request_id: ID,
      routed: false,
      company_name: 'Site Diary Pro',
    });
    expect(h1(fixture)).toBe('Request sent');
    expect(squash(el(fixture).textContent)).toContain("We'll add Site Diary Pro to the directory");
  });

  it('says already confirmed for a used link', async () => {
    const { fixture, httpMock, analytics } = setup('tok-1');
    await answer(fixture, httpMock, {
      status: 'already_confirmed',
      kind: 'claim',
      request_id: ID,
      routed: false,
      company_name: null,
    });
    expect(h1(fixture)).toBe('Already confirmed');
    expect(analytics.claimConfirmed).toHaveBeenCalledWith({
      kind: 'claim',
      outcome: 'already_confirmed',
    });
  });

  describe('a claim the account check rejected at confirm', () => {
    const rejected = {
      status: 'rejected',
      kind: 'claim',
      request_id: ID,
      routed: false,
      company_name: 'Acme',
    };

    it('names the company the address already manages, focused, with a way to start again', async () => {
      const { fixture, httpMock, analytics } = setup('tok-1');
      await answer(fixture, httpMock, {
        ...rejected,
        reason: 'other_vendor',
        vendor_name: 'Globex',
      });
      expect(h1(fixture)).toBe('We could not accept this claim');
      const text = squash(el(fixture).textContent);
      expect(text).toContain(
        'This address already manages Globex on AEC Integrations. Each address can manage one company. Send the claim again from a different work address.',
      );
      expect(text).toContain("We've emailed you the same details.");
      expect(text).not.toContain('Claim sent');
      expect(el(fixture).querySelector('a[href="/vendor-program"]')).not.toBeNull();
      expect(document.activeElement).toBe(el(fixture).querySelector('h1'));
      // The outcome only: the other company's name never reaches analytics.
      expect(analytics.claimConfirmed).toHaveBeenCalledWith({ kind: 'claim', outcome: 'rejected' });
      expect(JSON.stringify(analytics.claimConfirmed.mock.calls)).not.toContain('Globex');
    });

    it('falls back to "another company" when the other company has no name', async () => {
      const { fixture, httpMock } = setup('tok-1');
      await answer(fixture, httpMock, { ...rejected, reason: 'other_vendor', vendor_name: null });
      expect(squash(el(fixture).textContent)).toContain(
        'This address already manages another company on AEC Integrations.',
      );
    });

    it('explains a staff address', async () => {
      const { fixture, httpMock } = setup('tok-1');
      await answer(fixture, httpMock, { ...rejected, reason: 'already_admin', vendor_name: null });
      expect(h1(fixture)).toBe('We could not accept this claim');
      const text = squash(el(fixture).textContent);
      expect(text).toContain(
        'This address belongs to an AEC Integrations staff account. Send the claim again from a different work address.',
      );
      expect(text).toContain("We've emailed you the same details.");
      expect(text).not.toContain('already manages');
    });
  });

  it('says expired, with a way to start again', async () => {
    const { fixture, httpMock, analytics } = setup('tok-1');
    await answer(
      fixture,
      httpMock,
      { error: { code: 'INVALID_STATE_TRANSITION', details: { reason: 'expired' } } },
      { status: 422, statusText: 'Unprocessable' },
    );
    expect(h1(fixture)).toBe('This link has expired');
    expect(squash(el(fixture).textContent)).toContain('Confirm links work for 7 days.');
    expect(el(fixture).querySelector('a[href="/vendor-program"]')).not.toBeNull();
    expect(analytics.claimConfirmed).toHaveBeenCalledWith({ kind: null, outcome: 'expired' });
  });

  it('treats a terms bump since the submit as expired', async () => {
    const { fixture, httpMock } = setup('tok-1');
    await answer(
      fixture,
      httpMock,
      { error: { code: 'VALIDATION_FAILED', field: 'version' } },
      { status: 400, statusText: 'Bad Request' },
    );
    expect(h1(fixture)).toBe('This link has expired');
  });

  it('says not valid for an unknown token', async () => {
    const { fixture, httpMock, analytics } = setup('nope');
    await answer(
      fixture,
      httpMock,
      { error: { code: 'NOT_FOUND', details: { resource: 'request_confirmation' } } },
      { status: 404, statusText: 'Not Found' },
    );
    expect(h1(fixture)).toBe('This link is not valid');
    expect(analytics.claimConfirmed).toHaveBeenCalledWith({ kind: null, outcome: 'not_found' });
  });

  it('says the listing is gone, and points at Type it in', async () => {
    const { fixture, httpMock } = setup('tok-1');
    await answer(
      fixture,
      httpMock,
      { error: { code: 'NOT_FOUND', details: { resource: 'vendor', slug: 'acme' } } },
      { status: 404, statusText: 'Not Found' },
    );
    expect(h1(fixture)).toBe('That listing is no longer available');
    expect(squash(el(fixture).textContent)).toContain('choose Type it in');
  });

  it('keeps the confirm available with an alert when the request fails', async () => {
    const { fixture, httpMock } = setup('tok-1');
    await answer(fixture, httpMock, 'boom', { status: 500, statusText: 'Server Error' });
    expect(squash(el(fixture).querySelector('[role="alert"]')?.textContent)).toContain(
      'Something went wrong',
    );
    expect(el(fixture).querySelector('button')).not.toBeNull();
  });

  it('explains where the link lives when there is no token, with no button', () => {
    const { fixture } = setup(null);
    expect(h1(fixture)).toBe('Confirm your claim');
    expect(el(fixture).querySelector('button')).toBeNull();
  });

  it('drops the token from the Router URL but still POSTs it', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: 'claims/confirm', component: ClaimConfirmPage }]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: Analytics, useValue: { claimConfirmed: vi.fn() } },
      ],
    });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/claims/confirm?utm_source=email&token=tok-1', ClaimConfirmPage);
    await harness.fixture.whenStable();
    expect(TestBed.inject(Router).url).toBe('/claims/confirm?utm_source=email');

    harness.routeNativeElement!.querySelector('button')!.click();
    const httpMock = TestBed.inject(HttpTestingController);
    const req = httpMock.expectOne(URL);
    expect(req.request.body).toEqual({ token: 'tok-1' });
    req.flush({
      status: 'confirmed',
      kind: 'claim',
      request_id: ID,
      routed: false,
      company_name: 'Acme',
    });
    await settle();
  });
});
