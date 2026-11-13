/**
 * AECI-1689: `LegalInForceClient`, the browser answer for the claim box and the admin grant
 * form. Named `.component.spec.ts` so it runs under `ng test` (it needs `TestBed`).
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { LEGAL_IN_FORCE_MAPS, type LegalInForceMaps } from '@aeci/shared/api/legal-in-force';
import { legalEffectiveAtMs, type LegalPublishedResponse } from '@aeci/shared/api/legal-versions';

import {
  LEGAL_IN_FORCE_CLIENT_MAPS,
  LEGAL_MONOTONIC_MS,
  LegalInForceClient,
} from './legal-in-force-client';

const PATH = '/api/legal/published';
const DAY = '2027-03-31';
const MOMENT = legalEffectiveAtMs(DAY);
const HOUR = 3_600_000;
const MAPS: LegalInForceMaps = {
  ...LEGAL_IN_FORCE_MAPS,
  policyUpcoming: { listing_accuracy: { version: '1.1', effectiveOn: DAY } },
};
const res = (now: number): LegalPublishedResponse => ({
  now: new Date(now).toISOString(),
  published: [],
});

function setup(platform: 'browser' | 'server', maps: LegalInForceMaps = MAPS) {
  let mono = 0;
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: LEGAL_IN_FORCE_CLIENT_MAPS, useValue: maps },
      { provide: LEGAL_MONOTONIC_MS, useValue: () => mono },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    client: TestBed.inject(LegalInForceClient),
    http: TestBed.inject(HttpTestingController),
    advance: (ms: number) => (mono += ms),
  };
}

describe('LegalInForceClient', () => {
  it("reads nothing with today's empty maps, or on the server", async () => {
    const today = setup('browser', LEGAL_IN_FORCE_MAPS);
    await today.client.refresh();
    today.http.expectNone(PATH);
    const server = setup('server');
    await server.client.refresh();
    server.http.expectNone(PATH);
    expect(server.client.versions().policies.listing_accuracy).toBe('1.0');
  });

  it('decides with the API clock and keeps one answer until a moment passes', async () => {
    const t = setup('browser');
    const first = t.client.refresh();
    t.http.expectOne(PATH).flush(res(MOMENT - 2 * HOUR));
    await first;
    expect(t.client.versions().policies.listing_accuracy).toBe('1.0');

    // An hour later the moment is still ahead: the same answer, no read.
    t.advance(HOUR);
    await t.client.refresh();
    t.http.expectNone(PATH);

    // Past the moment on the page's own monotonic clock: ask again, and switch.
    t.advance(HOUR + 1);
    const again = t.client.refresh();
    t.http.expectOne(PATH).flush(res(MOMENT + 1));
    await again;
    expect(t.client.versions().policies.listing_accuracy).toBe('1.1');

    // No moment left: the answer holds for the page.
    t.advance(1000 * HOUR);
    await t.client.refresh();
    t.http.expectNone(PATH);
  });

  it('a failed read keeps the build versions and asks again next time', async () => {
    const t = setup('browser');
    const first = t.client.refresh();
    t.http.expectOne(PATH).flush('down', { status: 503, statusText: 'Service Unavailable' });
    await first;
    expect(t.client.versions().policies.listing_accuracy).toBe('1.0');
    const again = t.client.refresh();
    t.http.expectOne(PATH).flush(res(MOMENT));
    await again;
    expect(t.client.versions().policies.listing_accuracy).toBe('1.1');
  });
});
