import type { ObjectionGround, RemovalEndReason, RemovalReasonCode } from '@aeci/shared';

/**
 * The portal's and the console's words for a Sync Service removal's fixed lists
 * (AECI-2192, ruling 66 on AECI-2035). The vocabularies are `@aeci/shared`'s
 * (`REMOVAL_REASON_CODES`, `OBJECTION_GROUNDS`, `REMOVAL_END_REASONS`). The words are
 * here once, so the removal form, the owner's list, the notification archive and the
 * admin queue say the same thing. None of this is ever shown on a public page.
 */

/** A removal's reason, as the removing vendor states it about its own product. */
export function removalReasonLabel(code: RemovalReasonCode): string {
  switch (code) {
    case 'not_supported':
      return $localize`:@@removal.reason.notSupported:We do not support this integration`;
    case 'not_offered_for_product':
      return $localize`:@@removal.reason.notOfferedForProduct:It is not offered for our product`;
    case 'not_authorised':
      return $localize`:@@removal.reason.notAuthorised:We have not authorised it for our product`;
    case 'ended':
      return $localize`:@@removal.reason.ended:We ended our relationship with this company`;
  }
}

/** An objection ground. */
export function objectionGroundLabel(ground: ObjectionGround): string {
  switch (ground) {
    case 'unauthorised_account':
      return $localize`:@@removal.ground.unauthorisedAccount:It came from an account that should not have had access`;
    case 'wrong_product':
      return $localize`:@@removal.ground.wrongProduct:It named the wrong product`;
    case 'reason_plainly_false':
      return $localize`:@@removal.ground.reasonPlainlyFalse:Its reason is plainly false on its face`;
  }
}

/** Why AEC Integrations ended a removal. */
export function removalEndReasonLabel(reason: RemovalEndReason): string {
  switch (reason) {
    case 'unauthorised_account':
    case 'wrong_product':
    case 'reason_plainly_false':
      return objectionGroundLabel(reason);
    case 'claim_ended_or_suspended':
      return $localize`:@@removal.end.claimEnded:The vendor's claim to its product ended or was suspended`;
    case 'law_requires':
      return $localize`:@@removal.end.lawRequires:The law requires it`;
  }
}

/** The removal's reason, or an older removal's own words as recorded. */
export function removalReasonText(v: {
  readonly reason_code: RemovalReasonCode | null;
  readonly reason: string;
}): string {
  return v.reason_code ? removalReasonLabel(v.reason_code) : v.reason;
}
