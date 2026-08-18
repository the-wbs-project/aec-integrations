import { formatDate } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  LOCALE_ID,
  output,
} from '@angular/core';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import type { ClaimTimeline, PairClaimAttestation, ProductPairClaim } from '@aeci/shared';

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
      (click)="historyRequested.emit()"
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

          <!-- AECI-303 (§9.1): the append-only history, rendered ONLY once the lazy
               fetch has landed entries for this claim. Absent otherwise, so a claim
               with no version data leaves this popover byte-identical to before. -->
          @if (historyEntries().length > 0) {
            <div class="space-y-2 border-t border-(--border-default) pt-3">
              <h3
                class="text-xs font-semibold tracking-[0.14em] text-(--text-tertiary) uppercase"
                i18n="@@pair.claim.history.title"
              >
                History
              </h3>
              <!-- <ol>: the order is meaningful (oldest first). Capped + scrollable
                   because the log is unbounded in principle. -->
              <ol class="max-h-[16rem] list-none space-y-2 overflow-y-auto">
                @for (h of historyEntries(); track h.key) {
                  <li class="space-y-0.5">
                    <p class="text-sm text-(--text-primary)">
                      {{ h.who }}
                      <span
                        class="font-normal"
                        [class]="h.affirms ? 'text-(--text-secondary)' : 'text-(--status-error)'"
                        >{{ h.stance }}</span
                      >
                    </p>
                    @if (h.versionSpan) {
                      <p class="text-xs text-(--text-secondary)">{{ h.versionSpan }}</p>
                    }
                    <!-- The note is the substance of a position, so it belongs in
                         the history too. It duplicates the Provenance section above
                         for the ONE live row, which is honest rather than redundant:
                         that row is both the current state and the latest entry. -->
                    @if (h.note) {
                      <p class="text-xs leading-relaxed text-(--text-secondary)">{{ h.note }}</p>
                    }
                    <p class="text-xs text-(--text-tertiary)">
                      <time [attr.datetime]="h.isoDate" [attr.title]="h.exactUtc">{{
                        h.date
                      }}</time>
                      @if (h.superseded) {
                        <span> · {{ h.superseded }}</span>
                      }
                    </p>
                  </li>
                }
              </ol>
              @if (hiddenHistoryCount() > 0) {
                <p class="text-xs text-(--text-tertiary)">{{ hiddenHistoryLabel() }}</p>
              }
            </div>
          }
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

  /**
   * This claim's append-only history (AECI-303 / §9.1), or `null` until the parent's
   * lazy fetch lands. `null` renders no History section at all, so a claim with no
   * version data — and every claim before the first popover open — keeps the exact
   * DOM this component had before AECI-303.
   */
  readonly timeline = input<ClaimTimeline | null>(null);

  /**
   * Fired on trigger click so the parent can fetch the pair's histories once.
   * A click, never an `effect()`: this trigger opens a `BrnPopover`, and Spartan's
   * `open()` calls `effect()` internally, which throws NG0602 from a reactive context.
   */
  readonly historyRequested = output<void>();

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

  /** Widens only when a history exists, so the default string is unchanged. */
  protected readonly ariaLabel = computed<string>(() => {
    const name = this.claim().data_object_name;
    return this.historyEntries().length > 0
      ? $localize`:@@pair.claim.provenance.aria.withHistory:Provenance and history for ${name}:name:`
      : $localize`:@@pair.claim.provenance.aria:Provenance for ${name}:name:`;
  });

  // ── AECI-303 (§9.1): the append-only history ───────────────────────────────

  /**
   * How many entries render before the "+N earlier" line. The popover is
   * `w-[min(90vw,20rem)]` and the attestation log is unbounded in principle, so a cap
   * is not cosmetic.
   */
  private static readonly MAX_HISTORY_ENTRIES = 8;

  private readonly locale = inject(LOCALE_ID);

  /**
   * The most recent `MAX_HISTORY_ENTRIES`, oldest-first within that window (the API
   * already orders the whole log oldest-first, so this takes the tail and keeps it).
   */
  protected readonly historyEntries = computed<HistoryEntry[]>(() => {
    const entries = this.timeline()?.entries ?? [];
    const window = entries.slice(-ClaimProvenance.MAX_HISTORY_ENTRIES);
    return window.map((e, index) => ({
      key: `${e.created_at}|${index}`,
      who: this.who(e.attestor),
      stance: e.asserted
        ? $localize`:@@pair.claim.provenance.stance.affirms:asserts this flow`
        : $localize`:@@pair.claim.provenance.stance.denies:disputes this flow`,
      affirms: e.asserted,
      note: e.note,
      versionSpan: versionSpanText(e.introduced_version, e.deprecated_version),
      isoDate: e.created_at,
      date: formatUtcDate(e.created_at, this.locale),
      exactUtc: e.created_at,
      superseded: e.retracted_at ? $localize`:@@pair.claim.history.superseded:superseded` : null,
    }));
  });

  protected readonly hiddenHistoryCount = computed(() =>
    Math.max(0, (this.timeline()?.entries.length ?? 0) - ClaimProvenance.MAX_HISTORY_ENTRIES),
  );

  protected readonly hiddenHistoryLabel = computed(() => {
    const count = this.hiddenHistoryCount();
    return $localize`:@@pair.claim.history.more:${count}:count: earlier entries`;
  });
}

/** One rendered history line. */
interface HistoryEntry {
  readonly key: string;
  readonly who: string;
  readonly stance: string;
  readonly affirms: boolean;
  readonly note: string | null;
  readonly versionSpan: string | null;
  readonly isoDate: string;
  readonly date: string;
  readonly exactUtc: string;
  readonly superseded: string | null;
}

/**
 * "2026.1 → 2026.4", or one bound alone. The version **label** is the primary token
 * and the date below is secondary, because the ordering axis is the version, never
 * the nullable `released_at` (§8.2).
 */
function versionSpanText(introduced?: string, deprecated?: string): string | null {
  if (introduced && deprecated) {
    return $localize`:@@pair.claim.history.span:${introduced}:from: → ${deprecated}:to:`;
  }
  if (introduced) return $localize`:@@pair.claim.history.since:Since ${introduced}:from:`;
  if (deprecated) return $localize`:@@pair.claim.history.until:Until ${deprecated}:to:`;
  return null;
}

/**
 * Format a timestamp **pinned to UTC**, per the `maintenance-marker` precedent.
 *
 * Not a style choice: the SSR Worker runs in UTC and the browser does not, so
 * zone-local formatting drifts between the two renders — and for a date-only stamp
 * (`2026-01-15`, which `Date` parses as UTC midnight) ambient-zone formatting shows
 * **January 14** to every reader in the Americas.
 */
function formatUtcDate(value: string, locale: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatDate(parsed, 'MMMM d, y', locale, 'UTC');
}
