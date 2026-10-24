import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';
import { SessionStatus } from '../auth/session-status';
import { RequestsApi } from '../requests/requests-api';
import { ClaimDialogFlow } from '../shared/claim-dialog/claim-dialog-flow';
import { LIST_YOUR_PRODUCT_OPENING, ListYourProductPage } from './list-your-product';

/**
 * `/vendor-program/list-your-product` (AECI-1474, `docs/VENDOR_PROGRAM_PAGE_SPEC.md`
 * §2.5): the meta, the explainer, and the listing request form inline, opened on the
 * typed-in step. The flow's own behaviour is pinned in
 * `shared/claim-dialog/claim-dialog-flow.component.spec.ts`.
 */
async function setup() {
  const claimDialogStep = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: Analytics, useValue: { claimDialogStep, listingRequested: vi.fn() } },
      { provide: RequestsApi, useValue: {} },
      { provide: SessionStatus, useValue: { email: signal(null) } },
    ],
  });
  const fixture = TestBed.createComponent(ListYourProductPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    host: fixture.nativeElement as HTMLElement,
    title: TestBed.inject(Title),
    claimDialogStep,
  };
}

const content = (selector: string): string | null | undefined =>
  document.head.querySelector(selector)?.getAttribute('content');

const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('ListYourProductPage', () => {
  // The vitest builder shares one jsdom document and never resets <head>. Siblings
  // leave a noindex robots tag behind, so strip it first.
  beforeEach(() => {
    TestBed.resetTestingModule();
    document.head.querySelector('meta[name="robots"]')?.remove();
  });

  it('sets indexable meta with its own title, a canonical and the vendor program card', async () => {
    const { title } = await setup();
    expect(title.getTitle()).toBe('Ask us to list your product · AEC Integrations');
    expect(document.querySelector('meta[name="robots"]')).toBeNull();
    const description = content('meta[name="description"]') ?? '';
    expect(description).toContain('AEC software directory');
    expect(description).not.toContain('—');

    const canonical = document.head.querySelector('link[rel="canonical"]')?.getAttribute('href');
    expect(canonical).toMatch(/^https?:\/\/[^/]+\/vendor-program\/list-your-product$/);
    const origin = new URL(canonical!).origin;
    expect(content('meta[property="og:image"]')).toBe(`${origin}/branding/vendor-program-og.png`);
    expect(content('meta[property="og:image:alt"]')).toBeTruthy();
  });

  it('renders the explainer h1, the next-steps h2, then the form panel h2 over the flow h3', async () => {
    const { host } = await setup();
    const headings = [...host.querySelectorAll('h1, h2, h3')].map((h) => `${h.tagName}:${text(h)}`);
    expect(headings).toEqual([
      'H1:Ask us to list your product',
      'H2:What happens next',
      'H2:Request a listing',
      'H3:About you',
    ]);
    expect(text(host.querySelector('[data-testid="list-your-product-intro"] p'))).toBe(
      'Listing is free. Tell us the product and its website, and we take it from there.',
    );
    const form = host.querySelector('[data-testid="list-your-product-form"]')!;
    expect(form.getAttribute('aria-labelledby')).toBe('list-your-product-form-heading');
    expect(host.textContent).not.toContain('—');
  });

  it('lists what happens next in order, in the explainer column above the form', async () => {
    const { host } = await setup();
    const next = host.querySelector('[data-testid="list-your-product-next"]')!;
    expect(next.closest('[data-testid="list-your-product-intro"]')).not.toBeNull();
    const list = next.querySelector('ol')!;
    expect(list.getAttribute('aria-labelledby')).toBe('list-your-product-next-heading');
    const items = [...list.querySelectorAll(':scope > li')].map((li) =>
      [...li.querySelectorAll('p')].map(text),
    );
    expect(items).toEqual([
      ['Confirm your email.', 'We email you a link. Your request is sent when you click it.'],
      ['We review it.', "A person on our team checks the product's public pages."],
      ['We add the listing.', 'We write it from those pages and add it to the directory.'],
      ['You claim it.', 'We email you so you can claim the listing and keep it current.'],
    ]);
    // The badges are decoration: the <ol> carries the order.
    expect(
      [...list.querySelectorAll('li > span')].every(
        (s) => s.getAttribute('aria-hidden') === 'true',
      ),
    ).toBe(true);
  });

  it('embeds the flow inline on the typed-in step, with no dialog', async () => {
    const { fixture, host, claimDialogStep } = await setup();
    const flow = fixture.debugElement.query(By.directive(ClaimDialogFlow));
    expect(flow).not.toBeNull();
    expect(flow.componentInstance.opening()).toEqual({
      page: 'list_your_product',
      entry: 'list_page',
      start: 'typed',
    });
    expect(flow.componentInstance.embedded()).toBe(true);
    expect(LIST_YOUR_PRODUCT_OPENING.start).toBe('typed');
    expect(host.querySelector('aec-claim-dialog-host, brn-dialog')).toBeNull();
    expect(host.querySelector('#claim-dialog-listing-name')).not.toBeNull();
    expect(claimDialogStep).toHaveBeenCalledWith({
      step: 'you',
      page: 'list_your_product',
      entry: 'list_page',
      path: 'typed',
    });
  });

  // Cached HTML is the same for every visitor. The real `SessionStatus` reads the
  // session only in a browser-only `afterNextRender` probe, so the first render (the
  // one SSR emits) has an empty email field even for a signed-in visitor. The prefill
  // lands only after that probe.
  it('renders the form empty first, and prefills a signed-in email only after the probe', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: Analytics, useValue: { claimDialogStep: vi.fn(), listingRequested: vi.fn() } },
        { provide: RequestsApi, useValue: {} },
        {
          provide: AuthService,
          useValue: {
            isConfigured: () => true,
            hasSessionCookie: () => true,
            sessionSnapshot: () =>
              Promise.resolve({
                signedIn: true,
                email: 'me@acme.example',
                avatarUrl: null,
                fullName: null,
              }),
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ListYourProductPage);
    const host = fixture.nativeElement as HTMLElement;
    const email = () => host.querySelector<HTMLInputElement>('#claim-dialog-email')!.value;
    fixture.detectChanges();
    expect(email()).toBe('');
    expect(host.querySelector<HTMLInputElement>('#claim-dialog-listing-name')!.value).toBe('');
    await fixture.whenStable();
    fixture.detectChanges();
    expect(email()).toBe('me@acme.example');
  });
});
