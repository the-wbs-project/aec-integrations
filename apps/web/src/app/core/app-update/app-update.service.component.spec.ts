/**
 * Tests for `AppUpdateService` (AECI-1493). Named `.component.spec.ts` so it
 * runs under `ng test`: it needs Angular DI (`HttpClient`, `Router`,
 * `PLATFORM_ID`, `DOCUMENT`).
 *
 * `PAGE_LOADER` is stubbed so a reload never navigates the test runner.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationError, Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AppUpdateService,
  BUILD_STAMP_META_NAME,
  MIN_CHECK_GAP_MS,
  PAGE_LOADER,
  VERSION_URL,
  reloadOnChunkLoadError,
} from './app-update.service';

@Component({ template: '' })
class Blank {}

function setStamp(sha: string | null): void {
  document.head.querySelector(`meta[name="${BUILD_STAMP_META_NAME}"]`)?.remove();
  if (sha === null) return;
  const meta = document.createElement('meta');
  meta.setAttribute('name', BUILD_STAMP_META_NAME);
  meta.setAttribute('content', sha);
  document.head.appendChild(meta);
}

function configure(platform: 'browser' | 'server' = 'browser') {
  const loader = { assign: vi.fn(), reload: vi.fn() };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: PAGE_LOADER, useValue: loader },
      provideRouter([
        { path: '', component: Blank },
        { path: 'products', component: Blank },
        { path: 'about', component: Blank },
      ]),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    loader,
    service: TestBed.inject(AppUpdateService),
    router: TestBed.inject(Router),
    httpMock: TestBed.inject(HttpTestingController),
  };
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
}

describe('AppUpdateService', () => {
  beforeEach(() => {
    setStamp('build-a');
    setVisibility('visible');
  });

  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    setStamp(null);
    vi.useRealTimers();
  });

  it('flags an update when /_version reports a different build', async () => {
    const { service, httpMock } = configure();
    service.start();
    const done = service.check();
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-b' });
    await done;
    expect(service.updateAvailable()).toBe(true);
  });

  it('stays quiet when the build matches', async () => {
    const { service, httpMock } = configure();
    service.start();
    const done = service.check();
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-a' });
    await done;
    expect(service.updateAvailable()).toBe(false);
  });

  it('ignores an unknown deployed SHA and a failed request', async () => {
    const { service, httpMock } = configure();
    service.start();
    let done = service.check();
    httpMock.expectOne(VERSION_URL).flush({ sha: 'unknown' });
    await done;
    done = service.check();
    httpMock.expectOne(VERSION_URL).flush('boom', { status: 500, statusText: 'Server Error' });
    await done;
    expect(service.updateAvailable()).toBe(false);
  });

  it('never checks without a build stamp, or with the unknown stamp', async () => {
    setStamp(null);
    const first = configure();
    first.service.start();
    await first.service.check();
    first.httpMock.expectNone(VERSION_URL);

    setStamp('unknown');
    const second = configure();
    second.service.start();
    await second.service.check();
    second.httpMock.expectNone(VERSION_URL);
  });

  it('is a no-op on the server', async () => {
    const { service, httpMock } = configure('server');
    service.start();
    await service.check();
    httpMock.expectNone(VERSION_URL);
  });

  it('checks when the tab becomes visible, at most once a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, httpMock } = configure();
    service.start();

    document.dispatchEvent(new Event('visibilitychange'));
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-a' });
    // Let the in-flight check settle (only `Date` is faked).
    await new Promise((resolve) => setTimeout(resolve));

    document.dispatchEvent(new Event('visibilitychange'));
    httpMock.expectNone(VERSION_URL);

    vi.setSystemTime(Date.now() + MIN_CHECK_GAP_MS + 1);
    document.dispatchEvent(new Event('visibilitychange'));
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-a' });
  });

  it('skips the visibility check while the tab is hidden', () => {
    const { service, httpMock } = configure();
    service.start();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    httpMock.expectNone(VERSION_URL);
  });

  it('turns the next navigation into a full page load once an update is known', async () => {
    const { service, router, loader } = configure();
    service.start();
    await router.navigateByUrl('/products');
    expect(loader.assign).not.toHaveBeenCalled();

    service.updateAvailable.set(true);
    await router.navigateByUrl('/about');
    expect(loader.assign).toHaveBeenCalledWith('/about');
  });

  it('leaves a fragment-only navigation alone', async () => {
    const { service, router, loader } = configure();
    service.start();
    await router.navigateByUrl('/products');
    service.updateAvailable.set(true);
    await router.navigateByUrl('/products#integrations');
    expect(loader.assign).not.toHaveBeenCalled();
  });

  it('leaves a query-only navigation alone (search typing, filters, paging)', async () => {
    const { service, router, loader } = configure();
    service.start();
    await router.navigateByUrl('/products');
    service.updateAvailable.set(true);
    await router.navigateByUrl('/products?q=rev');
    await router.navigateByUrl('/products?q=revit&page=2');
    expect(loader.assign).not.toHaveBeenCalled();
  });

  it('recoverNavigation reloads to the target when a new build is confirmed', async () => {
    const { service, httpMock, loader } = configure();
    const done = service.recoverNavigation('/products/acme');
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-b' });
    await done;
    expect(loader.assign).toHaveBeenCalledWith('/products/acme');
  });

  it('recoverNavigation does nothing when the build is unchanged, so it cannot loop', async () => {
    const { service, httpMock, loader } = configure();
    const done = service.recoverNavigation('/products/acme');
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-a' });
    await done;
    expect(loader.assign).not.toHaveBeenCalled();
  });

  it('never writes browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { service, httpMock } = configure();
    const done = service.recoverNavigation('/products/acme');
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-b' });
    await done;
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('reload() reloads the page', () => {
    const { service, loader } = configure();
    service.reload();
    expect(loader.reload).toHaveBeenCalledTimes(1);
  });
});

describe('reloadOnChunkLoadError', () => {
  beforeEach(() => setStamp('build-a'));
  afterEach(() => setStamp(null));

  it('reloads to the target on a chunk-load failure once a new build is confirmed', async () => {
    const { loader, httpMock } = configure();
    const error = new NavigationError(
      1,
      '/products/acme',
      new TypeError('Failed to fetch dynamically imported module: /chunk-OLD.js'),
    );
    TestBed.runInInjectionContext(() => reloadOnChunkLoadError(error));
    httpMock.expectOne(VERSION_URL).flush({ sha: 'build-b' });
    await new Promise((resolve) => setTimeout(resolve));
    expect(loader.assign).toHaveBeenCalledWith('/products/acme');
  });

  it('ignores any other navigation error', () => {
    const { loader, httpMock } = configure();
    const error = new NavigationError(1, '/products/acme', new Error('resolver blew up'));
    TestBed.runInInjectionContext(() => reloadOnChunkLoadError(error));
    httpMock.expectNone(VERSION_URL);
    expect(loader.assign).not.toHaveBeenCalled();
  });
});
