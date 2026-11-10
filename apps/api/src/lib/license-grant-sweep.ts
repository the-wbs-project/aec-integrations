/**
 * The daily license-grant sweep (AECI-1615; `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 5).
 * The fourth step of the 11:00 UTC `entitlement_expiry` job, in its own catch, after the
 * unassigned-license reminder. Queue-less like the rest of that job: a queue retry would
 * re-send email.
 *
 * Three passes over `license_grants` rows still `pending_acceptance`:
 *
 *  1. **Expire.** A grant whose `ends_at` is not after now becomes `expired`: a guarded
 *     UPDATE, `changedOneRowSentinel` and its `license_grant.expired` audit row in one
 *     batch per grant (a scheduled UPDATE is never audit-exempt). A grant accepted or
 *     withdrawn since the read trips the sentinel and writes nothing.
 *  2. **Catch-up.** A grant under {@link REMINDER_AFTER_DAYS} days old sends
 *     `license-grant-pending` to every unbanned owner seat. The create already sent it, so
 *     the send ledger key `license-grant-pending:{grantId}:{profileId}` makes this a
 *     no-op except for an owner who had no send: a vendor with no seat at grant time
 *     (AECI-1589 still allows that), or a send that failed.
 *  3. **Reminder.** A grant {@link REMINDER_AFTER_DAYS} or more days old sends
 *     `license-grant-pending-reminder` once per owner seat (ruling R4), keyed
 *     `license-grant-pending-reminder:{grantId}:{profileId}`. It replaces the catch-up
 *     from day 7, so a late owner gets one prompt, not two.
 *
 * Throws only on a D1 read error, which the cron shell records as a failed run. A
 * failed expiry batch is counted and retried tomorrow.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, gt, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { licenseGrants, vendors } from '../db/schema';
import { logToPosthog } from '../posthog';
import {
  sendLicenseGrantPendingEmail,
  sendLicenseGrantPendingReminderEmail,
  type EmailContext,
  type EmailOutcome,
} from './email';
import {
  closeLicenseGrantStatements,
  licenseGrantPendingKey,
  licenseGrantReminderKey,
  PENDING,
  type LicenseGrantRow,
} from './license-grants';
import { isReleaseRaceError } from './license-release-requests';
import { forwardAuditBatch } from './moderation-forward';
import type { BatchTuple } from './audit';
import { loadVendorOwnerRecipients, type FetchSeatEmails } from './vendor-seat-recipients';

const DAY_MS = 86_400_000;

/** How old a pending grant is when the one reminder goes (ruling R4). */
export const REMINDER_AFTER_DAYS = 7;

/** Most grants each pass handles in one run. The next run continues. */
export const LICENSE_GRANT_SWEEP_CAP = 100;

/** `metadata.source` on the expiry audit rows. */
export const LICENSE_GRANT_SWEEP_SOURCE = 'license-grant-sweep';

export interface LicenseGrantSweepDeps {
  fetchSeatEmails?: FetchSeatEmails;
  sendPending?: typeof sendLicenseGrantPendingEmail;
  sendReminder?: typeof sendLicenseGrantPendingReminderEmail;
  now?: Date;
}

export interface LicenseGrantSweepResult {
  /** Grants this run moved to `expired`. */
  expired: number;
  /** Expiry batches that lost a race (accepted or withdrawn since the read). */
  raced: number;
  /** Expiry batches that failed for another reason. Retried tomorrow. */
  batchFailures: number;
  /** Pending grants under 7 days old, and 7 or more days old, this run looked at. */
  young: number;
  old: number;
  /** Grants left for the next run by {@link LICENSE_GRANT_SWEEP_CAP}. */
  capped: number;
  /** Per-owner send outcomes. A held key counts as `duplicate`. */
  pending: Record<EmailOutcome, number>;
  reminder: Record<EmailOutcome, number>;
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

/** Run one sweep pass. */
export async function runLicenseGrantSweep(
  c: EmailContext,
  db: Db,
  deps: LicenseGrantSweepDeps = {},
): Promise<LicenseGrantSweepResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  const sendPending = deps.sendPending ?? sendLicenseGrantPendingEmail;
  const sendReminder = deps.sendReminder ?? sendLicenseGrantPendingReminderEmail;
  const result: LicenseGrantSweepResult = {
    expired: 0,
    raced: 0,
    batchFailures: 0,
    young: 0,
    old: 0,
    capped: 0,
    pending: emptyOutcomes(),
    reminder: emptyOutcomes(),
  };

  // 1. Expire. ISO-8601 TEXT compares lexically; every writer stores the one spelling.
  const due = await db
    .select()
    .from(licenseGrants)
    .where(and(eq(licenseGrants.status, PENDING), lte(licenseGrants.endsAt, nowIso)))
    .orderBy(asc(licenseGrants.endsAt), asc(licenseGrants.id))
    .limit(LICENSE_GRANT_SWEEP_CAP + 1);
  const audits: AuditLogEntry[] = [];
  for (const grant of due.slice(0, LICENSE_GRANT_SWEEP_CAP)) {
    const batch = closeLicenseGrantStatements(db, {
      grant,
      status: 'expired',
      now: nowIso,
      actorId: null,
      actorType: 'system',
      vendorPlan: null,
      auditSource: LICENSE_GRANT_SWEEP_SOURCE,
    });
    try {
      await db.batch(batch.stmts as BatchTuple);
      audits.push(batch.auditEntry);
      result.expired++;
    } catch (error) {
      if (isReleaseRaceError(error)) {
        result.raced++;
        continue;
      }
      result.batchFailures++;
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'error',
        message: 'aeci.license_grant.expire_failed',
        source: LICENSE_GRANT_SWEEP_SOURCE,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (due.length > LICENSE_GRANT_SWEEP_CAP) result.capped += due.length - LICENSE_GRANT_SWEEP_CAP;
  // §26.5 forward: every committed row in ONE request.
  if (audits.length > 0) forwardAuditBatch(c, audits, [], LICENSE_GRANT_SWEEP_SOURCE);

  // 2 and 3. The prompts, on grants still pending and not past their end.
  const reminderBy = new Date(now.getTime() - REMINDER_AFTER_DAYS * DAY_MS).toISOString();
  const open = await db
    .select({ grant: licenseGrants, vendorName: vendors.companyName, vendorSlug: vendors.slug })
    .from(licenseGrants)
    .innerJoin(vendors, eq(vendors.id, licenseGrants.vendorId))
    .where(and(eq(licenseGrants.status, PENDING), gt(licenseGrants.endsAt, nowIso)))
    .orderBy(asc(licenseGrants.createdAt), asc(licenseGrants.id))
    .limit(LICENSE_GRANT_SWEEP_CAP + 1);
  if (open.length > LICENSE_GRANT_SWEEP_CAP) {
    result.capped += open.length - LICENSE_GRANT_SWEEP_CAP;
  }

  for (const { grant, vendorName, vendorSlug } of open.slice(0, LICENSE_GRANT_SWEEP_CAP)) {
    const isOld = grant.createdAt <= reminderBy;
    if (isOld) result.old++;
    else result.young++;
    const owners = await loadVendorOwnerRecipients(db, c.env, grant.vendorId, deps.fetchSeatEmails);
    // One connection at a time: sequential sends (a handful of owners).
    for (const owner of owners) {
      const subject = grantSubject(grant, vendorName, vendorSlug, owner.email);
      if (isOld) {
        const outcome = await sendReminder(c, {
          ...subject,
          dedupeKey: licenseGrantReminderKey(grant.id, owner.profileId),
        });
        result.reminder[outcome]++;
      } else {
        const outcome = await sendPending(c, {
          ...subject,
          dedupeKey: licenseGrantPendingKey(grant.id, owner.profileId),
        });
        result.pending[outcome]++;
      }
    }
  }
  return result;
}

/** The email fields one grant gives, less the key. */
export function grantSubject(
  grant: LicenseGrantRow,
  vendorName: string,
  vendorSlug: string,
  to: string,
) {
  return {
    to,
    billingAccountId: grant.billingAccountId,
    vendorName,
    vendorSlug,
    quantity: grant.quantity,
    source: grant.source,
    endsAt: grant.endsAt,
    termsVersion: grant.termsVersion,
  };
}
