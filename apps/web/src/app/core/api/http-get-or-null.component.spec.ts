/**
 * Tests for the browser-side `httpGetOrNull` helper (AECI-151). Named
 * `.component.spec.ts` so it runs under `ng test` — needs Angular's
 * `HttpClient` + the testing backend.
 */
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { httpGetOrNull } from './http-get-or-null';

describe('httpGetOrNull', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('resolves the parsed body on a 200', async () => {
    const promise = httpGetOrNull<{ id: string }>(http, '/api/vendors/autodesk');
    const req = httpMock.expectOne('/api/vendors/autodesk');
    expect(req.request.method).toBe('GET');
    req.flush({ id: 'v1' });
    await expect(promise).resolves.toEqual({ id: 'v1' });
  });

  it('maps a 404 NOT_FOUND envelope to null', async () => {
    const promise = httpGetOrNull(http, '/api/vendors/ghost');
    httpMock
      .expectOne('/api/vendors/ghost')
      .flush(
        { error: { code: 'NOT_FOUND', message: 'missing' } },
        { status: 404, statusText: 'Not Found' },
      );
    await expect(promise).resolves.toBeNull();
  });

  it('maps a stringified NOT_FOUND envelope to null (unparsed body)', async () => {
    const promise = httpGetOrNull(http, '/api/vendors/ghost');
    httpMock
      .expectOne('/api/vendors/ghost')
      .flush(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'missing' } }), {
        status: 404,
        statusText: 'Not Found',
      });
    await expect(promise).resolves.toBeNull();
  });

  it('rethrows a 404 that is NOT the NOT_FOUND envelope', async () => {
    const promise = httpGetOrNull(http, '/api/vendors/ghost');
    httpMock
      .expectOne('/api/vendors/ghost')
      .flush({ error: { code: 'GONE', message: 'x' } }, { status: 404, statusText: 'Not Found' });
    await expect(promise).rejects.toBeTruthy();
  });

  it('rethrows non-404 errors', async () => {
    const promise = httpGetOrNull(http, '/api/vendors/autodesk');
    httpMock
      .expectOne('/api/vendors/autodesk')
      .flush(
        { error: { code: 'INTERNAL_ERROR', message: 'down' } },
        { status: 500, statusText: 'Server Error' },
      );
    await expect(promise).rejects.toBeTruthy();
  });
});
