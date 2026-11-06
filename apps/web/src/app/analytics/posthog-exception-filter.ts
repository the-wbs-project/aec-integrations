/**
 * Drops the browser's masked cross-origin "Script error." from PostHog's own
 * exception autocapture.
 *
 * `capture_exceptions: true` makes posthog-js wrap `window.onerror`. For a
 * masked event the browser passes no error object, so the SDK builds the
 * exception from the message string alone. The result is one `$exception`
 * entry with the value "Script error.", flagged `synthetic`, with no stack.
 * That path never reaches Angular's `ErrorHandler`, so the check in
 * `posthog-error-handler.ts` cannot stop it. This hook does.
 *
 * A real `Error` thrown by our code with the same message is not synthetic and
 * carries frames, so it still reports.
 *
 * Wired as the first step of the `before_send` hook in `posthog-client.ts`.
 * Pure, so plain Vitest covers it.
 */
import type { CaptureResult } from 'posthog-js';

interface ExceptionEntry {
  value?: unknown;
  mechanism?: { synthetic?: unknown };
  stacktrace?: { frames?: unknown };
}

function isMaskedEntry(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const { value, mechanism, stacktrace } = entry as ExceptionEntry;
  if (typeof value !== 'string' || !value.startsWith('Script error')) return false;
  const frames = stacktrace?.frames;
  const hasFrames = Array.isArray(frames) && frames.length > 0;
  return mechanism?.synthetic === true || !hasFrames;
}

/** Returns `null` for a masked "Script error." exception, else the event unchanged. */
export function dropMaskedScriptError(event: CaptureResult | null): CaptureResult | null {
  if (!event || event.event !== '$exception') return event;
  const list: unknown = event.properties?.['$exception_list'];
  if (!Array.isArray(list) || list.length !== 1) return event;
  return isMaskedEntry(list[0]) ? null : event;
}
