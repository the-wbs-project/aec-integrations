/**
 * Computed agreement + the sync headline (Stage 1.5 §3.4 / §3.5 — AECI-300;
 * narrowed to distinct vendor identities by Stage 2 §4 — AECI-605).
 *
 * Agreement is **computed from the attestation set, never stored** (ADR 0018).
 * These two pure functions are the single implementation shared by the API,
 * SSR, and tests so the pair page (§8), the API mapper, and the Stage 2 portal
 * can never drift from a materialised column.
 *
 * Two rules govern the vote:
 *
 * - **AECi-never-red** (§3.4): only vendor attestations vote — the AECi
 *   attestation is the seed/baseline and is excluded — so an AECi-only claim
 *   can never resolve to `conflict`.
 * - **Distinct vendor identities** (`STAGE_2_ATTESTATIONS_SPEC.md` §4): votes
 *   are deduped by `attestedByVendorId`, and `confirmed` needs **two** of them.
 *   One company can own both endpoints of an integration (`product_vendors` is
 *   many-to-many); without the dedupe it could affirm both slots and manufacture
 *   "Vendor-confirmed" on its own intra-portfolio integrations. A single vendor
 *   affirming alone reads `single_source`, never `confirmed` — rendering
 *   one-sided assertion as agreement is what `STAGE_2_SPEC.md` §8.1(4) forbids.
 */

/**
 * Enumerated agreement states, in ascending order of verification. Only
 * `unverified` is reachable until the Stage 2 portal (AECI-301) lets vendors
 * attest; `single_source`/`confirmed`/`conflict` are unit-tested against
 * synthetic attestations so they ship proven.
 */
export const AGREEMENT_STATES = ['unverified', 'single_source', 'confirmed', 'conflict'] as const;

export type AgreementState = (typeof AGREEMENT_STATES)[number];

/**
 * The minimal attestation shape `computeAgreement` needs: who asserts, under
 * which vendor identity, whether they affirm, and whether the assertion still
 * stands. Deliberately loose on `source` (a plain string) — the only semantics
 * is "is this the excluded AECi baseline?" — so this module stays decoupled
 * from the promote/API contract that owns the full source enum.
 *
 * `retractedAt` is **supersession**, not the `deprecated_at` version stamp
 * (`STAGE_1_5_SPEC.md` §3.3): a vendor recording that a flow was deprecated in
 * v6 must keep voting, a vendor that withdrew its assertion must not. The API
 * read configs also filter retracted rows in SQL; this check is the shared
 * contract's own guarantee, so a caller that forgets cannot resurrect a
 * withdrawn vote.
 */
export interface AgreementAttestation {
  readonly source: string;
  readonly asserted: boolean;
  /** The vendor identity behind the vote. `null` for the AECi seed — and
   *  reachable on a vendor row too, since the FK is `ON DELETE SET NULL`. */
  readonly attestedByVendorId: string | null;
  /** Non-null once the vendor withdrew or replaced this assertion. */
  readonly retractedAt: string | null;
}

/**
 * The bucket every unattributable vote collapses into. Deleting a vendor row
 * nulls `attested_by_vendor_id` (`ON DELETE SET NULL`) while leaving the
 * attestation live, so two orphaned votes must not be mistaken for two distinct
 * vendors. Folding them all into one identity makes `confirmed` unreachable
 * without provable distinctness — the safe direction to fail.
 *
 * A `symbol` rather than a sentinel string: it cannot collide with a real
 * `attested_by_vendor_id` by construction, so the guarantee does not rest on
 * "no vendor id will ever look like this".
 */
const UNATTRIBUTED: unique symbol = Symbol('unattributed');

/**
 * Reduce the attestation set to **one stance per distinct vendor identity**
 * (`true` = affirms). The AECi seed and retracted rows never enter the tally.
 *
 * A voter's stance is `affirm` only if *every* one of its live votes asserts —
 * any deny wins. This resolves the degenerate case the slot model permits:
 * `attestations_slot_key` is unique per `(claim, slot)`, not per vendor, so a
 * company owning both endpoints can affirm one slot and deny the other. That is
 * self-contradiction, not bilateral agreement and not a vendor-vs-vendor
 * conflict, so it must not read as either.
 */
function tallyVoters(attestations: readonly AgreementAttestation[]): Map<string | symbol, boolean> {
  const voters = new Map<string | symbol, boolean>();
  for (const a of attestations) {
    if (a.source === 'aeci') continue;
    if (a.retractedAt !== null) continue;
    const identity = a.attestedByVendorId ?? UNATTRIBUTED;
    voters.set(identity, (voters.get(identity) ?? true) && a.asserted);
  }
  return voters;
}

/**
 * Derive a claim's agreement from its attestations (§3.4 / Stage 2 §4.2), by
 * **distinct vendor identity**:
 *
 * | Distinct vendor voters | Outcome |
 * |---|---|
 * | 0 | `unverified` — the Stage 1.5 baseline (AECi-only claims) |
 * | 1, affirming | `single_source` |
 * | ≥1, denying only | `unverified` — denied-but-unconfirmed is not a conflict |
 * | ≥2 distinct, all affirming | `confirmed` — bilateral only |
 * | ≥2 distinct, affirm **and** deny | `conflict` |
 */
export function computeAgreement(attestations: readonly AgreementAttestation[]): AgreementState {
  let affirming = 0;
  let denying = 0;
  for (const affirms of tallyVoters(attestations).values()) {
    if (affirms) affirming++;
    else denying++;
  }
  if (affirming >= 2) return denying > 0 ? 'conflict' : 'confirmed';
  if (affirming === 1) return denying > 0 ? 'conflict' : 'single_source';
  return 'unverified';
}

/**
 * One attestation row as {@link conflictSince} replays it: the vote, plus the two
 * instants that bound its life. Live AND retracted rows, because the history is
 * append-only (supersession is retract-then-insert, and a retract stamps
 * `retracted_at` rather than deleting).
 */
export interface HistoricalAttestation extends AgreementAttestation {
  /** ISO-8601. When the row was written. */
  readonly createdAt: string;
}

/** An ISO instant as epoch ms, tolerating the SQLite `YYYY-MM-DD HH:MM:SS` form a
 *  hand-written seed may use. `NaN` when it cannot be read. */
function instantMs(value: string): number {
  // `Date.parse` reads a zone-less `YYYY-MM-DD HH:MM:SS` as LOCAL time. SQLite's
  // `CURRENT_TIMESTAMP` is UTC, so pin that form to UTC before parsing.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
    return Date.parse(`${value.replace(' ', 'T')}Z`);
  }
  return Date.parse(value);
}

/**
 * When the claim's agreement last became `conflict`: the start of the current,
 * unbroken run of `conflict`, or `null` when the claim is not in `conflict` now
 * (AECI-1153 / `API_CONTRACTS.md` §6.14, the `disagreement.raised_at` rule).
 *
 * Derived, never stored. The rule:
 *
 * 1. Take every vendor attestation row of the claim, live and retracted.
 * 2. Collect the distinct instants in `createdAt` and `retractedAt`, ascending.
 * 3. At each instant *t* the live set is the rows with `createdAt <= t` and
 *    (`retractedAt` null or `retractedAt > t`). Its agreement is
 *    {@link computeAgreement} of that set, so every §4.5 rule applies unchanged:
 *    votes deduped by vendor, null identities folded into one voter, and a
 *    self-contradicting voter read as `unverified`.
 * 4. The answer is the earliest instant from which the agreement is `conflict` at
 *    every later instant.
 *
 * A `PUT` retracts and inserts under one `now`, so a same-stance re-write (a note
 * edit) leaves no gap and does not move the answer. The identities are today's, so
 * the replay ends in exactly today's agreement. **It is not the `open-conflict`
 * detector's clock**, which measures from the newest live vote.
 *
 * Returns an ISO-8601 string. Rows whose instants cannot be read are ignored.
 */
export function conflictSince(rows: readonly HistoricalAttestation[]): string | null {
  const vendorRows = rows.filter(
    (row) => row.source !== 'aeci' && !Number.isNaN(instantMs(row.createdAt)),
  );
  const instants = new Set<number>();
  for (const row of vendorRows) {
    instants.add(instantMs(row.createdAt));
    if (row.retractedAt !== null) {
      const retracted = instantMs(row.retractedAt);
      if (!Number.isNaN(retracted)) instants.add(retracted);
    }
  }
  const ordered = [...instants].sort((a, b) => a - b);
  let since: number | null = null;
  for (const t of ordered) {
    const live = vendorRows
      .filter((row) => {
        if (instantMs(row.createdAt) > t) return false;
        if (row.retractedAt === null) return true;
        const retracted = instantMs(row.retractedAt);
        return Number.isNaN(retracted) || retracted > t;
      })
      // `computeAgreement` re-checks `retractedAt`. The replay has already decided
      // liveness at `t`, so each row enters as live.
      .map((row) => ({ ...row, retractedAt: null }));
    if (computeAgreement(live) === 'conflict') {
      since ??= t;
    } else {
      since = null;
    }
  }
  return since === null ? null : new Date(since).toISOString();
}

/**
 * Whether a claim's live vendor votes are **unanimously denials** — at least
 * one distinct voter, none affirming.
 *
 * This cannot be read off `AgreementState`: `unverified` covers both "nobody
 * voted" (the AECi-only baseline, which still describes a real flow) and
 * "every vendor says this flow does not exist". Only the latter must stop
 * contributing its direction to the product-detail integrations table
 * (`effectiveContextDirection`), or that table and the pair page contradict
 * each other again — the bug `STAGE_1_5_SPEC.md` §7.1 already had to fix once.
 */
export function isClaimRefuted(attestations: readonly AgreementAttestation[]): boolean {
  const voters = tallyVoters(attestations);
  if (voters.size === 0) return false;
  for (const affirms of voters.values()) {
    if (affirms) return false;
  }
  return true;
}

/**
 * The minimal claim shape `computeSyncHeadline` needs — its computed agreement,
 * and the `data_object` it moves (the headline counts objects, not rows).
 */
export interface SyncHeadlineClaim {
  readonly agreement: AgreementState;
  readonly data_object_slug: string;
}

/**
 * The distinct `data_object` slugs a set of claims covers, in first-seen order.
 * The AECI-1042 counting rule, and the one place it is written down: an object
 * moving in two directions, through two mechanisms, or on a duplicate row counts
 * once. `computeSyncHeadline().total` is this list's length, and the AECI-711
 * depth axis reads the same function for a single mechanism or a merged row, so
 * a row's "N data objects" and the pair page's cannot count differently.
 */
export function distinctDataObjectSlugs(
  claims: Iterable<{ readonly data_object_slug: string }>,
): string[] {
  const slugs = new Set<string>();
  for (const claim of claims) slugs.add(claim.data_object_slug);
  return [...slugs];
}

/**
 * The sync headline (§3.5, widened by Stage 2 §4.3; re-based on data objects by
 * AECI-1042). `total` is the number of **distinct `data_object` slugs** across the
 * pair's claims — all directions, all mechanisms, both delivered anchors. A
 * data_object moving through two mechanisms, or in both directions, counts once:
 * the header reads "N data objects sync", and before AECI-1042 a second integration
 * (or a duplicate row) that moved the same object inflated N.
 *
 * `confirmed` counts data objects with at least one claim two distinct vendors
 * affirm. `single_source` counts data objects with at least one claim exactly one
 * vendor affirms (counterparty silent) and **no** confirmed claim. An object is
 * therefore in at most one of the two, so `confirmed + single_source <= total`
 * holds and the ratio "C of N vendor-confirmed" can never exceed its own base.
 *
 * The two are reported separately because they must read differently: the
 * headline may never fold a one-sided assertion into the bilateral count. Both
 * are `0` until the Stage 2 portal lands, so the headline still communicates
 * breadth with an honest "Unverified" posture rather than a fake trust signal.
 */
export function computeSyncHeadline(claims: readonly SyncHeadlineClaim[]): {
  total: number;
  confirmed: number;
  single_source: number;
} {
  const confirmed = new Set<string>();
  const singleSource = new Set<string>();
  for (const claim of claims) {
    if (claim.agreement === 'confirmed') confirmed.add(claim.data_object_slug);
    else if (claim.agreement === 'single_source') singleSource.add(claim.data_object_slug);
  }
  for (const slug of confirmed) singleSource.delete(slug);
  return {
    total: distinctDataObjectSlugs(claims).length,
    confirmed: confirmed.size,
    single_source: singleSource.size,
  };
}
