import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * `NewTabIcon` (AECI-980) — the ONE new-tab cue. Drop it inside any anchor that
 * carries `target="_blank"`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Before AECI-980 the app spelled "this opens a new tab" three ways at once: a
 * `↗` text glyph at eight sites, a hand-inlined Lucide `arrow-up-right` at one
 * (`products/integration-group-card.ts`), and — at seven sites — nothing visible
 * at all. That last group is the defect the others only made hard to see: those
 * links announced the new tab to a screen reader via an `sr-only` span and gave
 * a sighted reader no warning whatsoever. `DESIGN.md` §"Named Rules" → "The Link
 * Treatment Rule" now pins the drawn glyph, and this component is the only place
 * it is drawn.
 *
 * The `↗` spelling had a second problem. `DESIGN.md`'s Arrow Rule reserves arrow
 * characters for data-flow direction, and the pair page rendered `↗` in the same
 * card as the `→`/`←`/`⇄` a mechanism earned. Two arrows, two unrelated meanings,
 * one card. A drawn icon cannot be mistaken for the direction vocabulary.
 *
 * ── THE ANNOUNCEMENT MOVED INSIDE THE ANCHOR, DELIBERATELY ──────────────────
 * The `sr-only` note rides along here, which puts it INSIDE the anchor rather
 * than beside it. That is a fix, not an accident. A sibling span is not read in a
 * VoiceOver rotor or an `NVDA+F7` links list, so the old placement disclosed the
 * new tab in browse mode and nowhere else. Inside the anchor it becomes part of
 * the accessible name, which is what `DESIGN.md` §"Disclosure group card" asked
 * for all along.
 *
 * It also deletes a conditional. A caller-supplied `aria-label` on the anchor
 * REPLACES the anchor's contents for assistive tech, so this span is simply not
 * announced when a name is present — no `@if (!ariaLabel())` guard is needed to
 * stop it being read twice. Callers that pass a name must still state the new tab
 * in that name themselves; nothing here can do it for them.
 *
 * `label` exists for the rare anchor whose visible text already says "new tab" or
 * "new window" in its own words; pass `null` to suppress the note entirely.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-new-tab-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Lucide arrow-up-right. The rtl:-scale-x-100 utility is there because the
         cue points away from the start of the line, which flips with direction. -->
    <svg
      aria-hidden="true"
      class="h-3.5 w-3.5 shrink-0 rtl:-scale-x-100"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M7 7h10v10" />
      <path d="M7 17 17 7" />
    </svg>
    @if (announce()) {
      <span class="sr-only" i18n="@@shared.newTabIcon.label">(opens in a new tab)</span>
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class NewTabIcon {
  /**
   * Whether to carry the `sr-only` "(opens in a new tab)" note. Default true.
   * Set false only when the anchor's own visible text already says so — NOT to
   * silence it under a caller-supplied `aria-label`, which suppresses it anyway.
   */
  readonly announce = input(true);
}
