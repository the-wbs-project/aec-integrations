/**
 * Tests for `WaitlistWelcomeService` (AECI-243). Named `.component.spec.ts` so it
 * runs under the Angular/TestBed project — needs DI (`HttpClient`, `PLATFORM_ID`).
 *
 * Exercises the real `localStorage` (jsdom) so dedupe + dismissal persistence are
 * genuinely proven, mirroring the `PageViewTracker` HttpTestingController pattern.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  WAITLIST_DISMISSED_KEY,
  WAITLIST_LOGGED_TOKEN_KEY,
  WaitlistWelcomeService,
} from './waitlist-welcome.service';

function configure(platform: 'browser' | 'server' = 'browser') {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    svc: TestBed.inject(WaitlistWelcomeService),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

describe('WaitlistWelcomeService', () => {
  beforeEach(() => localStorage.clear());

  it('POSTs the campaign attribution once for a fresh token', () => {
    const { svc, httpMock } = configure();
    svc.logAttribution('tok-123');

    const req = httpMock.expectOne('/api/page-views');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ route: '/', ref_source: 'waitlist', ref_token: 'tok-123' });
    req.flush(null, { status: 204, statusText: 'No Content' });

    expect(localStorage.getItem(WAITLIST_LOGGED_TOKEN_KEY)).toBe('tok-123');
    httpMock.verify();
  });

  it('does not re-POST the same token (dedupe via localStorage)', () => {
    const { svc, httpMock } = configure();
    svc.logAttribution('tok-123');
    httpMock.expectOne('/api/page-views').flush(null, { status: 204, statusText: 'No Content' });

    svc.logAttribution('tok-123');
    httpMock.expectNone('/api/page-views');
    httpMock.verify();
  });

  it('logs a different token (a second invite link)', () => {
    const { svc, httpMock } = configure();
    svc.logAttribution('tok-1');
    httpMock.expectOne('/api/page-views').flush(null, { status: 204, statusText: 'No Content' });

    svc.logAttribution('tok-2');
    const req = httpMock.expectOne('/api/page-views');
    expect(req.request.body).toEqual({ route: '/', ref_source: 'waitlist', ref_token: 'tok-2' });
    req.flush(null, { status: 204, statusText: 'No Content' });
    httpMock.verify();
  });

  it('is a no-op for a missing token', () => {
    const { svc, httpMock } = configure();
    svc.logAttribution(null);
    svc.logAttribution(undefined);
    httpMock.expectNone('/api/page-views');
    httpMock.verify();
  });

  it('never POSTs on the server', () => {
    const { svc, httpMock } = configure('server');
    svc.logAttribution('tok-123');
    httpMock.expectNone('/api/page-views');
    httpMock.verify();
  });

  it('persists dismissal across service instances', () => {
    const first = configure();
    expect(first.svc.isDismissed()).toBe(false);
    first.svc.dismiss();
    expect(first.svc.isDismissed()).toBe(true);
    expect(localStorage.getItem(WAITLIST_DISMISSED_KEY)).toBe('1');

    // A fresh instance reads the same persisted decision.
    const second = configure();
    expect(second.svc.isDismissed()).toBe(true);
    second.httpMock.verify();
  });

  it('reports not-dismissed on the server', () => {
    localStorage.setItem(WAITLIST_DISMISSED_KEY, '1');
    const { svc } = configure('server');
    expect(svc.isDismissed()).toBe(false);
  });
});
