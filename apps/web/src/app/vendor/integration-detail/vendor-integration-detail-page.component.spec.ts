/**
 * AECI-1149 — the integration detail page shell (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.17.1, §6.17.2).
 *
 * What these pin: which entry the route names (id AND context product); not
 * found without a probe, and never before the list settles; the h2 title and
 * the status pill; "Things that need you" and its jumps; the section nav as
 * native fragment anchors with Overview current on first render; focus moving to
 * a section heading on a nav choice.
 */
import { provideHttpClient } from '@angular/common/http';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorApi } from '../vendor-api';
import {
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { makeApi, type MockApi } from './integration-detail-testing.harness';
import { VendorIntegrationDetailPage } from './vendor-integration-detail-page';

@Component({ selector: 'aec-test-list', template: 'list' })
class ListStub {}

let api: MockApi;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  api = makeApi([INTEGRATION_PROCORE_DETAIL, INTEGRATION_OWNED_CLAIMED]);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([
        { path: 'products/:productSlug/integrations', component: ListStub },
        {
          path: 'products/:productSlug/integrations/:integrationId',
          component: VendorIntegrationDetailPage,
        },
      ]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

const PRIMARY = INTEGRATION_PROCORE_DETAIL.context_product.slug;

async function open(path: string): Promise<{ harness: RouterTestingHarness; root: HTMLElement }> {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(path);
  for (let n = 0; n < 4; n++) {
    harness.detectChanges();
    await flush();
  }
  harness.detectChanges();
  return { harness, root: harness.routeNativeElement as HTMLElement };
}

describe('which entry the route names', () => {
  it('renders the integration under its product, titled as an h2', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expect(root.querySelector('h2')?.textContent?.trim()).toBe(
      'Summit Model Coordination and Procore',
    );
    expect(root.querySelector('[data-testid="integration-status"]')?.textContent).toContain(
      'Disagreement open',
    );
    expect(root.querySelectorAll('h3[id$="-heading"]').length).toBeGreaterThanOrEqual(5);
  });

  it('says not found for an id under a different product, and makes no request with it', async () => {
    const { root } = await open(
      `/products/summit-field-issues/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expect(root.querySelector('[data-testid="integration-not-found"]')).not.toBeNull();
    expect(root.textContent).toContain(
      'This integration is not one of Summit Field Issues’ integrations.',
    );
    expect(api.getContests).not.toHaveBeenCalled();
  });

  it('shows loading, never not found, before the list settles', async () => {
    api.getIntegrations.mockReturnValue(new Promise(() => undefined));
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expect(root.textContent).toContain('Loading the integration');
    expect(root.querySelector('[data-testid="integration-not-found"]')).toBeNull();
  });

  it('reads the page’s change requests with the integration filter', async () => {
    await open(`/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`);
    expect(api.getContests).toHaveBeenCalledWith(INTEGRATION_PROCORE_DETAIL.id);
  });
});

describe('"Things that need you"', () => {
  it('lists what needs the caller and what waits on someone else', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const needs = root.querySelector('[data-testid="integration-needs"]')!;
    expect(needs.querySelector('h3')?.textContent).toContain('Things that need you');
    expect(needs.textContent).toContain('Procore Technologies added Documents. Is this right?');
    expect(needs.textContent).toContain('Waiting on someone else');
  });

  it('jumps to the item and focuses it', async () => {
    const { harness, root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const item = [
      ...root.querySelectorAll<HTMLButtonElement>('[data-testid="integration-needs"] button'),
    ].find((b) => b.textContent?.includes('added Documents'))!;
    item.click();
    harness.detectChanges();
    await flush();
    harness.detectChanges();
    expect(document.activeElement?.id).toMatch(/^added-/);
  });
});

describe('the section nav', () => {
  it('is a named nav of native fragment anchors, Overview current first', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const nav = root.querySelector('nav[aria-label="Integration sections"]')!;
    const links = [...nav.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href')?.split('#')[1])).toEqual([
      'overview',
      'data-shared',
      'links',
      'change-requests',
      'settings',
    ]);
    expect(links[0]!.getAttribute('href')).toContain(
      `/integrations/${INTEGRATION_PROCORE_DETAIL.id}#`,
    );
    expect(links[0]!.getAttribute('aria-current')).toBe('location');
    for (const id of ['overview', 'data-shared', 'links', 'change-requests', 'settings']) {
      expect(root.querySelector(`#${id}`)?.className).toContain('scroll-mt-20');
    }
  });

  it('moves focus to the chosen section’s heading', async () => {
    const { harness, root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const link = root.querySelector<HTMLAnchorElement>('[data-testid="section-nav-settings"]')!;
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.click();
    harness.detectChanges();
    expect(document.activeElement?.id).toBe('settings-heading');
    expect(link.getAttribute('aria-current')).toBe('location');
  });

  it('links back to all integrations inside a breadcrumb nav', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const back = root.querySelector('nav[aria-label="Integration breadcrumb"] a')!;
    expect(back.getAttribute('href')).toBe(`/products/${PRIMARY}/integrations`);
    expect(back.textContent).toContain('All integrations');
  });

  it('opens the public page in a new tab and names the destination', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const link = [...root.querySelectorAll('a[target="_blank"]')].find((a) =>
      a.getAttribute('href')?.startsWith('/products/'),
    )!;
    expect(link.getAttribute('href')).toBe(`/products/${PRIMARY}/integrations/procore`);
    expect(link.getAttribute('aria-label')).toBe(
      'View public page: the Summit Model Coordination and Procore integration (opens in a new tab)',
    );
  });
});
