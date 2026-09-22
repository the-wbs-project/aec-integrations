/**
 * AECI-1007 — "Your links" on the integration card
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.7).
 *
 * What these pin:
 *   1. Visibility: shown on every attestable edge whatever the entitlement (a seat
 *      is the whole gate), hidden on a connector-powered edge (decision 9).
 *   2. The form starts at the caller's saved links and sends only what changed:
 *      a value is a PUT for the caller's own product, a blank is a DELETE.
 *   3. The shared https rule refuses a bad link before any request leaves.
 *   4. Success splices the echo into the store, announces once, and closes.
 *   5. An API refusal renders a plain sentence in a `role="alert"`.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorIntegration } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_INTEGRATIONS_FIXTURE, VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationCard } from './vendor-integration-card';
import { VendorIntegrationLinksForm, linkValueProblem } from './vendor-integration-links-form';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The fixture whose listing link is already set, docs not. */
const PROCORE = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!;
const POWERED = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => !i.attestable)!;

let api: {
  getContests: ReturnType<typeof vi.fn>;
  putIntegrationLink: ReturnType<typeof vi.fn>;
  deleteIntegrationLink: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
    putIntegrationLink: vi.fn(),
    deleteIntegrationLink: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  const store = TestBed.inject(VendorPortalStore);
  store.seed(VENDOR_ME_FIXTURE);
  store.apply('integrations', () => VENDOR_INTEGRATIONS_FIXTURE.integrations).commit();
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;

async function createForm(
  integration: VendorIntegration = PROCORE,
): Promise<ComponentFixture<VendorIntegrationLinksForm>> {
  const fixture = TestBed.createComponent(VendorIntegrationLinksForm);
  fixture.componentRef.setInput('integration', integration);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  await settle(fixture);
  return fixture;
}

async function createCard(
  integration: VendorIntegration,
  canWrite: boolean,
): Promise<ComponentFixture<VendorIntegrationCard>> {
  const fixture = TestBed.createComponent(VendorIntegrationCard);
  fixture.componentRef.setInput('integration', integration);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  fixture.componentRef.setInput('canWrite', canWrite);
  fixture.componentRef.setInput('dataObjects', []);
  fixture.componentRef.setInput('versions', []);
  await settle(fixture);
  return fixture;
}

const trigger = (fixture: ComponentFixture<unknown>) =>
  [...el(fixture).querySelectorAll('button')].find((b) =>
    b.textContent?.includes('Edit your links'),
  );

async function open(fixture: ComponentFixture<unknown>): Promise<void> {
  trigger(fixture)!.click();
  await settle(fixture);
}

const input = (fixture: ComponentFixture<unknown>, kind: 'listing' | 'docs') =>
  el(fixture).querySelector<HTMLInputElement>(`input[id$="-${kind}"]`)!;

async function type(
  fixture: ComponentFixture<unknown>,
  kind: 'listing' | 'docs',
  value: string,
): Promise<void> {
  const node = input(fixture, kind);
  node.value = value;
  node.dispatchEvent(new Event('input'));
  await settle(fixture);
}

async function submit(fixture: ComponentFixture<unknown>): Promise<void> {
  el(fixture).querySelector('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

const echo = (links: { listing_url: string | null; docs_url: string | null }) => ({
  integration_id: PROCORE.id,
  product_id: PROCORE.context_product.id,
  links,
});

describe('VendorIntegrationLinksForm — visibility', () => {
  it('shows on an attestable card even without write access (a seat is the gate)', async () => {
    const fixture = await createCard(PROCORE, false);
    expect(trigger(fixture)).toBeTruthy();
  });

  it('is absent on a connector-powered card (decision 9)', async () => {
    const fixture = await createCard(POWERED, true);
    expect(trigger(fixture)).toBeUndefined();
  });

  it('is absent on a retired card (AECI-1010)', async () => {
    const fixture = await createCard({ ...PROCORE, retired_at: '2026-09-20T00:00:00.000Z' }, true);
    expect(trigger(fixture)).toBeUndefined();
  });

  it('summarises the saved links while closed', async () => {
    const fixture = await createForm();
    const summary = el(fixture).querySelector('[data-testid="own-links-summary"]')!.textContent!;
    expect(summary).toContain('https://summitbim.example.com/integrations/procore');
    expect(summary).toContain('Not set');
    expect(trigger(fixture)!.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('VendorIntegrationLinksForm — links stranded on a connector-powered row', () => {
  // Promote made the row connector-powered after the vendor set its links.
  const STRANDED: VendorIntegration = {
    ...POWERED,
    own_links: { listing_url: 'https://summitbim.example.com/l', docs_url: null },
  };

  it('renders on the card read-only, with no edit trigger', async () => {
    const fixture = await createCard(STRANDED, true);
    expect(trigger(fixture)).toBeUndefined();
    const block = el(fixture).querySelector('[data-testid="stranded-links"]');
    expect(block?.textContent).toContain('https://summitbim.example.com/l');
    expect(block?.textContent).not.toContain('Documentation');
    expect(el(fixture).textContent).toContain('no longer takes your own links');
  });

  it('is still absent on a connector-powered card with no stored link', async () => {
    const fixture = await createCard(
      { ...POWERED, own_links: { listing_url: null, docs_url: null } },
      true,
    );
    expect(el(fixture).querySelector('[data-testid="stranded-links"]')).toBeNull();
  });

  it('removes a link with a DELETE, splices the echo and announces', async () => {
    api.deleteIntegrationLink.mockResolvedValue({
      integration_id: STRANDED.id,
      product_id: STRANDED.context_product.id,
      links: { listing_url: null, docs_url: null },
    });
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await createForm(STRANDED);
    const remove = el(fixture).querySelector<HTMLButtonElement>(
      '[data-testid="stranded-links"] button',
    )!;
    expect(remove.getAttribute('aria-label')).toBe('Remove your listing page link');
    remove.click();
    await settle(fixture);
    expect(api.deleteIntegrationLink).toHaveBeenCalledWith(
      STRANDED.id,
      STRANDED.context_product.id,
      'listing',
    );
    expect(api.putIntegrationLink).not.toHaveBeenCalled();
    const entry = TestBed.inject(VendorPortalStore)
      .integrations()
      .find((i) => i.id === STRANDED.id && i.context_product.id === STRANDED.context_product.id);
    expect(entry?.own_links).toEqual({ listing_url: null, docs_url: null });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('renders a refusal as a sentence', async () => {
    api.deleteIntegrationLink.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'INTEGRATION_RETIRED', message: 'x' } },
      }),
    );
    const fixture = await createForm(STRANDED);
    el(fixture).querySelector<HTMLButtonElement>('[data-testid="stranded-links"] button')!.click();
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('retired');
  });
});

describe('VendorIntegrationLinksForm — saving', () => {
  it('prefills, then sends a PUT for a new value and a DELETE for a cleared one', async () => {
    api.putIntegrationLink.mockResolvedValue(
      echo({ listing_url: null, docs_url: 'https://summitbim.example.com/docs' }),
    );
    api.deleteIntegrationLink.mockResolvedValue(echo({ listing_url: null, docs_url: null }));
    const fixture = await createForm();
    await open(fixture);
    expect(trigger(fixture)!.getAttribute('aria-expanded')).toBe('true');
    expect(input(fixture, 'listing').value).toBe(PROCORE.own_links.listing_url);

    await type(fixture, 'listing', '');
    await type(fixture, 'docs', ' https://summitbim.example.com/docs ');
    await submit(fixture);

    expect(api.deleteIntegrationLink).toHaveBeenCalledWith(
      PROCORE.id,
      PROCORE.context_product.id,
      'listing',
    );
    expect(api.putIntegrationLink).toHaveBeenCalledWith(
      PROCORE.id,
      PROCORE.context_product.id,
      'docs',
      'https://summitbim.example.com/docs',
    );
    const stored = TestBed.inject(VendorPortalStore)
      .integrations()
      .find((i) => i.id === PROCORE.id && i.context_product.id === PROCORE.context_product.id)!;
    expect(stored.own_links).toEqual({
      listing_url: null,
      docs_url: 'https://summitbim.example.com/docs',
    });
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('are saved and live');
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('sends nothing when nothing changed', async () => {
    const fixture = await createForm();
    await open(fixture);
    await submit(fixture);
    expect(api.putIntegrationLink).not.toHaveBeenCalled();
    expect(api.deleteIntegrationLink).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('refuses an http link before any request leaves', async () => {
    const fixture = await createForm();
    await open(fixture);
    await type(fixture, 'docs', 'http://summitbim.example.com/docs');
    await submit(fixture);
    expect(api.putIntegrationLink).not.toHaveBeenCalled();
    const alert = el(fixture).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('https://');
    expect(input(fixture, 'docs').getAttribute('aria-invalid')).toBe('true');
  });

  it('renders the connector refusal as a sentence and keeps the form open', async () => {
    api.putIntegrationLink.mockRejectedValue(
      new HttpErrorResponse({
        status: 403,
        error: { error: { code: 'INTEGRATION_CONNECTOR_POWERED', message: 'x' } },
      }),
    );
    const fixture = await createForm();
    await open(fixture);
    await type(fixture, 'docs', 'https://summitbim.example.com/docs');
    await submit(fixture);
    expect(el(fixture).querySelector('form [role="alert"]')?.textContent).toContain(
      'delivered through a connector product',
    );
    expect(el(fixture).querySelector('form')).not.toBeNull();
  });
});

describe('linkValueProblem', () => {
  it('accepts blank and https, refuses everything else', () => {
    expect(linkValueProblem('')).toBeNull();
    expect(linkValueProblem('https://example.com/a')).toBeNull();
    expect(linkValueProblem('http://example.com/a')).not.toBeNull();
    expect(linkValueProblem('javascript:alert(1)')).not.toBeNull();
    expect(linkValueProblem('example.com')).not.toBeNull();
  });
});
