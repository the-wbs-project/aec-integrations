/**
 * AECI-1877, shared by AECI-1879: a barrier a suite finds today, with its Linear issue.
 *
 * Each suite keeps its own list, typed by the names of its checks. `applies`
 * decides per surface, so the mark lands on its own surfaces only. `mark` calls
 * `knownFailure` with a literal issue ID, which `pnpm test:scripts` requires.
 * When the issue is fixed the test passes, `knownFailure` turns it red, and the
 * entry goes.
 */
import type { A11ySurface } from '../surfaces';

export interface KnownBarrier<Check extends string> {
  readonly check: Check;
  readonly applies: (surface: A11ySurface) => boolean;
  readonly mark: () => void;
}

/** Mark the running test for every barrier on this check and surface. */
export function markKnownBarriers<Check extends string>(
  barriers: readonly KnownBarrier<Check>[],
  surface: A11ySurface,
  check: Check,
): void {
  for (const barrier of barriers) {
    if (barrier.check === check && barrier.applies(surface)) barrier.mark();
  }
}
