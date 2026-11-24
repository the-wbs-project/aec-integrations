/**
 * AECI-2045 QA — the Integrations tab by product kind (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.13b, `DESIGN.md` "The Same-Behavior Rule").
 *
 * What these pin, against the dev preview's fake API and its `sync-service` fixture:
 * - a pure Sync Service (`connector`) leads with the pairs it delivers and a summary
 *   that counts them, offers exactly one "Add an integration" (its own form), and
 *   renders no endpoint list, no "0 rows of data", no "No integrations are on record"
 *   and no "Products you asked us to add";
 * - a `hybrid` Sync Service keeps both sections, each under a heading, with two
 *   triggers whose labels say what each adds, in the same button recipe;
 * - an `application` keeps exactly the ordinary create and no Sync Service form.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { PREVIEW_SYNC_ME } from '../../preview/vendor-dashboard/preview-sync-fixtures';
import {
  PREVIEW_SYNC_INTEGRATIONS,
  PreviewVendorApi,
} from '../../preview/vendor-dashboard/preview-vendor-api';
import { VendorApi } from '../vendor-api';
import { VENDOR_SEATS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationsPage } from './vendor-integrations-page';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'products/:productSlug/integrations', component: VendorIntegrationsPage },
      ]),
      PreviewVendorApi,
      { provide: VendorApi, useExisting: PreviewVendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(PreviewVendorApi).setFixture(
    PREVIEW_SYNC_ME,
    VENDOR_SEATS_FIXTURE,
    PREVIEW_SYNC_INTEGRATIONS,
    undefined,
    true,
  );
  TestBed.inject(VendorPortalStore).seed(PREVIEW_SYNC_ME);
});

async function open(slug: string): Promise<HTMLElement> {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(`/products/${slug}/integrations`);
  for (let n = 0; n < 6; n++) {
    harness.detectChanges();
    await flush();
  }
  harness.detectChanges();
  return harness.routeNativeElement as HTMLElement;
}

/** The visible "Add an integration…" triggers, in order. */
function addTriggers(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].filter((b) =>
    b.textContent?.trim().startsWith('Add an integration'),
  );
}

describe('the Integrations tab by product kind (AECI-2045 QA)', () => {
  it('a pure Sync Service leads with its pairs and offers one create', async () => {
    const root = await open('summit-sync');
    const text = root.textContent ?? '';
    expect(root.querySelector('h2')?.textContent).toContain('Integrations Summit Sync delivers');
    expect(root.querySelector('[data-testid="sync-summary"]')?.textContent).toContain(
      '3 integrations · 3 rows of data on record · 1 needs your answer',
    );
    expect(root.querySelector('aec-vendor-integrations-section')).toBeNull();
    expect(text).not.toContain('0 rows of data on record');
    expect(text).not.toContain('No integrations are on record for your products yet');
    expect(text).not.toContain('Products you asked us to add');
    const triggers = addTriggers(root);
    expect(triggers.map((b) => b.textContent?.trim())).toEqual(['Add an integration']);
    expect(triggers[0]!.dataset['testid']).toBe('sync-create-open');
    expect(triggers[0]!.classList).toContain('aec-btn');
    // The pairs sit under the Sync Service's heading, not a second "offers" heading.
    expect(
      root.querySelector('[data-owned-integrations="delivered"]')?.getAttribute('aria-labelledby'),
    ).toBe('vendor-sync-create-heading');
  });

  it('a hybrid Sync Service keeps both sections, each headed, with labelled triggers', async () => {
    const root = await open('summit-field-link');
    const headings = [...root.querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(headings).toContain('Integrations Summit Field Link delivers');
    expect(headings).toContain('Integrations that connect to Summit Field Link');
    const triggers = addTriggers(root);
    expect(triggers.map((b) => b.textContent?.trim())).toEqual([
      'Add an integration Summit Field Link delivers',
      'Add an integration with Summit Field Link',
    ]);
    // One recipe and size for both (the shared button).
    for (const b of triggers) expect(b.classList).toContain('aec-btn');
    expect(root.querySelector('[data-testid="integrations-summary"]')).not.toBeNull();
  });

  it('an application keeps exactly the ordinary create', async () => {
    const root = await open('summit-model-coordination');
    const triggers = addTriggers(root);
    expect(triggers.map((b) => b.textContent?.trim())).toEqual(['Add an integration']);
    expect(triggers[0]!.dataset['testid']).toBe('add-integration');
    expect(root.querySelector('aec-vendor-sync-service-pair-create')).toBeNull();
  });
});
