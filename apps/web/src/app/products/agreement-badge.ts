import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { AgreementState } from '@aeci/shared';

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
 * This claim-agreement chip remains distinct from the account-status label
 * through its state-specific wording and tone.
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
        return $localize`:@@pair.claim.badge.confirmed:Confirmed by both companies`;
      case 'single_source': {
        const vendor = this.attributedTo();
        return vendor
          ? $localize`:@@pair.claim.badge.singleSource:Confirmed by ${vendor}:vendor:`
          : $localize`:@@pair.claim.badge.singleSource.unattributed:Confirmed by one company`;
      }
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict:Companies disagree`;
      default:
        return $localize`:@@pair.claim.badge.unverified:Listed by AEC Integrations`;
    }
  });

  protected readonly ariaLabel = computed<string>(() => {
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
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict.aria:The two companies disagree about this.`;
      default:
        // The visible label says who listed it. The accessible name also says what
        // is missing, so "listed" is never heard as an endorsement.
        return $localize`:@@pair.claim.badge.unverified.aria:Listed by AEC Integrations from public sources. Neither company has confirmed it yet.`;
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
