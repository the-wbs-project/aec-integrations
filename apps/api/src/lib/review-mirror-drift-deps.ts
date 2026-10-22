/**
 * The production wiring for the `review_mirror_drift` data-quality check (AECI-1455).
 *
 * Shared by the daily cron (`scheduled.ts`) and `GET /api/admin/system?recompute=1`
 * (`admin-status.ts`), the same way `algolia-drift-deps.ts` serves `runDrift`. The check
 * reads its own skip conditions from `env`, so this always returns the deps.
 */

import type { Env } from '../env';
import type { ReviewMirrorDriftDeps } from './data-quality';
import { buildOwnershipRecordV2 } from './ownership-sync'; // AECI-1454 seam

export function createReviewMirrorDriftDeps(env: Env): ReviewMirrorDriftDeps {
  return {
    env,
    // The reason is informational and outside the hash, so any value hashes the same.
    buildRecord: (db, vendorId) => buildOwnershipRecordV2(db, vendorId, 'backfill'),
  };
}
