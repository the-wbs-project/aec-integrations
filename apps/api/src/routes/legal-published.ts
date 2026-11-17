/**
 * `GET /api/legal/published` (AECI-1689, `docs/API_CONTRACTS.md` §6.10 "Legal versions",
 * `STAGE_1_SPEC.md` §27.3). Public and unauthenticated. A read, so no rate limit
 * (`docs/waf-rate-limits.md` §6) and no audit row.
 *
 * The legal pages have no D1. For the Vendor Terms, the Managed plan agreement and, since
 * AECI-1637, the Terms of Service and the Privacy Policy, an upcoming version is in force
 * from its moment only when it was published (`legalAgreementVersionInForce` /
 * `legalReaderVersionInForce` in `@aeci/shared`). The SSR Worker asks here, over the
 * service binding, once that moment has come; the browser asks on an in-app navigation.
 *
 * It lists only a `legal_versions` row that names an upcoming version in this build's
 * map AND whose effective moment has come. So it says nothing the legal page does not
 * say itself from that moment, and nothing about a version still to come. `now` is this
 * Worker's clock: a browser decides with it, never with its own.
 *
 * `Cache-Control: no-store` (the `json()` default): `now` must be fresh. No query runs
 * unless an upcoming publishable document's moment has come (`loadLegalPublishedLite`),
 * so with today's empty maps the read never touches D1.
 */

import {
  LEGAL_IN_FORCE_MAPS,
  legalPublishableUpcoming,
  LegalPublishedResponseSchema,
  legalEffectiveAtMs,
  legalMomentReached,
  type LegalInForceMaps,
  type LegalPublishedResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { loadLegalPublishedLite } from '../lib/legal-in-force';

export interface LegalPublishedDeps {
  now?: () => Date;
  /** The upcoming maps. Injected so specs need not edit the shared constants. */
  maps?: LegalInForceMaps;
}

export function createLegalPublishedHandler(
  dbFor: DbFactory = getDb,
  deps: LegalPublishedDeps = {},
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  const maps = deps.maps ?? LEGAL_IN_FORCE_MAPS;
  return async (c) => {
    const now = (deps.now ?? (() => new Date()))();
    const nowMs = now.getTime();
    const rows = await loadLegalPublishedLite(dbFor(c.env).db, nowMs, maps);
    const published: LegalPublishedResponse['published'] = [];
    for (const { document, upcoming } of legalPublishableUpcoming(maps)) {
      const row = rows.find((r) => r.document === document && r.version === upcoming.version);
      if (!row || !legalMomentReached(row.effectiveAt, nowMs)) continue;
      // The manifest moment, the one the rule compares a row against.
      if (row.effectiveAt !== legalEffectiveAtMs(upcoming.effectiveOn)) continue;
      published.push({
        document,
        version: row.version,
        effective_at: new Date(row.effectiveAt).toISOString(),
      });
    }
    const body: LegalPublishedResponse = { now: now.toISOString(), published };
    validateResponseInDev(c.env, () => {
      LegalPublishedResponseSchema.parse(body);
    });
    return json(body);
  };
}
