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
 * (`posthog-client.ts`). Pure, so plain Vitest covers it.
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
