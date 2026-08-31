/**
 * D1 adapters for the Algolia index-drift check (`lib/algolia-drift.ts`).
 *
 * `algolia-drift` is deliberately ORM- and platform-agnostic — it takes an
 * injected `DriftCount` read surface and an injected `AlgoliaCountClient` so it
 * unit-tests with fakes and runs in both the Worker and Node. This module is the
 * only place that knows the counts come from Drizzle over D1.
 *
 * It exists as its own file because there are now **two** callers with the same
 * wiring: the 09:00 drift cron and the 04:00 data-quality suite (`scheduled.ts`),
 * and `GET /api/admin/overview?recompute=1` (AECI-574), which reports the same
 * drift on the §5.1 status strip. The counter takes a `Db` rather than an `Env`
 * precisely so the request path can pass the client it already has — and so
 * specs can pass the in-memory D1 harness.
 */

import type { AlgoliaEnv } from '@aeci/shared/algolia';
import { and, count, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, vendors } from '../db/schema';
import type { Env } from '../env';
import {
  createAlgoliaCounter,
  findAlgoliaIndexDrift,
  type AlgoliaIndexDrift,
  type DriftCount,
} from './algolia-drift';

/** Map the Worker `ENV` var to the Algolia env (unset → `development`, which
 *  folds onto the preview index set — same convention as `/api/version`). */
export function algoliaEnvFor(env: Env): AlgoliaEnv {
  return env.ENV ?? 'development';
}

/**
 * A Drizzle-backed `DriftCount` (the index-drift check's injected count
 * surface). Counts promoted products/vendors and integrations whose BOTH
 * endpoints are promoted — the same membership filter `algolia-sync` indexes on.
 */
export function drizzleDriftCounter(db: Db): DriftCount {
  return {
    product: {
      count: async ({ where }) =>
        (
          await db
            .select({ value: count() })
            .from(products)
            .where(eq(products.promotionStatus, where.promotionStatus))
        )[0]?.value ?? 0,
    },
    vendor: {
      count: async ({ where }) =>
        (
          await db
            .select({ value: count() })
            .from(vendors)
            .where(eq(vendors.promotionStatus, where.promotionStatus))
        )[0]?.value ?? 0,
    },
    integration: {
      // Counts BOTH tables behind the `integrations` index (AECI-721 / §13.5, an
      // unnamed 14th lockstep site). This is a LIVE ALARM SURFACE, which is why it
      // ships in PR-A rather than with the migration: it compares D1 to Algolia,
      // so between PR-B's migration and the full reindex the two are legitimately
      // in flux, and a counter that knew about only one table would report drift
      // that is an artifact of its own definition.
      //
      // The membership rule must stay byte-for-byte the rule `buildIntegrationRequests`
      // applies in `algolia-sync.ts` — both endpoints promoted, connector not
      // considered. Any divergence between the two IS the alarm this check raises.
      count: async ({ where }) => {
        const promoted = db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.promotionStatus, where.sourceProduct.promotionStatus));
        const [direct] = await db
          .select({ value: count() })
          .from(integrations)
          .where(
            and(
              inArray(integrations.sourceProductId, promoted),
              inArray(integrations.targetProductId, promoted),
            ),
          );
        const [evidenced] = await db
          .select({ value: count() })
          .from(connectorEvidencedPairs)
          .where(
            and(
              inArray(connectorEvidencedPairs.productAId, promoted),
              inArray(connectorEvidencedPairs.productBId, promoted),
            ),
          );
        return (direct?.value ?? 0) + (evidenced?.value ?? 0);
      },
    },
  };
}

/**
 * The drift closure both the data-quality suite (`DataQualityDeps.runDrift`) and
 * the admin panel's status strip consume.
 *
 * **Fail-safe by absence**: no `ALGOLIA_APP_ID` / `ALGOLIA_ADMIN_KEY` →
 * `undefined`, which `checkAlgoliaDrift` already reads as "skip this check, don't
 * error". That is the expected local `dev:bound` / PR-preview state.
 */
export function createDriftRunner(
  env: Env,
  db: Db,
): (() => Promise<AlgoliaIndexDrift[]>) | undefined {
  const appId = env.ALGOLIA_APP_ID;
  const adminKey = env.ALGOLIA_ADMIN_KEY;
  if (!appId || !adminKey) return undefined;
  return () =>
    findAlgoliaIndexDrift(
      { db: drizzleDriftCounter(db), algolia: createAlgoliaCounter(appId, adminKey) },
      { env: algoliaEnvFor(env) },
    );
}
