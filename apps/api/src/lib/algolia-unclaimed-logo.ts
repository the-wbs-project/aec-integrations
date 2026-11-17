/**
 * The reader behind the `algolia_unclaimed_logo` data-quality check (AECI-1867).
 *
 * Search shows a logo only while a listing is claimed (AECI-1618, DESIGN.md §5
 * "Unclaimed note", counsel's ruling 9). Both record builders null `logo_url` for an
 * unclaimed listing, but the nightly sync only re-pushes rows whose `updated_at`
 * moved, so a record indexed before a rule change keeps whatever it held. `/search`
 * trusts the record (`claimStatus='server-filtered'`), so a stale record shows an
 * unclaimed logo off its own page. The check reads the records of every unclaimed
 * listing and reports any that still carry a logo.
 *
 * One getObjects request per {@link GET_OBJECTS_MAX} ids, run one after another, so
 * the check holds at most one connection at a time. Every response body is read.
 *
 * The repair is a watermark reset for the entity (`docs/SEARCH_RANKING.md` §1.2), not
 * a code change.
 */

import { indexNamesFor, type AlgoliaEnv } from '@aeci/shared/algolia';

import type { Env } from '../env';
import { algoliaEnvFor } from './algolia-drift-deps';

/** Algolia's getObjects limit per request. */
export const GET_OBJECTS_MAX = 1000;

export type LogoEntity = 'products' | 'vendors';

/** One record's `logo_url` as the index holds it. */
export interface IndexedLogo {
  objectID: string;
  logoUrl: string | null;
}

/** Reads the `logo_url` of the given records. Ids with no record are left out. */
export interface AlgoliaLogoReader {
  indexName(entity: LogoEntity): string;
  logos(entity: LogoEntity, ids: readonly string[]): Promise<IndexedLogo[]>;
}

/** Fetch-based reader over the getObjects endpoint (`POST /1/indexes/*\/objects`). */
export function createAlgoliaLogoReader(
  appId: string,
  apiKey: string,
  env: AlgoliaEnv,
  fetchImpl: typeof fetch = fetch,
): AlgoliaLogoReader {
  const names = indexNamesFor(env);
  return {
    indexName: (entity) => names[entity],
    async logos(entity, ids) {
      const out: IndexedLogo[] = [];
      for (let i = 0; i < ids.length; i += GET_OBJECTS_MAX) {
        const requests = ids.slice(i, i + GET_OBJECTS_MAX).map((objectID) => ({
          indexName: names[entity],
          objectID,
          attributesToRetrieve: ['logo_url'],
        }));
        const res = await fetchImpl(`https://${appId}-dsn.algolia.net/1/indexes/*/objects`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Algolia-Application-Id': appId,
            'X-Algolia-API-Key': apiKey,
          },
          body: JSON.stringify({ requests }),
        });
        // Read the body on every path: an unread body holds one of the Worker's
        // six connections (ADR 0021).
        const text = await res.text();
        if (!res.ok) {
          throw new Error(
            `Algolia getObjects failed for index "${names[entity]}": HTTP ${res.status} — ${text.slice(0, 200)}`,
          );
        }
        const body = JSON.parse(text) as {
          results?: Array<{ objectID?: unknown; logo_url?: unknown } | null>;
        };
        for (const r of body.results ?? []) {
          if (!r || typeof r.objectID !== 'string') continue;
          out.push({
            objectID: r.objectID,
            logoUrl: typeof r.logo_url === 'string' && r.logo_url !== '' ? r.logo_url : null,
          });
        }
      }
      return out;
    },
  };
}

/**
 * The reader for `DataQualityDeps.unclaimedLogoReader`. No `ALGOLIA_APP_ID` /
 * `ALGOLIA_ADMIN_KEY` → `undefined`, which the check reads as skipped: the local
 * default, so a seeded database stays clean. The per-env management key carries the
 * `search` ACL that getObjects needs, as `createDriftRunner` relies on.
 */
export function createUnclaimedLogoReader(env: Env): AlgoliaLogoReader | undefined {
  if (!env.ALGOLIA_APP_ID || !env.ALGOLIA_ADMIN_KEY) return undefined;
  return createAlgoliaLogoReader(env.ALGOLIA_APP_ID, env.ALGOLIA_ADMIN_KEY, algoliaEnvFor(env));
}
