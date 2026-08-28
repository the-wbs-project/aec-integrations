/**
 * Read the HTTP status off a caught error, structurally.
 *
 * **Not `err instanceof HttpErrorResponse`.** The admin area is lazily
 * code-split, one chunk per screen, so an error constructed in one chunk and
 * caught in another can fail an identity check even though it is exactly the
 * object you think it is. The failure mode is the worst kind: the `catch` runs,
 * the `instanceof` quietly returns `false`, and a 404 renders as a generic "we
 * couldn't load this" instead of "no such user".
 *
 * Lifted out of `vendors/vendor-detail.ts` by AECI-692, where it was a
 * module-private function, because `/admin/users` needs the same discrimination
 * and a second copy would be a second place for the reasoning to be lost.
 *
 * Deliberately a plain predicate over `unknown` rather than a type guard: callers
 * want to branch on the status, not to narrow the error, and narrowing to
 * `HttpErrorResponse` would reintroduce the import this exists to avoid.
 */
export function isStatus(err: unknown, status: number): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: unknown }).status === status;
}
