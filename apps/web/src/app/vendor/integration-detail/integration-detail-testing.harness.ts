import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { computed, provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import type { ListVendorContestsResponse, VendorIntegration, VendorMeResponse } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { IntegrationDetailState } from './integration-detail-state';

/**
 * Test-only helpers for the integration detail page's component specs (§6.17).
 * A `.harness.ts`, so it stays out of the app build (`tsconfig.app.json`).
 */

export type MockApi = Record<
  | 'getIntegrations'
  | 'getContests'
  | 'getDataObjects'
  | 'upsertAttestation'
  | 'retractAttestation'
  | 'createClaim'
  | 'updateIntegration'
  | 'claimIntegration'
  | 'putIntegrationLink'
  | 'deleteIntegrationLink'
  | 'submitContest'
  | 'decideContest'
  | 'withdrawContest'
  | 'retireIntegration'
  | 'restoreIntegration'
  | 'getNotifications',
  ReturnType<typeof vi.fn>
>;

export const NO_CONTESTS: ListVendorContestsResponse = { submitted: [], received: [] };

export function makeApi(
  integrations: readonly VendorIntegration[],
  contests: ListVendorContestsResponse = NO_CONTESTS,
): MockApi {
  return {
    getIntegrations: vi.fn().mockResolvedValue({
      integrations,
      owned: [],
      counterpart_added_unanswered: 0,
    }),
    getContests: vi.fn().mockResolvedValue(contests),
    getDataObjects: vi.fn().mockResolvedValue({
      data_objects: [
        { slug: 'models', name: 'Models', description: null },
        { slug: 'drawings', name: 'Drawings', description: null },
        { slug: 'rfis', name: 'RFIs', description: null },
      ],
    }),
    upsertAttestation: vi.fn(),
    retractAttestation: vi.fn().mockResolvedValue(undefined),
    createClaim: vi.fn(),
    updateIntegration: vi.fn(),
    claimIntegration: vi.fn().mockResolvedValue({}),
    putIntegrationLink: vi.fn(),
    deleteIntegrationLink: vi.fn(),
    submitContest: vi.fn(),
    decideContest: vi.fn().mockResolvedValue({}),
    withdrawContest: vi.fn().mockResolvedValue({}),
    retireIntegration: vi.fn(),
    restoreIntegration: vi.fn(),
    getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
  };
}

/** Configure TestBed for a section component, with the store seeded and the
 *  page state bound to the store's entry for `integration`. */
export async function setup(
  api: MockApi,
  integration: VendorIntegration,
  me: VendorMeResponse = VENDOR_ME_FIXTURE,
): Promise<{ store: VendorPortalStore; state: IntegrationDetailState }> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
      IntegrationDetailState,
    ],
  });
  const store = TestBed.inject(VendorPortalStore);
  store.seed(me);
  await store.ensure('integrations');
  const state = TestBed.inject(IntegrationDetailState);
  state.bind(
    computed(
      () =>
        store
          .integrations()
          .find(
            (i) =>
              i.id === integration.id && i.context_product.id === integration.context_product.id,
          ) ?? null,
    ),
  );
  await state.ensureContests(integration.id);
  return { store, state };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

export async function settle(fixture: ComponentFixture<unknown>, rounds = 3): Promise<void> {
  for (let n = 0; n < rounds; n++) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

/** Create a section component with the store's current entry as its input. */
export async function mount<T>(
  component: Type<T>,
  integration: VendorIntegration,
): Promise<ComponentFixture<T>> {
  const fixture = TestBed.createComponent(component);
  const store = TestBed.inject(VendorPortalStore);
  const entry =
    store
      .integrations()
      .find(
        (i) => i.id === integration.id && i.context_product.id === integration.context_product.id,
      ) ?? integration;
  fixture.componentRef.setInput('integration', entry);
  await settle(fixture);
  return fixture;
}

/** Re-feed the store's entry after a write, as the page's binding would. */
export async function refresh<T>(
  fixture: ComponentFixture<T>,
  integration: VendorIntegration,
): Promise<void> {
  const store = TestBed.inject(VendorPortalStore);
  const entry = store
    .integrations()
    .find(
      (i) => i.id === integration.id && i.context_product.id === integration.context_product.id,
    );
  if (entry) fixture.componentRef.setInput('integration', entry);
  await settle(fixture);
}

export function apiError(
  status: number,
  code: string,
  details?: Record<string, unknown>,
): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code, details } } });
}

export const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
export const text = (fixture: ComponentFixture<unknown>) => el(fixture).textContent ?? '';
export const buttonNamed = (fixture: ComponentFixture<unknown>, name: string | RegExp) =>
  [...el(fixture).querySelectorAll<HTMLButtonElement>('button')].find((b) => {
    const label = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '';
    return typeof name === 'string' ? label === name : name.test(label);
  });
