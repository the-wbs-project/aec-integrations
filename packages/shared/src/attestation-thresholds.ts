/**
 * The §7.1 attestation-detector thresholds (`STAGE_2_ATTESTATIONS_SPEC.md` §7.1,
 * §6.2), shared so the detector and the vendor-facing copy cannot drift.
 *
 * These used to live in `apps/api/src/lib/attestation-detectors.ts`, which the
 * browser bundle cannot import. AECI-961 put real numbers into vendor-facing
 * portal copy — the claim lane tells a vendor "we ask {other} to answer after 14
 * days" — and a sentence that quotes a threshold from a second, hand-copied
 * source is a promise that silently becomes a lie the first time someone retunes
 * the detector. Moving them here makes the drift structurally impossible rather
 * than a lockstep test someone has to remember to write.
 *
 * They are still **launch-tunable constants**, documented in
 * `docs/POST_LAUNCH_MONITORING.md` §3, and they still change by edit-and-deploy
 * rather than by config. What changed is the blast radius: editing one of these
 * now also edits what the portal says, so read the §6.2 copy table before you
 * retune.
 *
 * `apps/api/src/lib/attestation-detectors.ts` re-exports all three under these
 * exact names, so nothing that imported them from there had to move.
 */

/** A claim one-sided (`single_source`) for longer than this nudges the silent
 *  slot's vendor. Long enough that a vendor who simply hasn't opened the portal
 *  yet is not chased, short enough that the context is still fresh. */
export const SILENT_COUNTERPARTY_DAYS = 14;

/** An unresolved `conflict` older than this nudges **both** disputants and raises
 *  AECi ops. Tighter than the silent threshold on purpose: a live vendor-vs-vendor
 *  disagreement is the lowest-volume, highest-signal state in the model. */
export const OPEN_CONFLICT_DAYS = 7;

/** A live vendor attestation older than this with **no** version data at all is
 *  asked to re-confirm — an annual cadence rather than a rolling nag. Note that
 *  nothing in D1 carries version stamps yet (AECI-607 shipped the columns; no
 *  backfill), so at launch this is the only clause that can ever match. */
export const STALE_VERSION_MONTHS = 12;
