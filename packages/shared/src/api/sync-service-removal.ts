/**
 * The fixed vocabularies of a Sync Service removal (AECI-2192, ruling 66 on AECI-2035,
 * after counsel's answers Q73 and Q74; `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.2a).
 *
 * - {@link REMOVAL_REASON_CODES}: the reason an endpoint vendor picks when it removes an
 *   integration a Sync Service delivers from its product. Each one is a statement the
 *   vendor makes about its own product, so an objection can test it as "plainly false
 *   on its face" against the vendor's own public material.
 * - {@link OBJECTION_GROUNDS}: the only three grounds on which the Sync Service may
 *   object, and on which AEC Integrations looks at an objection.
 * - {@link REMOVAL_END_REASONS}: why AEC Integrations ended a removal. The three
 *   objection grounds, and the two further cases ruling 66 names.
 *
 * Stored as text with no table CHECK (`sync_service_pair_vetoes.reason_code` and
 * `end_reason` are plain ADD COLUMNs, `docs/migrations.md` §0), so the Zod schemas in
 * `./sync-service-pair-rights` are the only validation the values get. The new
 * objection table's `ground` carries a CHECK, because that table is new.
 *
 * Zod-free on purpose (`packages/shared/README.md` "Zod-free modules"). The English
 * labels here are for the API's own text (the AECi alert email). The portal and the
 * admin console render their own `$localize` copy.
 */

/**
 * The reasons a vendor may give for a removal, in display order. The legal agent's
 * read of ruling 66 (2026-11-26) dropped "It is not offered for our product": it is a
 * claim that the integration does not exist, and the separate "Not offered" report
 * covers that. It also reworded the last reason, so its code is `no_longer_work_with`.
 */
export const REMOVAL_REASON_CODES = [
  'not_supported',
  'not_authorised',
  'no_longer_work_with',
] as const;
export type RemovalReasonCode = (typeof REMOVAL_REASON_CODES)[number];

/**
 * The wire value for a stored `reason_code` outside {@link REMOVAL_REASON_CODES}: a row
 * written under an older list. The reader shows a generic line for it, never the stored
 * text. Never accepted on a write (`FileVetoSchema` takes the fixed list only).
 */
export const REMOVAL_REASON_UNRECOGNISED = 'unrecognised' as const;
/** A removal's reason as it reaches a reader: a fixed code, or the unrecognised marker. */
export type RemovalReasonWireCode = RemovalReasonCode | typeof REMOVAL_REASON_UNRECOGNISED;

/** AECi answers an objection, accepted or declined, within this many business days of
 *  receiving it (the Listing Accuracy Policy, after the legal agent's read of ruling 66). */
export const OBJECTION_ANSWER_BUSINESS_DAYS = 5;

/** The three grounds an objection may name, in display order. */
export const OBJECTION_GROUNDS = [
  'unauthorised_account',
  'wrong_product',
  'reason_plainly_false',
] as const;
export type ObjectionGround = (typeof OBJECTION_GROUNDS)[number];

/** Why AEC Integrations ended a removal: an objection ground, or one of two more cases. */
export const REMOVAL_END_REASONS = [
  ...OBJECTION_GROUNDS,
  'claim_ended_or_suspended',
  'law_requires',
] as const;
export type RemovalEndReason = (typeof REMOVAL_END_REASONS)[number];

/** The states of an objection. `closed`: the removal ended another way while it was open. */
export const OBJECTION_STATUSES = ['open', 'accepted', 'declined', 'closed'] as const;
export type ObjectionStatus = (typeof OBJECTION_STATUSES)[number];

export function isRemovalReasonCode(value: unknown): value is RemovalReasonCode {
  return (REMOVAL_REASON_CODES as readonly unknown[]).includes(value);
}

/**
 * A stored `reason_code` for the wire: the code when it is on the list, `null` when no
 * code was stored (a removal filed before the fixed list, read with its own words), and
 * {@link REMOVAL_REASON_UNRECOGNISED} for any other stored value.
 */
export function removalReasonWireCode(value: unknown): RemovalReasonWireCode | null {
  if (value === null || value === undefined) return null;
  return isRemovalReasonCode(value) ? value : REMOVAL_REASON_UNRECOGNISED;
}

export function isObjectionGround(value: unknown): value is ObjectionGround {
  return (OBJECTION_GROUNDS as readonly unknown[]).includes(value);
}

export function isRemovalEndReason(value: unknown): value is RemovalEndReason {
  return (REMOVAL_END_REASONS as readonly unknown[]).includes(value);
}

/** The reason as the vendor states it. Shown to the Sync Service and AECi, never public. */
export const REMOVAL_REASON_LABELS: Readonly<Record<RemovalReasonCode, string>> = {
  not_supported: 'We do not support this integration',
  not_authorised: 'We have not authorised it for our product',
  no_longer_work_with: 'We no longer work with this company',
};

/** The English line for a stored code outside the list. Shown to the owner and AECi. */
export const REMOVAL_REASON_UNRECOGNISED_LABEL = 'The vendor gave another reason';

/** The English label of a stored reason code, for the API's own text. */
export function removalReasonEnglish(value: unknown): string | null {
  const code = removalReasonWireCode(value);
  if (code === null) return null;
  return code === REMOVAL_REASON_UNRECOGNISED
    ? REMOVAL_REASON_UNRECOGNISED_LABEL
    : REMOVAL_REASON_LABELS[code];
}

/** An objection ground in plain words. */
export const OBJECTION_GROUND_LABELS: Readonly<Record<ObjectionGround, string>> = {
  unauthorised_account: 'The removal came from an account that should not have had access',
  wrong_product: 'The removal named the wrong product',
  reason_plainly_false: 'The reason is plainly false on its face',
};

/** The longest objection explanation the API takes. */
export const OBJECTION_EXPLANATION_MAX = 2000;
