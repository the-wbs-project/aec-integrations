import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RequestSubmitResponse } from '@aeci/shared';

import { SessionStatus } from '../auth/session-status';

import { RequestForm } from './request-form';
import { RequestFormBody } from './request-form-body';
import { RequestsApi } from './requests-api';

type Entity = 'product' | 'vendor';
type Kind = 'claim' | 'correction';

function mockRoute(entity: Entity, kind: Kind, slug: string, target?: unknown): ActivatedRoute {
  return {
    snapshot: { data: { entity, kind, target }, paramMap: convertToParamMap({ slug }) },
  } as unknown as ActivatedRoute;
}

/** Macrotask boundary — drains the async `validateStandardSchema` validation
 *  resource (mirrors the index-page harness `settle()`). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

interface ApiMock {
  submitCorrection: ReturnType<typeof vi.fn>;
  submitClaim: ReturnType<typeof vi.fn>;
  getClaimTarget: ReturnType<typeof vi.fn>;
}

function makeApiMock(): ApiMock {
  const ok: RequestSubmitResponse = {
    request_id: 'req-1',
    message: 'ok',
    confirmation_required: false,
  };
  return {
    submitCorrection: vi.fn(async () => ok),
    submitClaim: vi.fn(async () => ok),
    // AECI-1366: the claim form's seat lookup. No seat unless a test says so.
    getClaimTarget: vi.fn(async () => ({ vendor_id: 'v-1', has_seats: false })),
  };
}

/** Stands in for the real post-hydration session probe: `email` is `null` for an
 *  anonymous visitor (and pre-hydration), the session's address once signed in. */
function makeSessionStub(email: string | null) {
  const emailSignal = signal(email);
  return {
    stub: {
      signedIn: signal(email !== null).asReadonly(),
      email: emailSignal.asReadonly(),
    } as unknown as SessionStatus,
    emailSignal,
  };
}

function setup(
  entity: Entity,
  kind: Kind,
  slug = 'acme',
  sessionEmail: string | null = null,
  /** AECI-1364: what the claim route's resolver returned (a product or vendor read). */
  target?: unknown,
  /** AECI-1366: replace API mocks before the first render (the seat lookup runs then). */
  apiOverrides: Partial<ApiMock> = {},
) {
  const api = { ...makeApiMock(), ...apiOverrides };
  const session = makeSessionStub(sessionEmail);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: ActivatedRoute, useValue: mockRoute(entity, kind, slug, target) },
      { provide: RequestsApi, useValue: api },
      { provide: SessionStatus, useValue: session.stub },
    ],
  });
  const fixture = TestBed.createComponent(RequestForm);
  fixture.detectChanges();
  const httpMock = TestBed.inject(HttpTestingController);
  return {
    fixture,
    api,
    httpMock,
    session,
    el: fixture.nativeElement as HTMLElement,
  };
}

/** AECI-1366: tick (or untick) the required vendor terms box. */
function toggleTerms(fixture: ComponentFixture<unknown>) {
  (
    (fixture.nativeElement as HTMLElement).querySelector('#claim-terms') as HTMLInputElement
  ).click();
}

function type(el: ComponentFixture<unknown>, selector: string, value: string) {
  const input = (el.nativeElement as HTMLElement).querySelector(selector) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  input.dispatchEvent(new Event('blur'));
}

describe('RequestForm', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the correction field set + submit, not the claim fields', () => {
    const { el, httpMock } = setup('product', 'correction');
    expect(el.querySelector('#correction-body')).not.toBeNull();
    expect(el.querySelector('#correction-email')).not.toBeNull();
    expect(el.querySelector('#correction-source')).not.toBeNull();
    expect(el.querySelector('#claim-name')).toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Send correction');
    httpMock.verify();
  });

  it('renders the claim field set + submit, not the correction fields', () => {
    const { el, httpMock } = setup('vendor', 'claim');
    expect(el.querySelector('#claim-name')).not.toBeNull();
    expect(el.querySelector('#claim-role')).not.toBeNull();
    expect(el.querySelector('#claim-linkedin')).not.toBeNull();
    expect(el.querySelector('#claim-email')).not.toBeNull();
    expect(el.querySelector('#claim-body')).not.toBeNull();
    expect(el.querySelector('#correction-body')).toBeNull();
    expect(el.querySelector('button[type="submit"]')?.textContent).toContain('Send claim');
    httpMock.verify();
  });

  // AECI-1364: a claim is on the company, so the page names it once known.
  describe('the "Claim <Company>" title', () => {
    it("names the product's vendor and the product page on a product claim page", () => {
      const { el, httpMock } = setup('product', 'claim', 'acme-takeoff', null, {
        name: 'Acme Takeoff',
        vendor: { id: 'v1', name: 'Acme Software', slug: 'acme-software', logo_url: null },
      });
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('Claim Acme Software');
      expect(
        el
          .querySelector('[data-testid="request-context-product"]')
          ?.textContent?.replace(/\s+/g, ' ')
          .trim(),
      ).toBe('From the Acme Takeoff page');
      expect(TestBed.inject(Title).getTitle()).toBe('Claim Acme Software · AEC Integrations');
      expect(el.textContent).not.toContain('listing');
      httpMock.verify();
    });

    it('names the company on a company claim page, with no product line', () => {
      const { el, httpMock } = setup('vendor', 'claim', 'acme-software', null, {
        company_name: 'Acme Software',
      });
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('Claim Acme Software');
      expect(el.querySelector('[data-testid="request-context-product"]')).toBeNull();
      httpMock.verify();
    });

    it('reads "Claim your company" when the company is unknown', () => {
      const { el, httpMock } = setup('product', 'claim', 'acme-takeoff', null, {
        name: 'Acme Takeoff',
        vendor: null,
      });
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('Claim your company');
      expect(TestBed.inject(Title).getTitle()).toBe('Claim your company · AEC Integrations');
      httpMock.verify();
    });

    it('reads "Claim your company" when the entity did not resolve', () => {
      const { el, httpMock } = setup('vendor', 'claim', 'gone', null, null);
      expect(el.querySelector('h1')?.textContent?.trim()).toBe('Claim your company');
      httpMock.verify();
    });
  });

  it('disables submit while the form is invalid', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction');
    await settle();
    fixture.detectChanges();
    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    httpMock.verify();
  });

  it('marks the claim note optional, with no character floor, described by its hint', () => {
    const { el, httpMock } = setup('vendor', 'claim');

    // The hint is present from first render (not gated on touched/invalid) and is
    // the only thing describing the field until an error joins it.
    const hint = el.querySelector('#claim-body-hint');
    expect(hint?.textContent).not.toContain('Minimum');
    expect(el.querySelector('label[for="claim-body"]')?.textContent).toContain('(optional)');
    expect(el.querySelector('#claim-body')?.getAttribute('aria-describedby')).toBe(
      'claim-body-hint',
    );
    httpMock.verify();
  });

  it('keeps the hint in aria-describedby alongside the error once the field is touched', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction');
    const body = el.querySelector('#correction-body') as HTMLTextAreaElement;
    body.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    expect(body.getAttribute('aria-describedby')).toBe(
      'correction-body-hint correction-body-error',
    );
    expect(el.querySelector('#correction-body-hint')).not.toBeNull();
    httpMock.verify();
  });

  it('surfaces a per-field error via get() once a field is touched', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction');
    // Blur the empty body field → touched + invalid → standardSchema error shows.
    // validateStandardSchema is async, so settle before asserting.
    const body = el.querySelector('#correction-body') as HTMLTextAreaElement;
    body.dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    const error = el.querySelector('#correction-body-error');
    expect(error).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
    httpMock.verify();
  });

  it('submits a valid correction and shows the confirmation panel', async () => {
    const { fixture, el, api, httpMock } = setup('product', 'correction', 'acme-build');

    type(
      fixture,
      '#correction-body',
      'The founding year is wrong — it should read 2009, not 2019.',
    );
    type(fixture, '#correction-email', 'reporter@example.com');
    // Let validateStandardSchema resolve so the form is valid before submit.
    await settle();
    fixture.detectChanges();

    const form = el.querySelector('form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitCorrection).toHaveBeenCalledTimes(1);
    const [, formValue] = api.submitCorrection.mock.calls[0];
    expect(formValue).toMatchObject({ submitter_email: 'reporter@example.com' });
    expect(el.querySelector('h1')?.textContent).toContain('Correction sent');
    expect(el.textContent).toContain('reporter@example.com');
    // A correction has no claim steps.
    expect(el.textContent).not.toContain('What happens next');
    httpMock.verify();
  });

  it('confirms a claim with the email, the next steps and the help link', async () => {
    const { fixture, el, httpMock } = setup('vendor', 'claim', 'acme-co');

    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    toggleTerms(fixture);
    type(fixture, '#claim-email', 'dana@acme.example');
    type(fixture, '#claim-body', 'I run the integrations program at Acme and own this listing.');
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(el.querySelector('h1')?.textContent).toContain('Claim sent');
    expect(el.querySelector('strong')?.textContent).toBe('dana@acme.example');
    expect(el.textContent).toContain('What happens next');
    expect(el.textContent).toContain('Nothing is granted automatically');
    // The docs link opens in a new tab so the confirmation stays on screen.
    const docsLink = el.querySelector('a[href="/docs/vendors/claiming-your-listing"]');
    expect(docsLink?.getAttribute('target')).toBe('_blank');
    expect(docsLink?.getAttribute('rel')).toBe('noopener');
    expect(docsLink?.querySelector('aec-new-tab-icon')).not.toBeNull();
    // Focus leaves the removed submit button for the confirmation heading.
    await settle();
    expect(document.activeElement).toBe(el.querySelector('h1'));
    httpMock.verify();
  });

  it('prefills the claim email from the signed-in session', async () => {
    const { fixture, el, httpMock } = setup('vendor', 'claim', 'acme', 'dana@acme.example');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#claim-email') as HTMLInputElement).value).toBe('dana@acme.example');
    httpMock.verify();
  });

  it('prefills the correction email from the signed-in session', async () => {
    const { fixture, el, httpMock } = setup('product', 'correction', 'acme', 'dana@acme.example');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#correction-email') as HTMLInputElement).value).toBe(
      'dana@acme.example',
    );
    httpMock.verify();
  });

  it('leaves the email empty for an anonymous visitor', async () => {
    const { fixture, el, httpMock } = setup('vendor', 'claim');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#claim-email') as HTMLInputElement).value).toBe('');
    httpMock.verify();
  });

  it('does not overwrite an email the visitor already typed', async () => {
    const { fixture, el, httpMock, session } = setup('vendor', 'claim');
    type(fixture, '#claim-email', 'work@other.example');
    await settle();

    // The probe resolves late (slow SDK chunk) — the typed value must win.
    session.emailSignal.set('dana@acme.example');
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('#claim-email') as HTMLInputElement).value).toBe('work@other.example');
    httpMock.verify();
  });

  it('submits the prefilled email when the visitor leaves it alone', async () => {
    const { fixture, el, api, httpMock } = setup('vendor', 'claim', 'acme-co', 'dana@acme.example');

    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    toggleTerms(fixture);
    type(fixture, '#claim-body', 'I run the integrations program at Acme and own this listing.');
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitClaim).toHaveBeenCalledTimes(1);
    const [, formValue] = api.submitClaim.mock.calls[0];
    expect(formValue).toMatchObject({ submitter_email: 'dana@acme.example' });
    httpMock.verify();
  });

  it('submits a claim with the note left empty', async () => {
    const { fixture, el, api, httpMock } = setup('vendor', 'claim', 'acme-co', 'dana@acme.example');

    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    toggleTerms(fixture);
    await settle();
    fixture.detectChanges();

    expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitClaim).toHaveBeenCalledTimes(1);
    const [, formValue] = api.submitClaim.mock.calls[0];
    expect(formValue).toMatchObject({ body: '' });
    httpMock.verify();
  });

  // ── Work-email nudge (VENDOR_PROGRAM_PAGE_SPEC.md §15.2) ────────────────────
  describe('the personal email notice', () => {
    it('shows no notice for a company address', async () => {
      const { fixture, el, httpMock } = setup('vendor', 'claim');
      type(fixture, '#claim-email', 'dana@acme.example');
      await settle();
      fixture.detectChanges();

      expect(el.querySelector('#claim-email-personal')).toBeNull();
      expect(el.querySelector('#claim-email')?.getAttribute('aria-describedby')).toBeNull();
      httpMock.verify();
    });

    it('asks for a work email when the address is a free mailbox, and describes the field by it', async () => {
      const { fixture, el, httpMock } = setup('vendor', 'claim');
      type(fixture, '#claim-email', 'dana@gmail.com');
      await settle();
      fixture.detectChanges();

      const notice = el.querySelector('#claim-email-personal');
      expect(notice?.textContent).toContain('Please use your work email');
      expect(notice?.textContent).toContain('may take longer');
      expect(el.querySelector('#claim-email')?.getAttribute('aria-describedby')).toBe(
        'claim-email-personal',
      );
      httpMock.verify();
    });

    it('shows the notice for a prefilled personal address before any edit', async () => {
      const { fixture, el, httpMock } = setup('vendor', 'claim', 'acme', 'dana@yahoo.com');
      await settle();
      fixture.detectChanges();

      expect(el.querySelector('#claim-email-personal')).not.toBeNull();
      httpMock.verify();
    });

    it('still submits a claim from a personal address', async () => {
      const { fixture, el, api, httpMock } = setup('vendor', 'claim', 'acme-co');
      type(fixture, '#claim-name', 'Dana Reyes');
      type(fixture, '#claim-role', 'Head of Partnerships');
      toggleTerms(fixture);
      type(fixture, '#claim-email', 'dana@outlook.com');
      await settle();
      fixture.detectChanges();

      expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(false);
      (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      await settle();
      fixture.detectChanges();

      expect(api.submitClaim).toHaveBeenCalledTimes(1);
      const [, formValue] = api.submitClaim.mock.calls[0];
      expect(formValue).toMatchObject({ submitter_email: 'dana@outlook.com' });
      httpMock.verify();
    });
  });

  // ── AECI-1365: no plan question; the note reads "Additional comments" ───────
  it('asks no plan question, and labels the note "Additional comments"', () => {
    const { el } = setup('product', 'claim');
    expect(el.textContent).not.toContain('Which plan are you interested in?');
    expect(el.querySelector('input[type="radio"]')).toBeNull();
    expect(el.querySelector('label[for="claim-body"]')?.textContent).toContain(
      'Additional comments',
    );
  });

  it('submits a claim with no plan answer', async () => {
    const { fixture, el, api } = setup('vendor', 'claim', 'acme-co', 'dana@acme.example');
    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    toggleTerms(fixture);
    await settle();
    fixture.detectChanges();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();
    expect(api.submitClaim).toHaveBeenCalledTimes(1);
    expect(api.submitClaim.mock.calls[0]![1]).not.toHaveProperty('plan_interest');
  });

  // ── AECI-847: the optional LinkedIn profile field ─────────────────────────
  describe('the claim LinkedIn field', () => {
    /** Fills every REQUIRED claim field, leaving `#claim-linkedin` to the case. */
    function fillRequiredClaimFields(fixture: ComponentFixture<unknown>) {
      type(fixture, '#claim-name', 'Dana Reyes');
      type(fixture, '#claim-role', 'Head of Partnerships');
      toggleTerms(fixture);
      type(fixture, '#claim-email', 'dana@acme.example');
    }

    it('describes the field by its hint before any error', () => {
      const { el, httpMock } = setup('vendor', 'claim');
      expect(el.querySelector('#claim-linkedin-hint')).not.toBeNull();
      expect(el.querySelector('#claim-linkedin')?.getAttribute('aria-describedby')).toBe(
        'claim-linkedin-hint',
      );
      httpMock.verify();
    });

    // The SAME shared schema rejects this server-side (`requests.spec.ts`); this is
    // the client half of that acceptance criterion.
    it('rejects a non-LinkedIn URL and blocks submit', async () => {
      const { fixture, el, api, httpMock } = setup('vendor', 'claim');
      fillRequiredClaimFields(fixture);
      type(fixture, '#claim-linkedin', 'https://example.com/in/dana-reyes');
      await settle();
      fixture.detectChanges();

      const error = el.querySelector('#claim-linkedin-error');
      expect(error).not.toBeNull();
      expect(error?.getAttribute('role')).toBe('alert');
      expect(el.querySelector('#claim-linkedin')?.getAttribute('aria-describedby')).toBe(
        'claim-linkedin-hint claim-linkedin-error',
      );
      expect((el.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
      expect(api.submitClaim).not.toHaveBeenCalled();
      httpMock.verify();
    });

    it('submits a supplied LinkedIn profile URL', async () => {
      const { fixture, el, api, httpMock } = setup('vendor', 'claim');
      fillRequiredClaimFields(fixture);
      type(fixture, '#claim-linkedin', 'https://www.linkedin.com/in/dana-reyes');
      await settle();
      fixture.detectChanges();

      (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      await settle();
      fixture.detectChanges();

      expect(api.submitClaim).toHaveBeenCalledTimes(1);
      const [, formValue] = api.submitClaim.mock.calls[0];
      expect(formValue).toMatchObject({
        submitter_linkedin_url: 'https://www.linkedin.com/in/dana-reyes',
      });
      httpMock.verify();
    });

    // The field is optional: skipping it must not block the claim, and the empty
    // string still goes on the wire (the server stores it as NULL).
    it('still submits when the field is left blank', async () => {
      const { fixture, el, api, httpMock } = setup('vendor', 'claim');
      fillRequiredClaimFields(fixture);
      await settle();
      fixture.detectChanges();

      (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      await settle();
      fixture.detectChanges();

      expect(api.submitClaim).toHaveBeenCalledTimes(1);
      const [, formValue] = api.submitClaim.mock.calls[0];
      expect(formValue).toMatchObject({ submitter_linkedin_url: '' });
      httpMock.verify();
    });
  });
});

/**
 * AECI-967 — the drawer-only `bodyPrefill`. Rendered against `RequestFormBody`
 * directly rather than through `RequestForm`, because the ROUTED page
 * deliberately has no way to supply one: a seed there could only arrive as a
 * query param, and free text in the URL would join the SSR cache key and the
 * request logs. The drawer is the only caller.
 */
// AECI-987: the routed page sits on the 7xl canvas with a context rail. The
// rail lives in RequestForm only, so the drawer (RequestFormBody) has none.
describe('RequestForm canvas and context rail (AECI-987)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('uses the 7xl canvas, keeps the form at a form measure, and docks the rail from lg', () => {
    const { el, httpMock } = setup('vendor', 'claim', 'acme-software', null, {
      company_name: 'Acme Software',
    });
    const canvas = el.querySelector('[data-testid="page-canvas"]');
    expect(canvas?.classList).toContain('max-w-7xl');
    expect(canvas?.classList).not.toContain('max-w-2xl');
    const formColumn = el.querySelector('aec-request-form-body')?.parentElement;
    expect(formColumn?.classList).toContain('max-w-2xl');
    expect(formColumn?.classList).toContain('lg:col-span-7');
    const rail = el.querySelector('aside[data-testid="context-rail"]');
    expect(rail?.classList).toContain('lg:col-start-9');
    expect(rail?.classList).toContain('lg:sticky');
    // Sticky sits on the grid child itself, so it travels the full grid row.
    expect(rail?.parentElement?.classList).toContain('lg:grid-cols-12');
    httpMock.verify();
  });

  it('names the company and the product page on a product claim, with the claim steps', () => {
    const { el, httpMock } = setup('product', 'claim', 'acme-takeoff', null, {
      name: 'Acme Takeoff',
      vendor: { id: 'v1', name: 'Acme Software', slug: 'acme-software', logo_url: null },
    });
    const rail = el.querySelector('[data-testid="context-rail"]')!;
    expect(rail.querySelector('[data-testid="request-rail-company"]')?.textContent?.trim()).toBe(
      'Acme Software',
    );
    expect(rail.textContent).toContain('Acme Takeoff');
    expect(rail.textContent).toContain('Nothing is granted until your claim is approved.');
    const link = rail.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/docs/vendors/claiming-your-listing');
    expect(link?.getAttribute('target')).toBe('_blank');
    httpMock.verify();
  });

  it('shows the correction steps and no target block on a correction page', () => {
    const { el, httpMock } = setup('product', 'correction');
    const rail = el.querySelector('[data-testid="context-rail"]')!;
    expect(rail.querySelector('[data-testid="request-rail-company"]')).toBeNull();
    expect(rail.textContent).toContain('We check your correction against the source.');
    expect(rail.querySelector('a')?.getAttribute('href')).toBe(
      '/docs/reviewers/requests-and-corrections',
    );
    httpMock.verify();
  });
});

describe('RequestFormBody bodyPrefill (AECI-967)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setupBody(bodyPrefill: string | null) {
    const api = makeApiMock();
    const session = makeSessionStub(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RequestsApi, useValue: api },
        { provide: SessionStatus, useValue: session.stub },
      ],
    });
    const fixture = TestBed.createComponent(RequestFormBody);
    fixture.componentRef.setInput('entity', 'product');
    fixture.componentRef.setInput('kind', 'correction');
    fixture.componentRef.setInput('slug', 'acme');
    fixture.componentRef.setInput('variant', 'drawer');
    fixture.componentRef.setInput('bodyPrefill', bodyPrefill);
    fixture.detectChanges();
    return {
      fixture,
      api,
      httpMock: TestBed.inject(HttpTestingController),
      el: fixture.nativeElement as HTMLElement,
    };
  }

  const SEED = 'The recorded Budget flow with Procore is wrong. What is actually correct: ';

  // AECI-987: the context rail belongs to the routed page. The drawer has none.
  it('renders no context rail in the drawer variant', () => {
    const { el, httpMock } = setupBody(null);
    expect(el.querySelector('[data-testid="context-rail"]')).toBeNull();
    expect(el.querySelector('aside')).toBeNull();
    httpMock.verify();
  });

  it('seeds the body textarea with the supplied text', () => {
    const { el, httpMock } = setupBody(SEED);
    expect((el.querySelector('#correction-body') as HTMLTextAreaElement).value).toBe(SEED);
    httpMock.verify();
  });

  // It is a SEED, not a value. The vendor is expected to finish the sentence,
  // and what reaches the API is whatever the textarea holds at submit.
  it('submits the edited seed, not the seed', async () => {
    const { fixture, el, api, httpMock } = setupBody(SEED);
    type(fixture, '#correction-body', SEED + 'it is inbound only.');
    type(fixture, '#correction-email', 'dana@example.com');
    await settle();
    fixture.detectChanges();

    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();

    expect(api.submitCorrection).toHaveBeenCalledTimes(1);
    const [, formValue] = api.submitCorrection.mock.calls[0];
    expect(formValue.body).toBe(SEED + 'it is inbound only.');
    httpMock.verify();
  });

  // The default for every other trigger in the app.
  it('leaves the body empty when no prefill is supplied', () => {
    const { el, httpMock } = setupBody(null);
    expect((el.querySelector('#correction-body') as HTMLTextAreaElement).value).toBe('');
    httpMock.verify();
  });
});

// The drawer variant renders no header of its own on success: the drawer panel
// swaps its title and subtitle (request-drawer.html), so nothing stacks.
describe('RequestFormBody drawer confirmation', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function setupDrawerClaim() {
    const api = makeApiMock();
    const session = makeSessionStub(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RequestsApi, useValue: api },
        { provide: SessionStatus, useValue: session.stub },
      ],
    });
    const fixture = TestBed.createComponent(RequestFormBody);
    fixture.componentRef.setInput('entity', 'vendor');
    fixture.componentRef.setInput('kind', 'claim');
    fixture.componentRef.setInput('slug', 'acme');
    fixture.componentRef.setInput('variant', 'drawer');
    const sent: string[] = [];
    fixture.componentInstance.sent.subscribe((email) => sent.push(email));
    fixture.detectChanges();
    return {
      fixture,
      sent,
      httpMock: TestBed.inject(HttpTestingController),
      el: fixture.nativeElement as HTMLElement,
    };
  }

  async function submitClaim(fixture: ComponentFixture<RequestFormBody>, el: HTMLElement) {
    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    toggleTerms(fixture);
    type(fixture, '#claim-email', '  dana@acme.example ');
    type(fixture, '#claim-body', 'I run the integrations program at Acme and own this listing.');
    await settle();
    fixture.detectChanges();
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();
  }

  it('emits the trimmed email and renders steps without a heading of its own', async () => {
    const { fixture, sent, el, httpMock } = setupDrawerClaim();
    await submitClaim(fixture, el);

    expect(sent).toEqual(['dana@acme.example']);
    expect(el.querySelector('h1')).toBeNull();
    expect(el.textContent).not.toContain('Submission received');
    expect(el.textContent).toContain('Nothing is granted automatically');
    // AECI-1266: one set of steps for every listing, no access-request variant.
    expect(el.textContent).not.toContain('who already holds a seat on the account');
    const done = el.querySelector('button') as HTMLButtonElement;
    expect(done.textContent).toContain('Done');
    await settle();
    expect(document.activeElement).toBe(done);
    httpMock.verify();
  });
});

// ── AECI-1366: the vendor terms box, the seat disclosure and the receipt ────────
describe('RequestForm vendor terms and routed claims (AECI-1366)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const squash = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

  async function fillClaim(fixture: ComponentFixture<unknown>, terms = true) {
    type(fixture, '#claim-name', 'Dana Reyes');
    type(fixture, '#claim-role', 'Head of Partnerships');
    type(fixture, '#claim-email', 'dana@acme.example');
    if (terms) toggleTerms(fixture);
    await settle();
    fixture.detectChanges();
  }

  async function send(fixture: ComponentFixture<unknown>, el: HTMLElement) {
    (el.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
  }

  it('renders the box unchecked with a link to the vendor terms, and submit stays disabled until it is ticked', async () => {
    const { fixture, el } = setup('vendor', 'claim', 'acme-co');
    const box = el.querySelector('#claim-terms') as HTMLInputElement;
    expect(box.type).toBe('checkbox');
    expect(box.checked).toBe(false);
    const label = el.querySelector('label[for="claim-terms"]')!;
    expect(squash(label.textContent)).toContain(
      'I represent this company and accept the vendor terms',
    );
    const link = label.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/legal/vendor-terms');
    expect(link.getAttribute('target')).toBe('_blank');

    await fillClaim(fixture, false);
    const button = el.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    toggleTerms(fixture);
    await settle();
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
  });

  it('ties the error to the box with aria-describedby once it is left unticked', async () => {
    const { fixture, el, api } = setup('vendor', 'claim', 'acme-co');
    await fillClaim(fixture);
    toggleTerms(fixture);
    (el.querySelector('#claim-terms') as HTMLInputElement).dispatchEvent(new Event('blur'));
    await settle();
    fixture.detectChanges();

    const box = el.querySelector('#claim-terms') as HTMLInputElement;
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.getAttribute('aria-describedby')).toBe('claim-terms-error');
    expect(el.querySelector('#claim-terms-error')?.getAttribute('role')).toBe('alert');
    await send(fixture, el);
    expect(api.submitClaim).not.toHaveBeenCalled();
  });

  it('sends accepted_terms: true and says the receipt was emailed', async () => {
    const { fixture, el, api } = setup('vendor', 'claim', 'acme-co');
    await fillClaim(fixture);
    await send(fixture, el);
    expect(api.submitClaim).toHaveBeenCalledTimes(1);
    expect(api.submitClaim.mock.calls[0]![1]).toMatchObject({ accepted_terms: true });
    expect(squash(el.textContent)).toContain(
      "We've emailed a receipt to dana@acme.example. We'll write to you there with our decision.",
    );
  });

  it('shows the ruled disclosure when the company has an owner seat, and the routed receipt', async () => {
    const { fixture, el, api } = setup(
      'vendor',
      'claim',
      'acme-co',
      null,
      { company_name: 'Acme Software' },
      { getClaimTarget: vi.fn(async () => ({ vendor_id: 'v-1', has_seats: true })) },
    );
    await settle();
    fixture.detectChanges();
    await settle();
    fixture.detectChanges();
    expect(api.getClaimTarget).toHaveBeenCalledWith({ targetType: 'vendor', slug: 'acme-co' });
    expect(squash(el.querySelector('[data-testid="claim-routed-notice"]')?.textContent)).toBe(
      'Acme Software already maintains this listing. Send your request and their team will confirm you. We step in if they do not answer within 7 days.',
    );

    await fillClaim(fixture);
    await send(fixture, el);
    expect(squash(el.querySelector('[data-testid="request-sent-routed"]')?.textContent)).toBe(
      'The team at Acme Software has been asked to confirm you.',
    );
    expect(squash(el.textContent)).toContain("We've emailed a receipt to dana@acme.example.");
    expect(squash(el.textContent)).toContain(
      'If they accept, you get an invitation email to join. If nobody answers within 7 days, we review your claim and write to you.',
    );
    expect(el.textContent).not.toContain('Nothing is granted automatically');
    expect(el.textContent).not.toContain('with our decision');
    expect(el.textContent).not.toContain('link to your vendor portal');
  });

  it('an anonymous claim says "Check your inbox" and puts the emailed link first (AECI-1435)', async () => {
    const { fixture, el } = setup('vendor', 'claim', 'acme-co', null, undefined, {
      submitClaim: vi.fn(async () => ({
        request_id: 'req-1',
        message: 'ok',
        confirmation_required: true,
      })),
    });
    await fillClaim(fixture);
    await send(fixture, el);
    expect(squash(el.querySelector('h1')?.textContent)).toBe('Check your inbox');
    expect(squash(el.textContent)).toContain(
      "We've sent a link to dana@acme.example. Your claim is not sent until you click it.",
    );
    expect(squash(el.querySelector('[data-testid="request-sent-confirm"]')?.textContent)).toBe(
      'Open the email and click the link. It works for 7 days.',
    );
    expect(el.textContent).not.toContain('Claim sent');
    expect(el.textContent).not.toContain("We've emailed a receipt");
  });

  it('a failed lookup shows no disclosure and never blocks the submit', async () => {
    const { fixture, el, api } = setup('vendor', 'claim', 'acme-co', null, undefined, {
      getClaimTarget: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await settle();
    fixture.detectChanges();
    expect(api.getClaimTarget).toHaveBeenCalledTimes(1);
    expect(el.querySelector('[data-testid="claim-routed-notice"]')).toBeNull();
    await fillClaim(fixture);
    await send(fixture, el);
    expect(api.submitClaim).toHaveBeenCalledTimes(1);
  });

  it('maps a 400 on accepted_terms (a stale bundle) to the box, not the generic failure', async () => {
    const { fixture, el, api } = setup('vendor', 'claim', 'acme-co');
    api.submitClaim.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 400,
        error: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request failed validation',
            field: 'submitter_role',
            details: { issues: [{ path: ['submitter_role'] }, { path: ['accepted_terms'] }] },
          },
        },
      }),
    );
    await fillClaim(fixture);
    await send(fixture, el);

    const box = el.querySelector('#claim-terms') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(el.querySelector('#claim-terms-error')).not.toBeNull();
    expect(box.getAttribute('aria-describedby')).toBe('claim-terms-error');
    expect(el.textContent).not.toContain('Something went wrong');
    expect(document.activeElement).toBe(box);
  });
});
