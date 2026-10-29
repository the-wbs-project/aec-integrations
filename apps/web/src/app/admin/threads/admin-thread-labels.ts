import type { AdminThreadRow, ThreadClosedReason } from '@aeci/shared';

/** Why a thread closed, as the operator reads it (§15.10). */
export function closedReasonLabel(reason: ThreadClosedReason): string {
  switch (reason) {
    case 'retired':
      return $localize`:@@admin.threads.closed.retired:Closed: integration retired`;
    case 'withdrawn':
      return $localize`:@@admin.threads.closed.withdrawn:Closed: row withdrawn by its adder`;
    case 'claim_removed':
      return $localize`:@@admin.threads.closed.removed:Closed: row removed`;
    case 'not_attestable':
      return $localize`:@@admin.threads.closed.notAttestable:Closed: now connector-powered`;
  }
}

/** The row's state in one word or phrase: open, or closed and why. */
export function threadStateLabel(thread: Pick<AdminThreadRow, 'closed_reason'>): string {
  return thread.closed_reason
    ? closedReasonLabel(thread.closed_reason)
    : $localize`:@@admin.threads.state.open:Open`;
}

/** What the thread is about: its data object, or a fallback when the vocabulary lost it. */
export function threadSubject(thread: Pick<AdminThreadRow, 'data_object'>): string {
  return thread.data_object?.name ?? $localize`:@@admin.threads.subject.unknown:Unknown data row`;
}

/** "{Company A} and {Company B}", the two companies stamped on the thread. */
export function threadCompanies(thread: Pick<AdminThreadRow, 'vendor_a' | 'vendor_b'>): string {
  const a = thread.vendor_a.name;
  const b = thread.vendor_b.name;
  return $localize`:@@admin.threads.companies:${a}:A: and ${b}:B:`;
}
