import { OverlayModule, type ConnectedPosition } from '@angular/cdk/overlay';
import { formatDate } from '@angular/common';
import { Component, DestroyRef, LOCALE_ID, computed, inject, input, signal } from '@angular/core';

import { relativeSpan } from './relative-time-format';

/**
 * A timestamp rendered compactly ("4h", "2d") with the exact instant one hover
 * away (AECI-694).
 *
 * ── WHY COMPACT AT ALL ───────────────────────────────────────────────────────
 * Built for the audit trail, where "how long ago" is the question actually being
 * asked: an operator scanning a ledger is reading recency, not booking a
 * meeting. A column of `2026-08-27T14:32:11.402Z` (which is literally what that
 * screen printed before this) answers a question nobody had. It is deliberately
 * NOT used for the console's other timestamps, which stay absolute.
 *
 * ── THE ACCESSIBLE NAME IS THE FULL DATETIME ─────────────────────────────────
 * The info control's accessible name IS the formatted instant, so assistive tech
 * gets the precise value directly from the button and never depends on a
 * transient overlay being mounted. The panel is therefore `aria-hidden` rather
 * than an `aria-describedby` target: describing the button with text identical
 * to its own name buys a double announcement and nothing else. Sighted users get
 * the panel on hover, focus, or click; keyboard users reach the same string by
 * tabbing to the button.
 *
 * ── WHY AN OVERLAY AND NOT A CSS TOOLTIP ─────────────────────────────────────
 * The repo's cheap tooltip (`home/home-why.ts`) is an absolutely-positioned span
 * revealed by `group-hover`. It cannot be used here: every table this renders in
 * sits inside `overflow-x-auto`, which clips an in-flow panel. A
 * `cdkConnectedOverlay` portals out of that box. Same mechanism, same hover
 * grace timer, and the same reason as the toxicity legend on `/admin/reviews`:
 * an overlay rather than a dialog, so revealing it never moves focus.
 *
 * ── `now` IS CAPTURED ONCE ───────────────────────────────────────────────────
 * At construction, never in the template (`new Date()` at render is banned by
 * ANGULAR_STYLE_GUIDE.md §8, and a ticking clock would churn change detection
 * across every row). The console has no live updates by design
 * (`ADMIN_PANEL_SPEC.md` §5.7), so the stamp is as fresh as the fetch that
 * produced the row, which is the honest granularity. Admin screens fetch in
 * `afterNextRender`, so no instance of this exists during SSR and there is no
 * hydration mismatch to worry about.
 */
@Component({
  selector: 'aec-relative-time',
  imports: [OverlayModule],
  templateUrl: './relative-time.html',
  host: { class: 'inline-flex items-center gap-1 whitespace-nowrap' },
})
export class RelativeTime {
  /** An ISO-8601 instant. Unparseable input renders verbatim rather than
   *  throwing: see `relativeSpan`'s note on unpruned historical rows. */
  readonly value = input.required<string>();

  private readonly locale = inject(LOCALE_ID);
  private readonly destroyRef = inject(DestroyRef);

  /** Read once. See the class doc. */
  private readonly now = Date.now();

  protected readonly open = signal(false);

  /**
   * Below the control with a 6px gap, opening toward the end edge; falls back to
   * above, and then to the mirrored pair when there is no room that way.
   *
   * **Start-aligned FIRST, unlike the `/admin/reviews` legend.** That legend
   * hangs off a badge on the right of a card, so end-alignment is its natural
   * side. This renders in the leftmost column of a table, where an end-aligned
   * panel runs straight off the left edge of the viewport. All four are listed
   * so the CDK can flip on both axes rather than clipping.
   */
  protected readonly positions: ConnectedPosition[] = [
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 6 },
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -6 },
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];

  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => {
      if (this.closeTimer) clearTimeout(this.closeTimer);
    });
  }

  private readonly span = computed(() => relativeSpan(this.value(), this.now));

  /** The compact label. Falls back to the raw string when the instant could not
   *  be parsed, so a malformed row still shows what it actually holds. */
  protected readonly short = computed(() => {
    const span = this.span();
    if (!span) return this.value();

    const n = span.value;
    let label: string;
    switch (span.unit) {
      case 'now':
        return $localize`:@@shared.relativeTime.now:now`;
      case 'minute':
        label = $localize`:@@shared.relativeTime.minutes:${n}:VALUE:m`;
        break;
      case 'hour':
        label = $localize`:@@shared.relativeTime.hours:${n}:VALUE:h`;
        break;
      case 'day':
        label = $localize`:@@shared.relativeTime.days:${n}:VALUE:d`;
        break;
      case 'week':
        label = $localize`:@@shared.relativeTime.weeks:${n}:VALUE:w`;
        break;
      case 'month':
        label = $localize`:@@shared.relativeTime.months:${n}:VALUE:mo`;
        break;
      case 'year':
        label = $localize`:@@shared.relativeTime.years:${n}:VALUE:y`;
        break;
    }
    return span.future ? $localize`:@@shared.relativeTime.future:in ${label}:SPAN:` : label;
  });

  /**
   * The exact instant, and the control's accessible name.
   *
   * UTC and labelled as such, matching every other timestamp in the console.
   * An operator correlating a row against a Worker log or a cron window is
   * reading UTC on the other side; silently localising here would make the two
   * disagree by an offset nobody stated.
   */
  protected readonly full = computed(() => {
    if (!this.span()) return this.value();
    const stamp = formatDate(this.value(), 'medium', this.locale, 'UTC');
    return $localize`:@@shared.relativeTime.exact:${stamp}:STAMP: UTC`;
  });

  protected toggle(): void {
    this.cancelClose();
    this.open.update((v) => !v);
  }

  protected show(): void {
    this.cancelClose();
    this.open.set(true);
  }

  /** Grace period so the pointer can travel from the control onto the panel
   *  without it flickering shut. */
  protected scheduleClose(): void {
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.open.set(false), 120);
  }

  protected close(): void {
    this.cancelClose();
    this.open.set(false);
  }

  private cancelClose(): void {
    if (this.closeTimer) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }
}
