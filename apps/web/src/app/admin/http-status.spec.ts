import { describe, expect, it } from 'vitest';

import { isStatus } from './http-status';

/**
 * Plain vitest, NOT `*.component.spec.ts`: this module touches no `TestBed` and
 * no DI, and the two runners partition on that suffix — `vitest.config.ts`
 * EXCLUDES `*.component.spec.ts` and `ng test` includes ONLY it. A file on the
 * wrong side of that line runs under neither and passes silently.
 */
describe('isStatus', () => {
  it('matches a plain object carrying the status — the lazy-chunk case', () => {
    // The reason this is structural: an HttpErrorResponse built in one lazily
    // loaded admin chunk and caught in another can fail `instanceof`.
    expect(isStatus({ status: 404 }, 404)).toBe(true);
    expect(isStatus({ status: 404, message: 'Not Found' }, 404)).toBe(true);
  });

  it('does not match a different status', () => {
    expect(isStatus({ status: 403 }, 404)).toBe(false);
  });

  it('is strict about the type — "404" is not 404', () => {
    // A loose `==` here would make a string status from a hand-rolled fake
    // silently match, which is how a test starts passing for the wrong reason.
    expect(isStatus({ status: '404' }, 404)).toBe(false);
  });

  it('survives the values a catch block actually sees', () => {
    expect(isStatus(null, 404)).toBe(false);
    expect(isStatus(undefined, 404)).toBe(false);
    expect(isStatus(new Error('boom'), 404)).toBe(false);
    expect(isStatus('404', 404)).toBe(false);
    expect(isStatus({}, 404)).toBe(false);
  });
});
