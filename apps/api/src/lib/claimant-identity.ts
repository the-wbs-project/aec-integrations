/**
 * Claimant identity resolution (AECI-527 / `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §2).
 *
 * A `vendor_requests` claim row carries `submitter_email` ONLY — the claim form is
 * anonymous, so there is no auth-user id to link. Before AECI-519 can grant a
 * verified vendor account it needs that email resolved to a Supabase
 * `auth.users` identity, because the D1 `profiles` row is keyed (by convention,
 * with no cross-system FK — AECI-254) to `auth.users.id` = the JWT `sub`.
 *
 * This module composes the GoTrue identity seams (#4a/#4b, `lib/supabase-admin.ts`)
 * with one D1 `profiles` read into the contract the grant consumes. It is the
 * ONLY place that knows both systems: `supabase-admin.ts` stays a pure HTTP
 * client with no DB dependency, and the grant handler stays a batch builder.
 *
 * SIDE-EFFECT PROFILE: reads only, EXCEPT the account create on the `invited`
 * path — so this must not be called from a read-only surface (the admin claim
 * queue uses `fetchAuthAccountsByEmail` for its signal instead). The resolution
 * order — lookup → create-if-absent → profile read → classify — guarantees a
 * create is never spent on a claim that a conflict then rejects, because a
 * conflict is only possible when an auth user already exists.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles } from '../db/schema';
import type { Env } from '../env';
import { createAuthUser, findAuthUserByEmail } from './supabase-admin';

/** The `profiles` columns exclusivity needs, plus what AECI-519's audit wants. */
export interface ClaimantProfileSnapshot {
  id: string;
  role: string;
  vendorId: string | null;
  /** Surfaced so AECI-519 can decide about granting a seat to a banned account
   *  (§7 / AECI-524 owns ban policy). NOT treated as a conflict here. */
  bannedAt: string | null;
}

/** Role/vendor exclusivity verdicts (`docs/STAGE_2_SPEC.md` §8.3(3)). */
export type ClaimantConflict = 'already_admin' | 'other_vendor';

export interface ClaimantResolutionInput {
  /** `vendor_requests.submitter_email`, verbatim — normalized inside the seams. */
  email: string;
  /**
   * The VENDOR being claimed. For a `target_type='product'` claim, AECI-519 must
   * resolve the product's vendor BEFORE calling — passing a product id here
   * compares against a value `profiles.vendor_id` can never hold, so exclusivity
   * would silently never conflict.
   */
  vendorId: string;
}

/**
 * The contract AECI-519's grant switches on. A discriminated union rather than
 * thrown errors: this is a `lib/` seam, so HTTP mapping belongs to the route
 * (§2 pins the intended mapping — `conflict` → 409, `unavailable`/`error` → 503
 * `DEPENDENCY_FAILURE`).
 */
export type ClaimantResolution =
  /** An auth user already owned this email; link its id. `profile` is its current
   *  D1 row, or `null` when the account has never signed in. */
  | {
      outcome: 'linked';
      userId: string;
      email: string;
      profile: ClaimantProfileSnapshot | null;
    }
  /** No auth user existed, so one was provisioned. Onboarding comms are the
   *  `claim-approved` email (AECI-528) — see `createAuthUser` for why no GoTrue
   *  invite email is sent. A re-run for the same email returns `linked`. */
  | { outcome: 'invited'; userId: string; email: string; profile: null }
  /** An explicit exclusivity error, never a silent overwrite (§2). Nothing was
   *  created and nothing was written. */
  | {
      outcome: 'conflict';
      reason: ClaimantConflict;
      userId: string;
      email: string;
      profile: ClaimantProfileSnapshot;
    }
  /** Supabase admin creds are absent (local `wrangler dev`, PR previews).
   *  Resolution is IMPOSSIBLE here, not negative — the grant must refuse rather
   *  than half-grant. */
  | { outcome: 'unavailable' }
  /** GoTrue was reachable but errored. */
  | { outcome: 'error'; stage: 'lookup' | 'create'; status?: number; message?: string };

/**
 * `role`/`vendor_id` are single-valued (§2 / `docs/STAGE_2_SPEC.md` §8.3(3)):
 *  - `admin` → never granted `vendor_admin`, whatever its `vendor_id`.
 *  - any non-null `vendor_id` pointing elsewhere → one vendor per account at
 *    launch (a `vendors.parent_company` multi-vendor admin uses separate
 *    accounts).
 *  - the SAME vendor → NOT a conflict. A second seat is the expected case;
 *    multi-seat is schema-native (no uniqueness on `profiles.vendor_id`).
 *
 * Pure, so the rule is testable without the D1 harness and reusable by a future
 * revoke path (§7) that already holds the row.
 */
export function classifyClaimantConflict(
  profile: ClaimantProfileSnapshot | null,
  vendorId: string,
): ClaimantConflict | null {
  if (!profile) return null;
  if (profile.role === 'admin') return 'already_admin';
  if (profile.vendorId !== null && profile.vendorId !== vendorId) return 'other_vendor';
  return null;
}

async function readProfileSnapshot(
  db: Db,
  userId: string,
): Promise<ClaimantProfileSnapshot | null> {
  const row = await db.query.profiles.findFirst({
    columns: { id: true, role: true, vendorId: true, bannedAt: true },
    where: eq(profiles.id, userId),
  });
  return row ?? null;
}

/**
 * Resolve a claim's `submitter_email` to the auth-user id AECI-519 links, or
 * provision one. Never throws — every failure mode is an `outcome`.
 *
 * The GoTrue seams are injected as trailing optional params (the house DI shape,
 * cf. `routes/account.ts` `deleteAuthUser`) so the contract is unit-testable with
 * no `fetch` and no live Supabase.
 */
export async function resolveClaimantIdentity(
  db: Db,
  env: Env,
  input: ClaimantResolutionInput,
  findUser: typeof findAuthUserByEmail = findAuthUserByEmail,
  createUser: typeof createAuthUser = createAuthUser,
): Promise<ClaimantResolution> {
  const found = await findUser(env, input.email);
  if (found.skipped) return { outcome: 'unavailable' };
  if (!found.ok) {
    return { outcome: 'error', stage: 'lookup', status: found.status, message: found.error };
  }

  let user = found.user;
  let invited = false;

  if (!user) {
    const created = await createUser(env, input.email);
    if (created.skipped) return { outcome: 'unavailable' };

    if (created.alreadyExists) {
      // GoTrue says a user owns this email but the substring `?filter=` lookup
      // missed it — a concurrent create, or a row the case-sensitive LIKE can't
      // reach. Re-resolve ONCE. A second miss is surfaced as an explicit error
      // so a reviewer links by hand: §2 mandates explicit errors, never a silent
      // overwrite of somebody else's account.
      const retry = await findUser(env, input.email);
      if (!retry.ok || !retry.user) {
        return {
          outcome: 'error',
          stage: 'create',
          status: created.status,
          message: 'email_exists but the user could not be resolved by email',
        };
      }
      user = retry.user;
    } else if (!created.ok || !created.user) {
      return { outcome: 'error', stage: 'create', status: created.status, message: created.error };
    } else {
      user = created.user;
      invited = true;
    }
  }

  const profile = await readProfileSnapshot(db, user.id);
  const reason = classifyClaimantConflict(profile, input.vendorId);
  if (reason && profile) {
    // Carry the snapshot so AECI-519 can record the before-state in its audit
    // metadata without a second D1 read.
    return { outcome: 'conflict', reason, userId: user.id, email: user.email, profile };
  }

  return invited
    ? { outcome: 'invited', userId: user.id, email: user.email, profile: null }
    : { outcome: 'linked', userId: user.id, email: user.email, profile };
}
