/**
 * AECI-1689: the `legalSwitched` resolver. Named `.component.spec.ts` so it runs under
 * `ng test`: its `inject()` surface needs `TestBed`.
 *
 * INVARIANTS:
 *   1. With no upcoming entry (today) nothing is read and nothing is transferred.
 *   2. The server decides by its clock; before the moment it reads nothing.
 *   3. A failed "published" read keeps the pre-moment state and flags the request, so
 *      the runtime caches the page briefly.
 *   4. The browser hydrates to the server's answer from `TransferState`, never by its
 *      own clock, and on an in-app navigation decides with the API's `now`.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type ActivatedRouteSnapshot, convertToParamMap } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { legalEffectiveAtMs, type LegalPublishedResponse } from '@aeci/shared/api/legal-versions';

import { type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import {
  LEGAL_PUBLISHED_PATH,
  decideOnServer,
  legalSwitchedKey,
  resolveLegalSwitched,
} from './legal-in-force.resolver';
import type { LegalUpcomingEntry } from './legal-manifest';
import { LEGAL_UPCOMING_ENTRIES } from './legal-upcoming-token';

const DAY = '2027-03-31';
const MOMENT = legalEffectiveAtMs(DAY);
const VT: LegalUpcomingEntry = { slug: 'vendor-terms', version: '1.4', effectiveOn: DAY };
const LA: LegalUpcomingEntry = { slug: 'listing-accuracy', version: '1.1', effectiveOn: DAY };

const published = (now: number, rows = true): LegalPublishedResponse => ({
  now: new Date(now).toISOString(),
  published: rows
    ? [{ document: 'vendor_terms', version: '1.4', effective_at: new Date(MOMENT).toISOString() }]
    : [],
});

function routeFor(slug: string, version?: string): ActivatedRouteSnapshot {
  return {
    data: version === undefined ? { slug } : {},
    paramMap: convertToParamMap(version === undefined ? {} : { slug, version }),
  } as unknown as ActivatedRouteSnapshot;
}

function ctxWith(request: (path: string) => Promise<unknown>): AeciRequestContext {
  return createRequestContext({ request: vi.fn(request) as ServerApiClient['request'] });
}

function setup(opts: {
  platform: 'server' | 'browser';
  upcoming: readonly LegalUpcomingEntry[];
  ctx?: AeciRequestContext | null;
}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: LEGAL_UPCOMING_ENTRIES, useValue: opts.upcoming },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    transferState: TestBed.inject(TransferState),
    http: TestBed.inject(HttpTestingController),
    run: (route: ActivatedRouteSnapshot) =>
      TestBed.runInInjectionContext(() => resolveLegalSwitched(route)),
  };
}

afterEach(() => vi.useRealTimers());

describe("today's data (invariant 1)", () => {
  it.each(['server', 'browser'] as const)('%s: no entry, no read, no key', async (platform) => {
    const ctx = ctxWith(() => Promise.reject(new Error('no read expected')));
    const t = setup({ platform, upcoming: [], ctx });
    expect(await t.run(routeFor('vendor-terms'))).toBe(false);
    t.http.expectNone(LEGAL_PUBLISHED_PATH);
    expect(t.transferState.isEmpty).toBe(true);
    expect(ctx.legalStateUncertain).toBe(false);
  });
});

describe('server (invariants 2 and 3)', () => {
  beforeEach(() => vi.useFakeTimers());

  it('before the moment: false, nothing read, the answer transferred', async () => {
    vi.setSystemTime(MOMENT - 1);
    const request = vi.fn(() => Promise.resolve(published(MOMENT - 1)));
    const ctx = createRequestContext({ request: request as ServerApiClient['request'] });
    const t = setup({ platform: 'server', upcoming: [VT], ctx });
    expect(await t.run(routeFor('vendor-terms'))).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(t.transferState.get(legalSwitchedKey(VT), true)).toBe(false);
  });

  it('at the moment, a published agreement switches, on the version route too', async () => {
    vi.setSystemTime(MOMENT);
    const ctx = ctxWith(() => Promise.resolve(published(MOMENT)));
    const t = setup({ platform: 'server', upcoming: [VT], ctx });
    expect(await t.run(routeFor('vendor-terms', '1.3'))).toBe(true);
    expect(t.transferState.get(legalSwitchedKey(VT), false)).toBe(true);
    expect(ctx.legalStateUncertain).toBe(false);
  });

  it('at the moment, an unpublished agreement does not switch', async () => {
    vi.setSystemTime(MOMENT);
    const ctx = ctxWith(() => Promise.resolve(published(MOMENT, false)));
    const t = setup({ platform: 'server', upcoming: [VT], ctx });
    expect(await t.run(routeFor('vendor-terms'))).toBe(false);
  });

  it('a policy switches on its date with no read', async () => {
    const request = vi.fn(() => Promise.reject(new Error('no read expected')));
    const ctx = createRequestContext({ request: request as ServerApiClient['request'] });
    expect(await decideOnServer(LA, MOMENT, ctx)).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it('a failed read keeps the old version and flags the request (fail safe)', async () => {
    const ctx = ctxWith(() => Promise.reject(new Error('binding down')));
    expect(await decideOnServer(VT, MOMENT, ctx)).toBe(false);
    expect(ctx.legalStateUncertain).toBe(true);
  });
});

describe('browser (invariant 4)', () => {
  it('hydrates to the transferred answer and reads nothing, whatever its clock says', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(MOMENT + 86_400_000);
    const t = setup({ platform: 'browser', upcoming: [VT] });
    t.transferState.set(legalSwitchedKey(VT), false);
    expect(await t.run(routeFor('vendor-terms'))).toBe(false);
    t.http.expectNone(LEGAL_PUBLISHED_PATH);
    // Read once: a later in-app navigation asks the API again.
    expect(t.transferState.hasKey(legalSwitchedKey(VT))).toBe(false);
  });

  it('on an in-app navigation, decides with the API clock, not its own', async () => {
    vi.useFakeTimers();
    // The browser clock is a day behind; the API says the moment has come.
    vi.setSystemTime(MOMENT - 86_400_000);
    const t = setup({ platform: 'browser', upcoming: [VT] });
    const pending = t.run(routeFor('vendor-terms'));
    t.http.expectOne(LEGAL_PUBLISHED_PATH).flush(published(MOMENT));
    expect(await pending).toBe(true);
  });

  it('a failed read on navigation keeps the pre-moment state', async () => {
    const t = setup({ platform: 'browser', upcoming: [VT] });
    const pending = t.run(routeFor('vendor-terms'));
    t.http
      .expectOne(LEGAL_PUBLISHED_PATH)
      .flush('down', { status: 503, statusText: 'Service Unavailable' });
    expect(await pending).toBe(false);
  });
});
