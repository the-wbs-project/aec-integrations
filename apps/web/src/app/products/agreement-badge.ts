import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { AgreementState } from '@aeci/shared';

/**
 * The agreement pill for a `data_object` claim on the pair page (Stage 1.5 §8 —
 * AECI-300; four states from `STAGE_2_ATTESTATIONS_SPEC.md` §4.3 — AECI-605).
 *
 * The four states and their tone, which is the whole point of the component:
 *
 * - **`unverified`** — the Stage 1.5 baseline and still the only state reachable
 *   until the vendor portal (AECI-301). Neutral chip, read as *"not yet
 *   vendor-confirmed"*, never a warning or a defect (the AECi-never-red rule,
 *   §3.4).
 * - **`single_source`** — exactly one vendor affirms and the counterparty is
 *   silent. Deliberately **neutral and attributed**: it names the vendor and
 *   says the other has not responded, so the silence is visible rather than
 *   implied. It must never borrow `confirmed`'s Forest wash — rendering
 *   one-sided assertion as agreement is what `STAGE_2_SPEC.md` §8.1(4) forbids.
 * - **`confirmed`** — two *distinct* vendors affirm. The only state that earns
 *   the positive treatment: Forest-soft wash + Forest text (10.80:1).
 * - **`conflict`** — two distinct vendors describe the flow differently. The
 *   **only red state** (`--status-error`, 6.54:1). It reports a disagreement
 *   between vendors, not a defect in either product, so the copy names the
 *   disagreement and stops there.
 *
 * Colour is never the sole signal (WCAG 1.4.1): each state carries a distinct
 * visible label and `aria-label`, and the dot/glyph is `aria-hidden`. Light
 * theme only (Stage 1 / AECI-226).
 *
 * Shape note: this is a `rounded.sm` **chip**, not the `rounded-full` pill —
 * `DESIGN.md` reserves the pill for `VerifiedBadge`, which means something
 * entirely different (an AECi-verified vendor *account*, not a claim's
 * agreement). Keeping the shapes distinct is what stops the two being read as
 * the same signal.
 */
@Component({
  selector: 'aec-agreement-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border px-2.5 py-1
        text-[0.75rem] font-medium tracking-[0.01em]"
      [class]="toneClass()"
      [attr.aria-label]="ariaLabel()"
    >
      @if (agreement() === 'conflict') {
        <!-- A shape, not just a hue: the conflict state must survive both
             greyscale and a colour-vision deficiency. -->
        <svg
          aria-hidden="true"
          class="h-3 w-3 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
        >
          <path d="M7 7l10 10M17 7L7 17" />
        </svg>
      } @else {
        <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full" [class]="dotClass()"></span>
      }
      {{ label() }}
    </span>
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

  protected readonly label = computed<string>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return $localize`:@@pair.claim.badge.confirmed:Both vendors confirmed`;
      case 'single_source': {
        const vendor = this.attributedTo();
        return vendor
          ? $localize`:@@pair.claim.badge.singleSource:Confirmed by ${vendor}:vendor:`
          : $localize`:@@pair.claim.badge.singleSource.unattributed:Confirmed by one vendor`;
      }
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict:Vendors disagree`;
      default:
        return $localize`:@@pair.claim.badge.unverified:Unverified · AECi`;
    }
  });

  protected readonly ariaLabel = computed<string>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return $localize`:@@pair.claim.badge.confirmed.aria:Confirmed by both vendors.`;
      case 'single_source': {
        const vendor = this.attributedTo();
        // The counterparty's silence is stated, never left to be inferred.
        return vendor
          ? $localize`:@@pair.claim.badge.singleSource.aria:Confirmed by ${vendor}:vendor:. The other vendor has not responded.`
          : $localize`:@@pair.claim.badge.singleSource.unattributed.aria:Confirmed by one vendor. The other vendor has not responded.`;
      }
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict.aria:The two vendors describe this data flow differently.`;
      default:
        return $localize`:@@pair.claim.badge.unverified.aria:Unverified. Asserted by AECi, not yet vendor-confirmed.`;
    }
  });

  /** Border + ground + text per state. Only `conflict` is red; only `confirmed`
   *  gets the Forest wash. `unverified` and `single_source` share the neutral
   *  chip — by design, so a lone affirmation cannot read as agreement. */
  protected readonly toneClass = computed<string>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return 'border-(--accent-primary) bg-(--accent-primary-soft) text-(--accent-primary)';
      case 'conflict':
        return 'border-(--status-error) bg-(--surface-base) text-(--status-error)';
      default:
        return 'border-(--border-default) bg-(--surface-raised) text-(--text-secondary)';
    }
  });

  /** `single_source` uses a stronger dot than `unverified` — the one visual
   *  difference between the two neutral states, so "a vendor has spoken" reads
   *  without promoting it to the affirmative treatment. */
  protected readonly dotClass = computed<string>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return 'bg-(--accent-primary)';
      case 'single_source':
        return 'bg-(--text-secondary)';
      default:
        return 'bg-(--text-tertiary)';
    }
  });
}
