import type { CaptureResult } from 'posthog-js';
import { describe, expect, it } from 'vitest';

import { dropMaskedScriptError } from './posthog-exception-filter';

/** Plain-Vitest (node) coverage for the masked "Script error." `before_send` filter. */

function exceptionEvent(list: unknown[]): CaptureResult {
  return {
    uuid: 'u',
    event: '$exception',
    properties: { $exception_list: list },
  } as unknown as CaptureResult;
}

describe('dropMaskedScriptError', () => {
  it('drops the synthetic exception autocapture builds from window.onerror', () => {
    const event = exceptionEvent([
      { type: 'Error', value: 'Script error.', mechanism: { handled: false, synthetic: true } },
    ]);
    expect(dropMaskedScriptError(event)).toBeNull();
  });

  it('drops a "Script error." entry with no frames', () => {
    const event = exceptionEvent([
      { type: 'Error', value: 'Script error.', stacktrace: { type: 'raw', frames: [] } },
    ]);
    expect(dropMaskedScriptError(event)).toBeNull();
  });

  it('keeps a real error that happens to say "Script error." and has frames', () => {
    const event = exceptionEvent([
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
    const event = exceptionEvent([
      { type: 'TypeError', value: 'x is undefined', mechanism: { synthetic: true } },
    ]);
    expect(dropMaskedScriptError(event)).toBe(event);
  });

  it('keeps a chained exception list', () => {
    const event = exceptionEvent([
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
