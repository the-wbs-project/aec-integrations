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
  classifierChanged: 'attention',

  // critical: a fault or a block. The only red.
  failed: 'critical',
  errored: 'critical',
  refused: 'critical',
  banned: 'critical',
  overdue: 'critical',
  courtActionReported: 'critical',
  suspended: 'critical',
  companiesDisagree: 'critical',
} as const satisfies Record<string, ConsoleChipTone>;

export type AdminStatusKey = keyof typeof ADMIN_STATUS_TONES;

/** The tone for one status. */
export function adminStatusTone(status: AdminStatusKey): ConsoleChipTone {
  return ADMIN_STATUS_TONES[status];
}
