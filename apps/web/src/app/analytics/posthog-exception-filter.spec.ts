import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

import {
  dropInjectedScriptExceptions,
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
