import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import type { PairClaimAttestation, ProductPairClaim } from '@aeci/shared';

/** One rendered provenance line: who spoke, what they said, and any note. */
interface ProvenanceEntry {
  readonly key: string;
  readonly who: string;
  readonly stance: string;
  readonly affirms: boolean;
  readonly note: string | null;
}

/**
 * The **provenance affordance** for a claim (Stage 1.5 §8 — AECI-300; widened to
 * the four agreement states by `STAGE_2_ATTESTATIONS_SPEC.md` §4.3 — AECI-605).
 * A small `i` trigger per `data_object` row opens a popover attributing the
 * claim to everyone who has spoken about it, surfacing their notes, and closing
 * with a line that states what is *missing* — the counterparty's silence, or the
 * nature of the disagreement.
 *
 * Attribution comes from each attestation's context-relative `attestor`
 * (`'aeci' | 'context' | 'other'`, resolved server-side by
 * `attestorForContext`) resolved against the two vendor names the pair page
 * already has. The component never re-derives which endpoint is which, and only
 * live attestations reach it — the read path filters `retracted_at IS NULL`, so
 * a withdrawn assertion neither votes nor renders here.
 *
 * `BrnPopover` (Spartan) — the popover surface is the one place a shadow is
 * allowed under DESIGN.md's borders-not-shadows rule. Opened by user click
 * (never from an `effect()` — Spartan's `open()` calls `effect()` internally),
 * keyboard-reachable and Escape-dismissable. Cache-neutral: derives only from
 * the claim payload and the two vendor names.
 */
@Component({
  selector: 'aec-claim-provenance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrnPopover, BrnPopoverContent, BrnPopoverTrigger],
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="provPop"
      type="button"
      class="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full
        text-(--text-tertiary) transition-colors hover:bg-(--surface-sunken)
        hover:text-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-(--accent-primary)"
      [attr.aria-label]="ariaLabel()"
    >
      <span aria-hidden="true" class="text-xs font-semibold">i</span>
    </button>

    <brn-popover #provPop="brnPopover" class="contents" align="end" [sideOffset]="6">
      <ng-template brnPopoverContent>
        <div
          class="w-[min(90vw,20rem)] space-y-3 rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) p-4 text-(--text-primary) shadow-lg"
        >
          <h3
            class="text-xs font-semibold uppercase tracking-[0.14em] text-(--text-tertiary)"
            i18n="@@pair.claim.provenance.title"
          >
            Provenance
          </h3>

          <ul class="space-y-2">
            @for (e of entries(); track e.key) {
              <li class="space-y-1">
                <p class="text-sm font-medium text-(--text-primary)">
                  {{ e.who }}
                  <span
                    class="font-normal"
                    [class]="e.affirms ? 'text-(--text-secondary)' : 'text-(--status-error)'"
                    >{{ e.stance }}</span
                  >
                </p>
                @if (e.note) {
                  <p class="text-sm leading-relaxed text-(--text-secondary)">{{ e.note }}</p>
                }
              </li>
            }
          </ul>

          <p class="text-xs leading-relaxed text-(--text-tertiary)">{{ closing() }}</p>
        </div>
      </ng-template>
    </brn-popover>
  `,
})
export class ClaimProvenance {
  readonly claim = input.required<ProductPairClaim>();

  /** The context product's vendor name, for attributing a `context` attestor.
   *  `null` when the product has no `product_vendors` row — the entry then falls
   *  back to a generic phrasing rather than rendering an empty name. */
  readonly contextVendorName = input<string | null>(null);
  /** The other product's vendor name, for attributing an `other` attestor. */
  readonly otherVendorName = input<string | null>(null);

  /** Resolve one attestation's attributor into display copy. */
  private who(attestor: PairClaimAttestation['attestor']): string {
    switch (attestor) {
      case 'context':
        return (
          this.contextVendorName() ?? $localize`:@@pair.claim.provenance.who.context:This vendor`
        );
      case 'other':
        return this.otherVendorName() ?? $localize`:@@pair.claim.provenance.who.other:The partner`;
      default:
        return $localize`:@@pair.claim.provenance.who.aeci:AECi`;
    }
  }

  protected readonly entries = computed<ProvenanceEntry[]>(() =>
    this.claim().attestations.map((a) => ({
      key: a.source,
      who: this.who(a.attestor),
      stance: a.asserted
        ? $localize`:@@pair.claim.provenance.stance.affirms:asserts this flow`
        : $localize`:@@pair.claim.provenance.stance.denies:disputes this flow`,
      affirms: a.asserted,
      note: a.note,
    })),
  );

  /** The closing line carries the honest part: what nobody has said yet. */
  protected readonly closing = computed<string>(() => {
    switch (this.claim().agreement) {
      case 'confirmed':
        return $localize`:@@pair.claim.provenance.closing.confirmed:Both vendors have confirmed this flow.`;
      case 'single_source': {
        const silent = this.silentVendorName();
        return silent
          ? $localize`:@@pair.claim.provenance.closing.singleSource:${silent}:vendor: has not responded, so this is one vendor's account rather than an agreed one.`
          : $localize`:@@pair.claim.provenance.closing.singleSource.unattributed:The other vendor has not responded, so this is one vendor's account rather than an agreed one.`;
      }
      case 'conflict':
        return $localize`:@@pair.claim.provenance.closing.conflict:The two vendors describe this flow differently. We show both accounts rather than pick one.`;
      default:
        return $localize`:@@pair.claim.provenance.closing:Vendor confirmation is not available yet. It arrives with the vendor portal.`;
    }
  });

  /** For `single_source`: the endpoint that has *not* spoken. Derived from which
   *  side the live attestations came from, so the copy can name the silence. */
  private silentVendorName(): string | null {
    const spoke = new Set(this.claim().attestations.map((a) => a.attestor));
    if (!spoke.has('other')) return this.otherVendorName();
    if (!spoke.has('context')) return this.contextVendorName();
    return null;
  }

  protected readonly ariaLabel = computed<string>(
    () =>
      $localize`:@@pair.claim.provenance.aria:Provenance for ${this.claim().data_object_name}:name:`,
  );
}
