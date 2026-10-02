/**
 * Tests for `ArrivalCaptureService` (AECI-1208). Named `.component.spec.ts` so it
 * runs under `ng test`: it needs Angular DI (`HttpClient`, `PLATFORM_ID`) and a
 * real effect.
 *
 * `SessionStatus` is stubbed with a writable signal so a test can flip the
 * signed-in state the way the post-hydration probe does.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionStatus } from '../auth/session-status';

import { ARRIVAL_BEACON_URL, ArrivalCaptureService } from './arrival-capture.service';

function configure(platform: 'browser' | 'server', signedIn = false) {
  const signedInSignal = signal(signedIn);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: SessionStatus, useValue: { signedIn: signedInSignal.asReadonly() } },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    signedIn: signedInSignal,
    service: TestBed.inject(ArrivalCaptureService),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

describe('ArrivalCaptureService', () => {
  let storageSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    storageSpies = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
    ];
  });

  afterEach(() => {
    // It never touches localStorage or sessionStorage, on any path.
    for (const spy of storageSpies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it('sends the allowlisted params once when signed in', () => {
    const { service, httpMock } = configure('browser', true);
    service.start('?utm_source=email&utm_campaign=seat_invite&n=42&ref=x&token=secret');
    TestBed.tick();

    const req = httpMock.expectOne(ARRIVAL_BEACON_URL);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ utm_source: 'email', utm_campaign: 'seat_invite', n: '42' });
    req.flush(null, { status: 204, statusText: 'No Content' });

    // Later signal churn and a second start() send nothing more.
    service.start('?utm_source=other');
    TestBed.tick();
    httpMock.expectNone(ARRIVAL_BEACON_URL);
    httpMock.verify();
  });

  it('waits for the post-hydration sign-in, then sends once', () => {
    const { service, signedIn, httpMock } = configure('browser', false);
    service.start('?utm_source=email');
    TestBed.tick();
    httpMock.expectNone(ARRIVAL_BEACON_URL);

    signedIn.set(true);
    TestBed.tick();
    httpMock.expectOne(ARRIVAL_BEACON_URL).flush(null, { status: 204, statusText: 'No Content' });

    // A stale cookie corrected back to neutral, then signed in again: still once.
    signedIn.set(false);
    TestBed.tick();
    signedIn.set(true);
    TestBed.tick();
    httpMock.expectNone(ARRIVAL_BEACON_URL);
    httpMock.verify();
  });

  it('sends nothing when signed out', () => {
    const { service, httpMock } = configure('browser', false);
    service.start('?utm_source=email&n=42');
    TestBed.tick();
    httpMock.expectNone(ARRIVAL_BEACON_URL);
    httpMock.verify();
  });

  it('sends nothing when the landing URL carries no valid arrival param', () => {
    const { service, httpMock } = configure('browser', true);
    service.start('?ref=waitlist&token=t&n=abc');
    TestBed.tick();
    httpMock.expectNone(ARRIVAL_BEACON_URL);
    httpMock.verify();
  });

  it('is a no-op on the server', () => {
    const { service, httpMock } = configure('server', true);
    service.start('?utm_source=email');
    TestBed.tick();
    httpMock.expectNone(ARRIVAL_BEACON_URL);
    httpMock.verify();
  });

  it('swallows a failed beacon', () => {
    const { service, httpMock } = configure('browser', true);
    service.start('?utm_source=email');
    TestBed.tick();
    httpMock
      .expectOne(ARRIVAL_BEACON_URL)
      .flush({ error: 'nope' }, { status: 401, statusText: 'Unauthorized' });
    httpMock.verify();
  });
});
