/**
 * Recognises a failed lazy-chunk load (AECI-1493).
 *
 * A deploy deletes the previous build's hashed chunks, so a tab opened before it
 * gets a 404 on its next lazy route or `@defer` block. The browser rejects the
 * `import()` with an engine-specific message, and Angular wraps a failed
 * `@defer` load in `NG0750`. In production builds that `RuntimeError` carries
 * only the code, so the code is matched as well as the message.
 *
 * The same messages also appear when the fetch is aborted on the visitor's side
 * (a frozen tab, a dropped connection). Callers therefore treat a match as
 * "check for a new build", never as proof of one.
 */

const CHUNK_LOAD_PATTERNS: readonly RegExp[] = [
  // Chromium and Edge.
  /Failed to fetch dynamically imported module/i,
  // Firefox.
  /error loading dynamically imported module/i,
  // Safari.
  /Importing a module script failed/i,
  // Angular's `@defer` dependency failure.
  /NG0750\b/,
];

/** The numeric `RuntimeError` code Angular uses for NG0750. */
const DEFER_LOAD_FAILED_CODE = -750;

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '';
}

export function isChunkLoadError(error: unknown): boolean {
  if (error == null) return false;
  if (typeof error === 'object' && (error as { code?: unknown }).code === DEFER_LOAD_FAILED_CODE) {
    return true;
  }
  const message = messageOf(error);
  return message !== '' && CHUNK_LOAD_PATTERNS.some((pattern) => pattern.test(message));
}
