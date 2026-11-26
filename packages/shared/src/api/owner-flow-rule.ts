/**
 * Which data flows on a Sync Service pair still wait for its owner's answer (AECI-2045,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.15.3 and §6.17.12).
 *
 * The rule: a flow waits when the owner may answer it now (the pair is claimed, its
 * connector is a Sync Service with an owner on file, and it is not retired, which the
 * server sends as `flows_editable`) and the owner has no live answer on it
 * (`answer === null`). A No is an answer: it removes the flow from the public page.
 * AECI-2139: a flow AECi corrected (`aeci_correction`) never waits. The owner cannot
 * answer it, so asking would nag forever.
 *
 * It is the same rule the product checklist's "Confirm data flows" step counts with in
 * SQL (`apps/api/src/routes/vendor-checklist.ts`, the owner-flow reads): claimed, live,
 * no live `claim_owner_answers` row by the vendor. Every portal surface that counts
 * waiting owner flows (the Integrations tab's summary line, the owned row's status and
 * "Things that need you") goes through these two functions, so they cannot disagree.
 *
 * Zod-free and framework-free, like `./connector-kind`.
 */

/** What the rule reads of a row: the server's `flows_editable` and each flow's answer. */
export interface OwnerFlowRow {
  readonly flows_editable: boolean;
  readonly flows: readonly {
    readonly id: string;
    readonly answer: 'yes' | 'no' | null;
    readonly aeci_correction?: unknown;
  }[];
}

/** The flows on `row` that wait for the owner's answer, in the row's order. */
export function ownerFlowsAwaitingAnswer<F extends OwnerFlowRow['flows'][number]>(row: {
  readonly flows_editable: boolean;
  readonly flows: readonly F[];
}): F[] {
  if (!row.flows_editable) return [];
  return row.flows.filter((flow) => flow.answer === null && !flow.aeci_correction);
}

/** How many flows on `row` wait for the owner's answer. */
export function countOwnerFlowsAwaitingAnswer(row: OwnerFlowRow): number {
  return ownerFlowsAwaitingAnswer(row).length;
}
