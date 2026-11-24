import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { AgreementState } from '@aeci/shared';

import { Chip, type ChipTone } from '../shared/chip/chip';
import { AecIcon } from '../shared/icon/icon';

/**
 * The agreement pill for a `data_object` claim on the pair page (Stage 1.5 §8 —
 * AECI-300; four states from `STAGE_2_ATTESTATIONS_SPEC.md` §4.3 — AECI-605).
 *
 * The four states and their tone, which is the whole point of the component:
 *
 * - **`unverified`** — the Stage 1.5 baseline, and the state of every claim no
 *   vendor has confirmed. Still the overwhelming majority of the catalog.
 *   Neutral chip reading "Listed by AEC Integrations" (AECI-1142: says who
 *   listed it, in plain words, instead of the old "Unverified · AECi"). Never a
 *   warning or a defect (the AECi-never-red rule, §3.4). Its accessible name adds
 *   that neither company has confirmed it.
 *   - **Refuted** (AECI-1140, ruling 2026-10-27): still `unverified`, but every
 *     vendor that voted says No (`ProductPairClaim.refuted`). Same neutral chip
 *     with `single_source`'s stronger dot, because a company has spoken. It reads
 *     "A company says no". It names no company and gives no reason (the reason is
 *     private, AECI-1139). Never red: a lone No is not a vendor-vs-vendor conflict.
 * - **`single_source`** — exactly one vendor affirms and the counterparty is
 *   silent. Deliberately **neutral and attributed**: it names the vendor and
 *   says the other has not responded, so the silence is visible rather than
 *   implied. It must never borrow `confirmed`'s Forest wash — rendering
 *   one-sided assertion as agreement is what `STAGE_2_SPEC.md` §8.1(4) forbids.
 * - **`owner_confirmed`** (AECI-2039, ruling 4 on AECI-2035) — the company that offers
 *   a Sync Service pair confirmed the flow. A Sync Service runs both sides, so the two
 *   endpoint vendors do not answer there. It names that company, "Confirmed by
 *   {vendor}, which offers this integration", and never says "both companies". One
 *   company's word, so it keeps the neutral chip with `single_source`'s stronger dot.
 * - **`confirmed`** — two *distinct* vendors affirm. The only state that earns
 *   the positive treatment: Forest-soft wash + Forest text (10.80:1).
 * - **`conflict`** — two distinct vendors describe the flow differently. The
 *   **only red state** (`--status-error`, 6.54:1). It reports a disagreement
 *   between vendors, not a defect in either product, so the copy names the
 *   disagreement and stops there.
 *
 * Colour is never the sole signal (WCAG 1.4.1): each state carries a distinct
 * visible label and its full meaning as visually hidden text, and the dot/glyph is
 * `aria-hidden`. The meaning used to be an `aria-label` on the chip's plain span, which
 * assistive tech may ignore (AECI-1720 restore C). Light
 * theme only (Stage 1 / AECI-226).
 *
 * This claim-agreement chip was kept distinct from the account-status label
 * through its state-specific wording and tone. That label was removed on
 * 2026-10-09 (AECI-1264), so no public chip reports account access now.
 */
@Component({
  selector: 'aec-agreement-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Chip, AecIcon],
  template: `
    <!-- AECI-1720 restore C (records/10 §2, records/11 §8, mock-up 12): the full meaning
         is real text, visually hidden, and the visible label is aria-hidden so it is read
         once. An aria-label on a plain span is not reliably read. -->
    <aec-chip label [tone]="tone()">
      @if (agreement() === 'conflict') {
        <!-- A shape, not just a hue: the conflict state must survive both
             greyscale and a colour-vision deficiency. -->
        <aec-icon name="x" decorative [size]="3.5" />
      } @else {
        <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full" [class]="dotClass()"></span>
      }
      <span aria-hidden="true">{{ label() }}</span>
      <span class="sr-only" data-testid="agreement-badge-meaning">{{ ariaLabel() }}</span>
    </aec-chip>
  `,
})
export class AgreementBadge {
  readonly agreement = input.required<AgreementState>();

  /**
   * The vendor that affirmed, for `single_source`. Resolved by the pair page
   * from the affirming attestation's context-relative `attestor` and the two
   * hydrated vendor links. `null` falls back to an unattributed phrasing rather
   * than rendering an empty name — a pair whose product has no `product_vendors`
   * row is legal (`ProductListItem.vendor` is nullable).
   */
  readonly attributedTo = input<string | null>(null);

  /**
   * Every vendor that voted on the claim denies it (`ProductPairClaim.refuted`,
   * computed by the API). Read only for `unverified`, the one state the engine
   * returns for a refuted claim.
   */
  readonly refuted = input(false);

  /**
   * AECI-2039. The claim sits on a Sync Service pair, where the company that offers
   * the integration answers for its flows, not the two endpoint companies. Read only
   * for `unverified`: its accessible name then says who has not confirmed it, because
   * "Neither company has confirmed it yet" is about two companies that cannot answer.
   */
  readonly syncService = input(false);

  private readonly isRefuted = computed(() => this.agreement() === 'unverified' && this.refuted());

  protected readonly label = computed<string>(() => {
    if (this.isRefuted()) return $localize`:@@pair.claim.badge.refuted:A company says no`;
    switch (this.agreement()) {
      case 'confirmed':
        return $localize`:@@pair.claim.badge.confirmed:Confirmed by both companies`;
      case 'single_source': {
        const vendor = this.attributedTo();
        return vendor
          ? $localize`:@@pair.claim.badge.singleSource:Confirmed by ${vendor}:vendor:`
          : $localize`:@@pair.claim.badge.singleSource.unattributed:Confirmed by one company`;
      }
      case 'owner_confirmed': {
        const vendor = this.attributedTo();
        return vendor
          ? $localize`:@@pair.claim.badge.ownerConfirmed:Confirmed by ${vendor}:vendor:, which offers this integration`
          : $localize`:@@pair.claim.badge.ownerConfirmed.unattributed:Confirmed by the company that offers this integration`;
      }
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict:Companies disagree`;
      default:
        return $localize`:@@pair.claim.badge.unverified:Listed by AEC Integrations`;
    }
  });

  protected readonly ariaLabel = computed<string>(() => {
    if (this.isRefuted()) {
      return $localize`:@@pair.claim.badge.refuted.aria:One of these companies says this does not happen. Neither company has confirmed it.`;
    }
    switch (this.agreement()) {
      case 'confirmed':
        return $localize`:@@pair.claim.badge.confirmed.aria:Confirmed by both companies.`;
      case 'single_source': {
        const vendor = this.attributedTo();
        // The counterparty's silence is stated, never left to be inferred.
        return vendor
          ? $localize`:@@pair.claim.badge.singleSource.aria:Confirmed by ${vendor}:vendor:. The other company has not answered yet.`
          : $localize`:@@pair.claim.badge.singleSource.unattributed.aria:Confirmed by one company. The other company has not answered yet.`;
      }
      case 'owner_confirmed': {
        const vendor = this.attributedTo();
        return vendor
          ? $localize`:@@pair.claim.badge.ownerConfirmed.offers.aria:Confirmed by ${vendor}:vendor:, which offers this integration.`
          : $localize`:@@pair.claim.badge.ownerConfirmed.offers.unattributed.aria:Confirmed by the company that offers this integration.`;
      }
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict.aria:The two companies disagree about this.`;
      default:
        if (this.syncService()) {
          // AECI-2039: the two endpoint companies cannot answer on a Sync Service pair.
          const vendor = this.attributedTo();
          return vendor
            ? $localize`:@@pair.claim.badge.unverified.syncService.aria:Listed by AEC Integrations from public sources. ${vendor}:vendor:, which offers this integration, has not confirmed it yet.`
            : $localize`:@@pair.claim.badge.unverified.syncService.unattributed.aria:Listed by AEC Integrations from public sources. The company that offers this integration has not confirmed it yet.`;
        }
        // The visible label says who listed it. The accessible name also says what
        // is missing, so "listed" is never heard as an endorsement.
        return $localize`:@@pair.claim.badge.unverified.aria:Listed by AEC Integrations from public sources. Neither company has confirmed it yet.`;
    }
  });

  /** Tone per state. Only `conflict` is red; only `confirmed` gets the Forest
   *  wash. `unverified` and `single_source` share the neutral chip, quiet text
   *  included, by design, so a lone affirmation cannot read as agreement. */
  protected readonly tone = computed<ChipTone>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return 'wash';
      case 'conflict':
        return 'error';
      default:
        return 'quiet';
    }
  });

  /** `single_source` and a refuted claim use a stronger dot than `unverified`,
   *  the one visual difference between the neutral states, so "a vendor has
   *  spoken" reads without promoting it to the affirmative treatment. */
  protected readonly dotClass = computed<string>(() => {
    if (this.isRefuted()) return 'bg-(--text-secondary)';
    switch (this.agreement()) {
      case 'confirmed':
        return 'bg-(--accent-primary)';
      case 'single_source':
      case 'owner_confirmed':
        return 'bg-(--text-secondary)';
      default:
        return 'bg-(--text-tertiary)';
    }
  });
}
