import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

import {
  dropInjectedScriptExceptions,
  dropMaskedScriptError,
  isInjectedScriptException,
} from './posthog-exception-filter';

/** Plain-Vitest (node) coverage for the injected-script exception filter. */

const BRAVE_IOS =
  "undefined is not an object (evaluating 'window.ethereum.selectedAddress = undefined')";

function exceptionEvent(values: string[]): CaptureResult {
  return {
    uuid: 'u',
    event: '$exception',
    properties: {
      $exception_list: values.map((value) => ({ type: 'TypeError', value })),
      $exception_values: values,
    },
  } as CaptureResult;
}

describe('dropInjectedScriptExceptions', () => {
  it('drops the Brave iOS wallet-shim TypeError', () => {
    expect(dropInjectedScriptExceptions(exceptionEvent([BRAVE_IOS]))).toBeNull();
  });

  it('falls back to $exception_values when $exception_list is absent', () => {
    const event = {
      uuid: 'u',
      event: '$exception',
      properties: { $exception_values: [BRAVE_IOS] },
    } as CaptureResult;
    expect(isInjectedScriptException(event)).toBe(true);
  });

  it('keeps an app error', () => {
    const event = exceptionEvent(["Cannot read properties of undefined (reading 'slug')"]);
    expect(dropInjectedScriptExceptions(event)).toBe(event);
  });

  it('keeps an event that mixes an injected error with a real one', () => {
    const event = exceptionEvent([BRAVE_IOS, 'NG0100: ExpressionChangedAfterItHasBeenChecked']);
    expect(dropInjectedScriptExceptions(event)).toBe(event);
  });

  it('keeps an exception event with no messages', () => {
    const event = { uuid: 'u', event: '$exception', properties: {} } as CaptureResult;
    expect(dropInjectedScriptExceptions(event)).toBe(event);
  });

  it('never inspects non-exception events', () => {
    const event = {
      uuid: 'u',
      event: '$pageview',
      properties: { $exception_values: [BRAVE_IOS] },
    } as CaptureResult;
    expect(dropInjectedScriptExceptions(event)).toBe(event);
  });

  it('passes null through', () => {
    expect(dropInjectedScriptExceptions(null)).toBeNull();
  });
});

function maskedExceptionEvent(list: unknown[]): CaptureResult {
  return {
    uuid: 'u',
    event: '$exception',
    properties: { $exception_list: list },
  } as unknown as CaptureResult;
}

describe('dropMaskedScriptError', () => {
  it('drops the synthetic exception autocapture builds from window.onerror', () => {
    const event = maskedExceptionEvent([
      { type: 'Error', value: 'Script error.', mechanism: { handled: false, synthetic: true } },
    ]);
    expect(dropMaskedScriptError(event)).toBeNull();
  });

  it('drops a "Script error." entry with no frames', () => {
    const event = maskedExceptionEvent([
      { type: 'Error', value: 'Script error.', stacktrace: { type: 'raw', frames: [] } },
    ]);
    expect(dropMaskedScriptError(event)).toBeNull();
  });

  it('keeps a real error that happens to say "Script error." and has frames', () => {
    const event = maskedExceptionEvent([
      {
        type: 'Error',
        value: 'Script error.',
        mechanism: { synthetic: false },
        stacktrace: { type: 'raw', frames: [{ filename: '/main.js', lineno: 12 }] },
      },
    ]);
    expect(dropMaskedScriptError(event)).toBe(event);
  });

  it('keeps any other exception', () => {
    const event = maskedExceptionEvent([
      { type: 'TypeError', value: 'x is undefined', mechanism: { synthetic: true } },
    ]);
    expect(dropMaskedScriptError(event)).toBe(event);
  });

  it('keeps a chained exception list', () => {
    const event = maskedExceptionEvent([
      { type: 'Error', value: 'Script error.', mechanism: { synthetic: true } },
      { type: 'Error', value: 'cause' },
    ]);
    expect(dropMaskedScriptError(event)).toBe(event);
  });

  it('passes non-exception events and null through', () => {
    const event = { uuid: 'u', event: '$pageview', properties: {} } as unknown as CaptureResult;
    expect(dropMaskedScriptError(event)).toBe(event);
    expect(dropMaskedScriptError(null)).toBeNull();
  });
});
