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

/** The reasons a vendor may give for a removal, in display order. */
export const REMOVAL_REASON_CODES = [
  'not_supported',
  'not_offered_for_product',
  'not_authorised',
  'ended',
] as const;
export type RemovalReasonCode = (typeof REMOVAL_REASON_CODES)[number];

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

export function isObjectionGround(value: unknown): value is ObjectionGround {
  return (OBJECTION_GROUNDS as readonly unknown[]).includes(value);
}

export function isRemovalEndReason(value: unknown): value is RemovalEndReason {
  return (REMOVAL_END_REASONS as readonly unknown[]).includes(value);
}

/** The reason as the vendor states it. Shown to the Sync Service and AECi, never public. */
export const REMOVAL_REASON_LABELS: Readonly<Record<RemovalReasonCode, string>> = {
  not_supported: 'We do not support this integration',
  not_offered_for_product: 'It is not offered for our product',
  not_authorised: 'We have not authorised it for our product',
  ended: 'We ended our relationship with this company',
};

/** An objection ground in plain words. */
export const OBJECTION_GROUND_LABELS: Readonly<Record<ObjectionGround, string>> = {
  unauthorised_account: 'The removal came from an account that should not have had access',
  wrong_product: 'The removal named the wrong product',
  reason_plainly_false: 'The reason is plainly false on its face',
};

/** The longest objection explanation the API takes. */
export const OBJECTION_EXPLANATION_MAX = 2000;
