/**
 * `GET /api/admin/catalog/coverage` (AECI-579 / Phase 8.3 P1.5) — the §5.5
 * catalog readout. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.5/§6,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching (`json()` sets `private, no-store`).
 *
 * ─── What this endpoint is NOT ───────────────────────────────────────────────
 *
 * It is not the catalog's time series. §5.5's "counts over time" and "additions
 * per day" are served by `GET /api/admin/metrics/timeseries` with the `catalog.*`
 * metric keys, which already carries `catalog_series_is_additions_only` and
 * `catalog_series_starts_at`. Duplicating that here would put a second
 * implementation of the same number behind the same screen.
 *
 * It is also not an edit surface (§2). Every list is a starting point for work
 * done in the review app; promotion stays review-app → `POST /api/promote`.
 *
 * ─── No `window` ─────────────────────────────────────────────────────────────
 *
 * The three P1.1 endpoints aggregate over a UTC range. Coverage does not: "how
 * many products have no logo" is a fact about current state, and attaching a
 * window to it would be exactly the false precision §1.1 warns about. The rest of
 * the honesty envelope — `generated_at`, `source`, `notes` — carries over intact.
 *
 * ─── Three notes this endpoint owes its reader ───────────────────────────────
 *
 * **`funnel_is_promoted_cohort_only`** fires when every product reads
 * `promoted`, which §13 D6 says is D1's permanent state until a real un-promote
 * path exists. Without it a 171/0/0/0/0 funnel reads as a bug rather than as
 * "the pre-promotion stages live in the review app".
 *
 * **`trade_facet_sparse_by_design`** fires whenever the trade gap is non-zero.
 * `TRADES_VOCABULARY.md` §1.1 tags a product only when it has trade-*specific*
 * value, so a horizontal platform carrying no trade is correct. Presenting that
 * count as a backlog without the note would make the to-do list actively wrong.
 *
 * **`api_docs_flag_inconsistent`** fires when `has_api_docs` disagrees with
 * `api_docs_url`. The gap list keys off the URL (the thing an operator goes and
 * finds); the flag disagreeing with it is a separate, quieter defect that would
 * otherwise be invisible from either column alone.
 */

import {
  AdminCatalogCoverageQuerySchema,
  AdminCatalogCoverageResponseSchema,
  type AdminCatalogCoverageResponse,
  type AdminNote,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { note } from '../lib/admin-analytics';
import {
  catalogTotals,
  claimCoverage,
  coverageGaps,
  promotionFunnel,
  researchStatusDistribution,
  taxonomyUsage,
} from '../lib/admin-catalog';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-summary.ts`.
type AdminContext = Context<{ Bindings: Env }>;

export interface AdminCatalogCoverageDeps {
  now?: () => Date;
}

export function createAdminCatalogCoverageHandler(
  dbFor: DbFactory = getDb,
  deps: AdminCatalogCoverageDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminCatalogCoverageQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    const [totals, funnel, research, gapsResult, taxonomy, claims] = await Promise.all([
      catalogTotals(db),
      promotionFunnel(db),
      researchStatusDistribution(db),
      coverageGaps(db, query.sample),
      taxonomyUsage(db),
      claimCoverage(db, query.sample),
    ]);

    const notes: AdminNote[] = [];

    if (funnel.promoted_cohort_only) {
      notes.push(
        note(
          'funnel_is_promoted_cohort_only',
          `All ${funnel.total} product(s) in this database read promotion_status='promoted'. Promote is the only insert path and retraction hard-deletes, so the pending/ready/retracted/rejected stages live in the review app, not here.`,
          { promoted: funnel.total },
        ),
      );
    }

    const tradeGap = gapsResult.gaps.find((g) => g.key === 'products_without_trade');
    if (tradeGap && tradeGap.total > 0) {
      notes.push(
        note(
          'trade_facet_sparse_by_design',
          `${tradeGap.total} of ${tradeGap.universe} product(s) carry no trade tag. The trade facet is sparse by design — a product is tagged only when it has trade-specific value, so horizontal platforms correctly carry none. Treat this as coverage information, not a backlog.`,
          { untagged: tradeGap.total, universe: tradeGap.universe },
        ),
      );
    }

    if (gapsResult.apiDocsFlagInconsistent > 0) {
      notes.push(
        note(
          'api_docs_flag_inconsistent',
          `${gapsResult.apiDocsFlagInconsistent} product(s) have has_api_docs set but no api_docs_url. The gap list counts the missing URL; this is the flag disagreeing with it.`,
          { rows: gapsResult.apiDocsFlagInconsistent },
        ),
      );
    }

    const body: AdminCatalogCoverageResponse = {
      generated_at: now.toISOString(),
      source: 'live',
      notes,
      sample_limit: query.sample,
      totals,
      funnel,
      research_status: research,
      gaps: gapsResult.gaps,
      taxonomy,
      claim_coverage: claims,
    };

    validateResponseInDev(c.env, () => {
      AdminCatalogCoverageResponseSchema.parse(body);
    });

    return json(body);
  };
}
