import type { ConsoleChipTone } from '../../shared/chip/chip';

/**
 * Which chip tone each admin status takes (AECI-1813, mock-up 14's legend, "One
 * status-to-chip tone mapping"). One map, so no screen invents its own. A slice
 * maps its API value to one of these keys and renders
 * `<aec-chip density="dense" [tone]="adminStatusTone(key)">{{ label }}</aec-chip>`.
 * The chip's words carry the state. The tone never decides anything.
 *
 * The keys name the status as the console prints it today, not the wire value,
 * because two tables print the same word for different columns (`open`,
 * `pending`). A status that is not here is a new status: add it here, beside its
 * kin, rather than picking a tone in the screen.
 *
 * One word can need two keys when its severity differs: an entitlement that
 * `expired` is quiet, a legal notice that `noticeExpired` is attention; the
 * general `unknown` is quiet, the email ledger's `emailUnconfirmed` is attention.
 * Map each wire value to a key with an exhaustive `switch` in the screen, so a new
 * wire value is a compile error, not a silent default.
 */
export const ADMIN_STATUS_TONES = {
  // count: a queue count on the section row, the menu and the account badge.
  queueCount: 'count',

  // neutral: a fact about the row that is not a state.
  canManageSeats: 'neutral',
  workEmailVerified: 'neutral',
  role: 'neutral',
  priority: 'neutral',
  note: 'neutral',
  matchedByHand: 'neutral',
  /** The Activity feed's bot chip: the bot's name, a fact about the row (AECI-2125). */
  bot: 'neutral',
  /**
   * A pure connector vendor that owns integrations (`admin/vendors/vendor-detail.html`).
   * A fact, not a warning: an owner manages its rows on any plan (ruling 14, AECI-1663).
   * Its sibling with no integrations, `pureConnectorVendor`, stays attention.
   */
  pureConnectorOwner: 'neutral',

  // waiting: waits on someone.
  pending: 'waiting',
  open: 'waiting',
  inReview: 'waiting',
  waitingForAcceptance: 'waiting',
  notYetReviewed: 'waiting',
  inFlight: 'waiting',
  requested: 'waiting',
  withTheOwner: 'waiting',
  notDecidedYet: 'waiting',
  waitingToForward: 'waiting',
  restoreWindowOpens: 'waiting',
  helpRequested: 'waiting',
  parkedAsAmbiguous: 'waiting',
  linearIssuePending: 'waiting',
  /** The email ledger's in-flight send (`email/email-activity.ts`). */
  sending: 'waiting',
  /** Email delivery: "Accepted by Resend", handed to the provider, not delivered yet. */
  acceptedByProvider: 'waiting',
  /** A legal notice delivery that has not gone out yet (`LEGAL_NOTICE_DELIVERY_STATUSES`). */
  queued: 'waiting',
  /** A research job (`RESEARCH_STATUSES` in_progress). */
  inProgress: 'waiting',
  /** An upcoming legal version not yet recorded on `/admin/legal` (`legal/legal-versions.ts`). */
  notPublished: 'waiting',

  // positive: live, or done as intended.
  approved: 'positive',
  accepted: 'positive',
  resolved: 'positive',
  live: 'positive',
  active: 'positive',
  accountActive: 'positive',
  matched: 'positive',
  passing: 'positive',
  succeeded: 'positive',
  restored: 'positive',
  agreedWithSubmitter: 'positive',
  /** Email ledger and delivery, and a delivered legal notice. */
  sent: 'positive',
  delivered: 'positive',
  /** A research job that finished (`RESEARCH_STATUSES` done). */
  done: 'positive',
  /** A review reply or a vendor thread reply that is live. */
  published: 'positive',
  /** A product request we added to the catalog (`PRODUCT_REQUEST_STATUSES` added). */
  added: 'positive',
  /** An open row thread between two companies: live, and nothing waits on AECi. */
  threadOpen: 'positive',
  /** A feedback submitter who also joined the mailing list (`/admin/audience` inbox). */
  joinedMailingList: 'positive',
  /** A connector listing's mapping that counts toward public reach ("Confirmed", AECI-2125). */
  confirmed: 'positive',

  // quiet: closed, withdrawn or not measured. Nothing to do.
  rejected: 'quiet',
  removed: 'quiet',
  archived: 'quiet',
  withdrawn: 'quiet',
  declined: 'quiet',
  ended: 'quiet',
  expiredNeverAccepted: 'quiet',
  retiredByOwner: 'quiet',
  retiredByAeci: 'quiet',
  notRestored: 'quiet',
  unsubscribed: 'quiet',
  removedByVendor: 'quiet',
  notScored: 'quiet',
  notMeasured: 'quiet',
  skipped: 'quiet',
  inferred: 'quiet',
  recorded: 'quiet',
  unknown: 'quiet',
  outOfScope: 'quiet',
  ruledOut: 'quiet',
  agreedWithOwner: 'quiet',
  noRecord: 'quiet',
  /** The email ledger's repeat send that was skipped as a duplicate. */
  duplicate: 'quiet',
  /** An entitlement that ran out or was revoked (`ENTITLEMENT_STATUSES`). Nothing to do. */
  expired: 'quiet',
  revoked: 'quiet',
  /** A closed vendor thread. */
  closed: 'quiet',
  /** A product request for a product the catalog already lists (`already_listed`). */
  alreadyListed: 'quiet',

  // attention: look before you act. Not a fault.
  toxicityHigh: 'attention',
  possibleDuplicate: 'attention',
  pureConnectorVendor: 'attention',
  noProductsOnRecord: 'attention',
  roleUnknown: 'attention',
  needsAttention: 'attention',
  repeatOffender: 'attention',
  hidden: 'attention',
  cancelsAtTermEnd: 'attention',
  restoreBy: 'attention',
  caveat: 'attention',
  /** The Activity feed's "Unclassified" bot chip: never classified, so counted as
   *  human. A caveat on the row, not a fault (AECI-2125). */
  botUnclassified: 'attention',
  classifierChanged: 'attention',
  /** Email ledger: a send held back, by the suppression list or a paused switch. */
  suppressed: 'attention',
  paused: 'attention',
  /** Email delivery that has not landed yet but has not failed. */
  delayed: 'attention',
  /**
   * The email ledger's "Unknown": a send nobody can confirm. Not the general
   * `unknown` (quiet): here someone may not have received a message.
   */
  emailUnconfirmed: 'attention',
  /**
   * A legal notice that reached nobody or ran out of time
   * (`LEGAL_NOTICE_DELIVERY_STATUSES` no_recipients, expired). A legal notice that
   * was not delivered must never read as quiet.
   */
  noRecipients: 'attention',
  noticeExpired: 'attention',
  /** A termination refund an operator must make by hand (`VENDOR_TERMINATION_REFUND_STATUSES`). */
  refundManual: 'attention',
  /** A research job that stopped (`RESEARCH_STATUSES` blocked). */
  blocked: 'attention',
  /** The re-index worklist's priority 1, the tier to do first (AECI-2125). Tiers 2 to 4 are `priority`. */
  topPriority: 'attention',
  /**
   * A re-index submission IndexNow refused with a 4xx, a 429 included. Not a fault:
   * the drain keeps it out of `failed` (`apps/api/src/lib/indexnow-drain.ts`). The
   * shared `refused` key stays critical. Ruled 2026-11-24 (AECI-2125).
   */
  indexNowRefused: 'attention',

  // critical: a fault or a block. The only red.
  failed: 'critical',
  errored: 'critical',
  refused: 'critical',
  banned: 'critical',
  overdue: 'critical',
  courtActionReported: 'critical',
  suspended: 'critical',
  companiesDisagree: 'critical',
  /** Email delivery that failed for good. */
  bounced: 'critical',
  markedAsSpam: 'critical',
  /** A legal notice the mail provider dropped (`LEGAL_NOTICE_DELIVERY_STATUSES`). */
  dropped: 'critical',
} as const satisfies Record<string, ConsoleChipTone>;

export type AdminStatusKey = keyof typeof ADMIN_STATUS_TONES;

/** The tone for one status. */
export function adminStatusTone(status: AdminStatusKey): ConsoleChipTone {
  return ADMIN_STATUS_TONES[status];
}
