/**
 * Tests for `PosthogErrorHandler` (AECI-643 / §3.3, Tier 2).
 *
 * `.component.spec.ts` so it runs under `ng test` — the handler resolves
 * `Analytics` from the `Injector`, so it needs a real TestBed.
 */
import { ErrorHandler } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('posthog-js/dist/module.full.no-external', async () => {
  const { posthogJsModuleMock } = await import('./posthog-js.harness');
  return posthogJsModuleMock();
});

import { AppUpdateService } from '../core/app-update/app-update.service';

import { Analytics } from './analytics';
import { PosthogErrorHandler } from './posthog-error-handler';

function setup(analytics: Partial<Analytics>, appUpdate: Partial<AppUpdateService> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: Analytics, useValue: analytics },
      { provide: AppUpdateService, useValue: appUpdate },
      { provide: ErrorHandler, useExisting: PosthogErrorHandler },
    ],
  });
  return TestBed.inject(ErrorHandler);
}

let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  error.mockRestore();
});

describe('PosthogErrorHandler', () => {
  it('forwards the error to Analytics.captureException', () => {
    const captureException = vi.fn();
    const handler = setup({ captureException });
    const thrown = new Error('boom');

    handler.handleError(thrown);

    expect(captureException).toHaveBeenCalledExactlyOnceWith(thrown);
  });

  it('still console.errors — the developer-visible signal is not swallowed', () => {
    const handler = setup({ captureException: vi.fn() });
    const thrown = new Error('boom');

    handler.handleError(thrown);

    expect(error).toHaveBeenCalledWith(thrown);
  });

  it('logs even when reporting throws, and never rethrows', () => {
    const handler = setup({
      captureException: vi.fn(() => {
        throw new Error('reporter exploded');
      }),
    });
    const thrown = new Error('boom');

    expect(() => handler.handleError(thrown)).not.toThrow();
    expect(error).toHaveBeenCalledWith(thrown);
  });

  it('handles non-Error values (a thrown string, a rejected object)', () => {
    const captureException = vi.fn();
    const handler = setup({ captureException });

    handler.handleError('a plain string');
    handler.handleError({ reason: 'rejected' });

    expect(captureException).toHaveBeenNthCalledWith(1, 'a plain string');
    expect(captureException).toHaveBeenNthCalledWith(2, { reason: 'rejected' });
  });

  it('is registered as the app ErrorHandler implementation', () => {
    const handler = setup({ captureException: vi.fn() });
    expect(handler).toBeInstanceOf(PosthogErrorHandler);
  });

  it('asks AppUpdateService to check on a chunk-load error (AECI-1493)', () => {
    const captureException = vi.fn();
    const check = vi.fn(() => Promise.resolve());
    const handler = setup({ captureException }, { check });
    const thrown = new TypeError('Failed to fetch dynamically imported module: /chunk-OLD.js');

    handler.handleError(thrown);

    expect(captureException).toHaveBeenCalledExactlyOnceWith(thrown);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('does not check on any other error', () => {
    const check = vi.fn(() => Promise.resolve());
    const handler = setup({ captureException: vi.fn() }, { check });

    handler.handleError(new Error('boom'));

    expect(check).not.toHaveBeenCalled();
  });

  it('never rethrows when the update check throws', () => {
    const check = vi.fn(() => {
      throw new Error('check exploded');
    });
    const handler = setup({ captureException: vi.fn() }, { check });

    expect(() =>
      handler.handleError(new TypeError('Importing a module script failed.')),
    ).not.toThrow();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
