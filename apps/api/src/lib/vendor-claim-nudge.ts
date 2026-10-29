/**
 * The vendor claim nudge (AECI-1305 / `docs/ACCOUNT_ONBOARDING_SPEC.md` §1.1).
 *
 * A person who told "About you" they work at an AEC software company
 * (`profile_details.company_type = 'software_vendor'`) and who holds no claim gets one
 * marketing email, `vendor-claim-nudge`, pointing at `/vendor-program`. It replaced the
 * in-form "Claim your listing" note that the 2026-10-13 /welcome audit removed.
 *
 * Run by the daily 15:00 UTC `vendor_claim_nudge` cron, queue-backed on
 * `ATTESTATION_NOTIFY_QUEUE`.
 *
 * ── WHO IS A CANDIDATE (one SQL read) ───────────────────────────────────────────
 * A `reviewer` profile with no `vendor_id`, not banned, answered `software_vendor`,
 * created {@link NUDGE_AFTER_DAYS} to {@link NUDGE_WINDOW_DAYS} days ago, not opted out
 * of marketing email, and with no ledger row under its key. The role test excludes
 * seats (`vendor_admin`) and admins. Oldest first, at most {@link NUDGE_SCAN_CAP}.
 *
 * Why 365 days: `notification_sends` rows are pruned after 400 days. A send happens at
 * day 3 or later, so its key outlives the window and the dedupe stays exact. The first
 * runs reach every existing account, because the site is younger than a year.
 *
 * ── WHO IS SKIPPED (after the address lookup) ───────────────────────────────────
 * Claims, listing requests, confirmations and invites are keyed by address, not by
 * profile, so these checks run on the `auth.users` email, compared lowercased:
 *
 *   - any `vendor_requests` claim from the address, whatever its status;
 *   - an open `listing_requests` row;
 *   - an unconfirmed, unexpired `request_confirmations` row (a claim or listing link
 *     nobody has clicked yet);
 *   - a pending `vendor_seat_invites` row: not accepted, not revoked, not expired;
 *   - a `mailing_list` row the address unsubscribed (ruling 2026-10-29: a mailing-list
 *     unsubscribe also stops this email).
 *
 * A skipped account writes nothing, so it is a candidate again tomorrow. That is
 * deliberate: a claim that is rejected later still skips (any status), and an invite
 * that expires unaccepted makes the account eligible again.
 *
 * ── HOW MUCH PER RUN ────────────────────────────────────────────────────────────
 * Candidates are looked up in chunks of {@link LOOKUP_CHUNK}, so a run stops paying for
 * GoTrue reads (one GET per profile) once it has {@link NUDGE_SEND_CAP} accounts to
 * send to. The backlog of existing accounts drains over a few days.
 *
 * ── WRITES ──────────────────────────────────────────────────────────────────────
 * Before sending, `ensureMarketingPreferences` creates the `notification_preferences`
 * row and mints the marketing token, each with its audit row in the same batch. The
 * entries are returned for the post-commit forward. The send writes only the ledger,
 * which is log-class (ADR 0022). Throws only on a D1 error, before any send, so a queue
 * retry starts clean, and the ledger key stops a second send of any that went out.
 */

import type { AuditLogEntry } from '@aeci/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import {
  listingRequests,
  mailingList,
  notificationPreferences,
  notificationSends,
  profileDetails,
  profiles,
  requestConfirmations,
  vendorRequests,
  vendorSeatInvites,
} from '../db/schema';
import { sendVendorClaimNudgeEmail, type EmailContext, type EmailOutcome } from './email';
import { ensureMarketingPreferences, isMarketingMuted } from './notification-preferences';
import { fetchAuthUserEmails } from './supabase-admin';
import type { FetchSeatEmails } from './vendor-seat-recipients';

const DAY_MS = 86_400_000;

/** No email on the day of sign-up: an account becomes a candidate this many days in. */
export const NUDGE_AFTER_DAYS = 3;

/** Accounts older than this are never scanned. Must stay under the 400-day ledger prune. */
export const NUDGE_WINDOW_DAYS = 365;

/** Most candidates one run reads from SQL. */
export const NUDGE_SCAN_CAP = 500;

/** Most emails one run sends. The next run continues. */
export const NUDGE_SEND_CAP = 50;

/** Candidates per address lookup. Also the D1 bound-parameter chunk. */
const LOOKUP_CHUNK = 50;

/** The `company_type` this email is for (`ACCOUNT_ONBOARDING_SPEC.md` §1). */
export const NUDGE_COMPANY_TYPE = 'software_vendor';

const NUDGE_KEY_PREFIX = 'vendor-claim-nudge:';

/** The per-account send-ledger key. */
export const vendorClaimNudgeKey = (profileId: string) => `${NUDGE_KEY_PREFIX}${profileId}`;

export interface VendorClaimNudgeDeps {
  fetchEmails?: FetchSeatEmails;
  sendEmail?: typeof sendVendorClaimNudgeEmail;
  now?: Date;
}

/** Why an account was skipped after the address lookup. */
export type NudgeSkipReason =
  | 'no_address'
  | 'claim'
  | 'listing_request'
  | 'pending_confirmation'
  | 'pending_invite'
  | 'mailing_list_unsubscribed'
  | 'marketing_muted';

export interface VendorClaimNudgeResult {
  /** Candidates the SQL read returned (at most {@link NUDGE_SCAN_CAP}). */
  candidates: number;
  /** Candidates whose address was looked up. The rest wait for a later run. */
  scanned: number;
  /** Skipped accounts, by reason. */
  skipped: Record<NudgeSkipReason, number>;
  /** Send outcomes. A held key counts as `duplicate`. */
  emails: Record<EmailOutcome, number>;
  /** The preference rows' audit entries, for the post-commit forward. */
  auditEntries: AuditLogEntry[];
}

const emptyOutcomes = (): Record<EmailOutcome, number> => ({
  sent: 0,
  failed: 0,
  unknown: 0,
  skipped: 0,
  suppressed: 0,
  duplicate: 0,
  paused: 0,
});

const emptySkips = (): Record<NudgeSkipReason, number> => ({
  no_address: 0,
  claim: 0,
  listing_request: 0,
  pending_confirmation: 0,
  pending_invite: 0,
  mailing_list_unsubscribed: 0,
  marketing_muted: 0,
});

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run one nudge pass. */
export async function runVendorClaimNudgeSweep(
  c: EmailContext,
  db: Db,
  deps: VendorClaimNudgeDeps = {},
): Promise<VendorClaimNudgeResult> {
  const send = deps.sendEmail ?? sendVendorClaimNudgeEmail;
  const fetchEmails = deps.fetchEmails ?? fetchAuthUserEmails;
  const now = deps.now ?? new Date();
  const candidates = await loadCandidates(db, now);

  const result: VendorClaimNudgeResult = {
    candidates: candidates.length,
    scanned: 0,
    skipped: emptySkips(),
    emails: emptyOutcomes(),
    auditEntries: [],
  };

  const eligible: Array<{ profileId: string; email: string }> = [];
  for (const ids of chunk(candidates, LOOKUP_CHUNK)) {
    if (eligible.length >= NUDGE_SEND_CAP) break;
    result.scanned += ids.length;
    const emails = await fetchEmails(c.env, ids);
    const withAddress: Array<{ profileId: string; email: string }> = [];
    for (const profileId of ids) {
      const email = emails.get(profileId)?.trim().toLowerCase();
      if (email) withAddress.push({ profileId, email });
      else result.skipped.no_address++;
    }
    const blocked = await loadBlockedAddresses(
      db,
      withAddress.map((r) => r.email),
      now,
    );
    for (const row of withAddress) {
      const reason = blocked.get(row.email);
      if (reason) {
        result.skipped[reason]++;
        continue;
      }
      if (eligible.length < NUDGE_SEND_CAP) eligible.push(row);
    }
  }
  if (eligible.length === 0) return result;

  const { prefs, entries } = await ensureMarketingPreferences(
    db,
    eligible.map((r) => r.profileId),
    'vendor-claim-nudge',
    now,
  );
  result.auditEntries = entries;

  // One connection at a time: sequential sends, at most NUDGE_SEND_CAP.
  for (const row of eligible) {
    const pref = prefs.get(row.profileId);
    // Opted out between the candidate read and now.
    if (isMarketingMuted(pref)) {
      result.skipped.marketing_muted++;
      continue;
    }
    const outcome = await send(c, {
      to: row.email,
      profileId: row.profileId,
      marketingMuteToken: pref?.marketingMuteToken ?? null,
      dedupeKey: vendorClaimNudgeKey(row.profileId),
    });
    result.emails[outcome]++;
  }
  return result;
}

/** The SQL half of eligibility, oldest account first. */
async function loadCandidates(db: Db, now: Date): Promise<string[]> {
  // ISO-8601 TEXT compares lexically, so the bounds are strings.
  const createdBy = new Date(now.getTime() - NUDGE_AFTER_DAYS * DAY_MS).toISOString();
  const createdAfter = new Date(now.getTime() - NUDGE_WINDOW_DAYS * DAY_MS).toISOString();
  const rows = await db
    .select({ id: profiles.id })
    .from(profiles)
    .innerJoin(profileDetails, eq(profileDetails.profileId, profiles.id))
    .where(
      and(
        eq(profileDetails.companyType, NUDGE_COMPANY_TYPE),
        eq(profiles.role, 'reviewer'),
        isNull(profiles.vendorId),
        isNull(profiles.bannedAt),
        lte(profiles.createdAt, createdBy),
        gt(profiles.createdAt, createdAfter),
        sql`not exists (select 1 from ${notificationPreferences} where ${notificationPreferences.profileId} = ${profiles.id} and ${notificationPreferences.marketingMutedAt} is not null)`,
        sql`not exists (select 1 from ${notificationSends} where ${notificationSends.dedupeKey} = ${NUDGE_KEY_PREFIX} || ${profiles.id})`,
      ),
    )
    .orderBy(asc(profiles.createdAt), asc(profiles.id))
    .limit(NUDGE_SCAN_CAP);
  return rows.map((r) => r.id);
}

/**
 * The addresses in `emails` that must not get the nudge, each with the first reason
 * that applies. `emails` are lowercased. Stored addresses are lowercased on write, but
 * the comparison lowercases them again, so an older mixed-case row still matches.
 */
async function loadBlockedAddresses(
  db: Db,
  emails: readonly string[],
  now: Date,
): Promise<Map<string, NudgeSkipReason>> {
  const blocked = new Map<string, NudgeSkipReason>();
  if (emails.length === 0) return blocked;
  const nowIso = now.toISOString();
  const lower = (col: SQLiteColumn) => sql<string>`lower(${col})`;
  const mark = (rows: Array<{ email: string }>, reason: NudgeSkipReason) => {
    for (const { email } of rows) {
      const key = email.toLowerCase();
      if (!blocked.has(key)) blocked.set(key, reason);
    }
  };

  const claims = await db
    .select({ email: vendorRequests.submitterEmail })
    .from(vendorRequests)
    .where(
      and(
        eq(vendorRequests.kind, 'claim'),
        inArray(lower(vendorRequests.submitterEmail), [...emails]),
      ),
    );
  mark(claims, 'claim');

  const listings = await db
    .select({ email: listingRequests.submitterEmail })
    .from(listingRequests)
    .where(
      and(
        eq(listingRequests.status, 'open'),
        inArray(lower(listingRequests.submitterEmail), [...emails]),
      ),
    );
  mark(listings, 'listing_request');

  const confirmations = await db
    .select({ email: requestConfirmations.submitterEmail })
    .from(requestConfirmations)
    .where(
      and(
        isNull(requestConfirmations.confirmedAt),
        gt(requestConfirmations.expiresAt, nowIso),
        inArray(lower(requestConfirmations.submitterEmail), [...emails]),
      ),
    );
  mark(confirmations, 'pending_confirmation');

  const invites = await db
    .select({ email: vendorSeatInvites.email })
    .from(vendorSeatInvites)
    .where(
      and(
        isNull(vendorSeatInvites.acceptedAt),
        isNull(vendorSeatInvites.revokedAt),
        gt(vendorSeatInvites.expiresAt, nowIso),
        inArray(lower(vendorSeatInvites.email), [...emails]),
      ),
    );
  mark(invites, 'pending_invite');

  const unsubscribed = await db
    .select({ email: mailingList.email })
    .from(mailingList)
    .where(
      and(isNotNull(mailingList.unsubscribedAt), inArray(lower(mailingList.email), [...emails])),
    );
  mark(unsubscribed, 'mailing_list_unsubscribed');

  return blocked;
}
