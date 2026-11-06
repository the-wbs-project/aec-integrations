/**
 * Drops `$exception` events thrown by code the browser injects into our page,
 * not by our bundle.
 *
 * Brave on iOS injects a wallet-provider script into every page. On a page with
 * no `window.ethereum` (ours) it runs `window.ethereum.selectedAddress =
 * undefined` and throws a `TypeError`. The frame points at the document URL,
 * line 1, so PostHog files it as an in-app error on whatever route was open.
 * Our code never reads or writes `window.ethereum`. There is nothing to fix in
 * the app, so the report is noise and is dropped before it leaves the browser.
 *
 * Wired into the `before_send` hook in `createPostHogClient`
 * (`posthog-client.ts`). Pure, so plain Vitest covers it. The same file holds
 * `dropMaskedScriptError`, the filter for the masked cross-origin
 * "Script error." (see its own comment below).
 *
 * Rules:
 * - Only `$exception` events are inspected. Every other event passes through.
 * - An event is dropped only when EVERY exception in it matches a pattern
 *   below. A mixed event keeps its real error.
 * - Add a pattern only for an error proven to come from injected code. Name
 *   the source in a comment next to it.
 */
import type { CaptureResult } from 'posthog-js';

const INJECTED_SCRIPT_ERRORS: readonly RegExp[] = [
  // Brave iOS wallet shim: `window.ethereum.selectedAddress = undefined`.
  /\bwindow\.ethereum\b/,
];

function exceptionMessages(properties: Record<string, unknown>): string[] {
  const list = properties['$exception_list'];
  if (Array.isArray(list) && list.length > 0) {
    return list.map((entry: unknown) =>
      entry && typeof entry === 'object' && typeof (entry as { value?: unknown }).value === 'string'
        ? (entry as { value: string }).value
        : '',
    );
  }
  const values = properties['$exception_values'];
  if (Array.isArray(values) && values.length > 0) {
    return values.map((v: unknown) => (typeof v === 'string' ? v : ''));
  }
  return [];
}

/** True when the exception event was thrown by browser-injected code. */
export function isInjectedScriptException(event: CaptureResult): boolean {
  if (event.event !== '$exception' || !event.properties) return false;
  const messages = exceptionMessages(event.properties);
  return (
    messages.length > 0 &&
    messages.every((m) => INJECTED_SCRIPT_ERRORS.some((pattern) => pattern.test(m)))
  );
}

/**
 * `before_send` step. Returns `null` (drop) for an injected-script exception,
 * otherwise the event unchanged. A `null` input passes through.
 */
export function dropInjectedScriptExceptions(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  return isInjectedScriptException(event) ? null : event;
}

/*
 * Second filter: drops the browser's masked cross-origin "Script error." from
 * PostHog's own exception autocapture.
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
 * Runs after `dropInjectedScriptExceptions` in the `before_send` hook.
 */
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
