import { Component, input } from '@angular/core';

import { CLAIM_OWNER_REVIEW_DAYS } from '@aeci/shared';

/**
 * The claimant-facing seat disclosure (AECI-1366, Chris's ruled copy). Shown on a claim
 * form when `GET /api/requests/claim-target/:type/:slug` says the company already has an
 * owner seat (`has_seats`), so a claim sent now goes to that team first and AECi steps in
 * after {@link CLAIM_OWNER_REVIEW_DAYS} days (AECI-1368).
 *
 * Informational only: it never blocks the submit. A failed lookup shows nothing. A
 * polite live region, so a notice that appears after the lookup resolves is announced
 * without interrupting.
 */
@Component({
  selector: 'aec-claim-routed-notice',
  host: { class: 'block', 'aria-live': 'polite' },
  template: `
    @if (show()) {
      <p
        class="rounded-(--radius-md) bg-(--accent-warm) px-3 py-2 text-sm text-(--accent-secondary-deep)"
        data-testid="claim-routed-notice"
      >
        @if (company(); as name) {
          <ng-container i18n="@@requests.claim.routedNotice"
            >{{ name }} already maintains this listing. Send your request and their team will
            confirm you. We step in if they do not answer within {{ days }} days.</ng-container
          >
        } @else {
          <ng-container i18n="@@requests.claim.routedNotice.unnamed"
            >This company already maintains this listing. Send your request and their team will
            confirm you. We step in if they do not answer within {{ days }} days.</ng-container
          >
        }
      </p>
    }
  `,
})
export class ClaimRoutedNotice {
  /** `has_seats` from the claim-target lookup. False while loading or on failure. */
  readonly show = input(false);
  /** The company the claim is on. Null reads "This company". */
  readonly company = input<string | null>(null);

  protected readonly days = CLAIM_OWNER_REVIEW_DAYS;
}
