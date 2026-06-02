/**
 * Shared table-driven harness for the product / vendor / integration
 * detail-fetcher specs (AECI-113). `fetchProductBySlug`, `fetchVendorBySlug`,
 * and `fetchIntegrationById` are byte-for-byte parallel (the three specs
 * differed by ~9 lines): same `stubClient`, same five cases — happy path,
 * NOT_FOUND→null, rethrow non-NOT_FOUND, rethrow 404-with-other-code, and
 * path-param encoding. They differ only by fetcher, endpoint, the `slug`/`id`
 * param name, and the fixture body.
 *
 * Test helper, not a spec — `*.harness.ts` so no runner collects it directly
 * and the app build excludes it (`tsconfig.app.json`).
 */
import { expect, it, vi, describe } from 'vitest';

import { ServerApiError, type ServerApiClient } from '../../../server-api-client';

/** Mock `ServerApiClient` whose `request` is a spy over the supplied impl. */
export function stubClient(
  impl: (path: string, init?: RequestInit) => Promise<unknown>,
): ServerApiClient {
  return { request: vi.fn(impl) as ServerApiClient['request'] };
}

export interface DetailFetcherScenario {
  /** Describe-block / fetcher name, e.g. `fetchProductBySlug`. */
  describeName: string;
  /** The fetcher under test. */
  fetch: (client: ServerApiClient, param: string) => Promise<unknown>;
  /** Endpoint prefix, e.g. `/api/products`. */
  endpointBase: string;
  /** The lookup key (slug or id) used by the happy-path + error cases. */
  param: string;
  /** Drives the path-encoding case description + input (`slug` vs `id`). */
  paramKind: 'slug' | 'id';
  /** The 2xx response body; returned verbatim (fetchers do not Zod-parse). */
  fixture: Record<string, unknown>;
}

/** Registers the five behavioural cases shared by every detail fetcher. */
export function registerDetailFetcherSuite(scenario: DetailFetcherScenario): void {
  const { describeName, fetch, endpointBase, param, paramKind, fixture } = scenario;

  describe(describeName, () => {
    it('returns the parsed detail for a 2xx response', async () => {
      const client = stubClient(async () => fixture as unknown);

      const result = await fetch(client, param);

      expect(result).toEqual(fixture);
      expect(client.request).toHaveBeenCalledWith(`${endpointBase}/${param}`);
    });

    it('returns null when the API replies with a NOT_FOUND envelope', async () => {
      const client = stubClient(async () => {
        throw new ServerApiError({
          status: 404,
          code: 'NOT_FOUND',
          message: 'not found: missing',
          traceId: 'trace-xyz',
        });
      });

      const result = await fetch(client, 'missing');

      expect(result).toBeNull();
    });

    it('rethrows non-NOT_FOUND ServerApiError (e.g. 500)', async () => {
      const err = new ServerApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'database unreachable',
      });
      const client = stubClient(async () => {
        throw err;
      });

      await expect(fetch(client, param)).rejects.toBe(err);
    });

    it('rethrows a 404 whose code is NOT NOT_FOUND (defensive: envelope contract)', async () => {
      // If the API ever returns a 404 with a different code (e.g. METHOD_NOT_ALLOWED
      // mis-applied), surface the error rather than silently swallowing it as a
      // missing entity. The shape contract from `apps/api` is that NOT_FOUND is
      // the only 404 code we should see for these endpoints.
      const err = new ServerApiError({
        status: 404,
        code: 'UNKNOWN',
        message: 'something else',
      });
      const client = stubClient(async () => {
        throw err;
      });

      await expect(fetch(client, param)).rejects.toBe(err);
    });

    it(`encodes the ${paramKind} into the URL path`, async () => {
      // Defensive: keys *should* be ASCII-safe (the slug generator at AECI-47
      // enforces this), but a leaked stray character must not produce a
      // malformed path or accidental traversal.
      const client = stubClient(async () => ({}) as unknown);

      await fetch(client, `odd ${paramKind}/with chars`);

      expect(client.request).toHaveBeenCalledWith(
        `${endpointBase}/odd%20${paramKind}%2Fwith%20chars`,
      );
    });
  });
}
