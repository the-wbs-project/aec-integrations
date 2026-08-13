import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { AdminNote, AdminNoteCode } from '@aeci/shared';

/** `AdminNote.params` — string/number values interpolated into the prose. */
type NoteParams = Record<string, string | number> | undefined;

/**
 * The honesty envelope, rendered (AECI-577 / `ADMIN_PANEL_SPEC.md` §1.1).
 *
 * Every admin-panel response carries an `AdminNote[]` naming the biases that
 * apply to *its* window. The API deliberately does not send prose: `code` +
 * `params` are the contract and `message` is an untranslated operator fallback
 * for curl and logs. That split is what lets the spec's "machine-readable notes"
 * requirement coexist with CLAUDE.md's unconditional i18n rule — so this
 * component is where the codes become localized sentences, and it is shared so
 * every panel screen says the same thing about the same caveat.
 *
 * {@link PROSE} is a `Record<AdminNoteCode, …>`, not a `switch`: adding a code to
 * the shared enum then fails the build here rather than silently rendering an
 * empty banner.
 */
@Component({
  selector: 'aec-admin-notes',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let list = visible();
    @if (list.length > 0) {
      <ul
        role="list"
        class="space-y-1.5"
        i18n-aria-label="@@admin.notes.aria"
        aria-label="How to read these numbers"
      >
        @for (n of list; track n.code) {
          <li
            class="flex gap-2 text-xs leading-relaxed"
            [class]="
              n.severity === 'warn' ? 'text-(--accent-secondary-deep)' : 'text-(--text-secondary)'
            "
          >
            <span aria-hidden="true" class="select-none">•</span>
            <span>{{ prose(n) }}</span>
          </li>
        }
      </ul>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdminNotes {
  readonly notes = input<readonly AdminNote[]>([]);

  /** Warnings first — they change how a number should be read, not just how it
   *  was produced. Order within a severity is the API's. */
  protected readonly visible = computed(() =>
    [...this.notes()].sort((a, b) => Number(b.severity === 'warn') - Number(a.severity === 'warn')),
  );

  protected prose(note: AdminNote): string {
    return PROSE[note.code](note.params);
  }
}

/**
 * One localized sentence per code. Each says what the number actually means, not
 * that a flag was set — a caveat the operator cannot act on is noise.
 */
const PROSE: Record<AdminNoteCode, (p: NoteParams) => string> = {
  partial_day: (p) =>
    $localize`:@@admin.notes.partialDay:This window includes today (UTC), so ${String(p?.['day'] ?? '')}:DAY: is still filling.`,

  bot_classification_incomplete: (p) =>
    $localize`:@@admin.notes.botClassificationIncomplete:${Number(p?.['rows'] ?? 0)}:ROWS: views in this window were recorded before bot classification existed, and are counted as human.`,

  referrer_source_incomplete: (p) =>
    $localize`:@@admin.notes.referrerSourceIncomplete:${Number(p?.['rows'] ?? 0)}:ROWS: human views have no recorded source. The referrer was never stored for them, so this cannot be backfilled. They read as unknown, not as Direct.`,

  direct_is_mixed_bucket: () =>
    $localize`:@@admin.notes.directIsMixedBucket:Direct mixes true direct arrivals with in-app navigation, because a same-origin referrer also classifies as Direct.`,

  visitor_definition_approximate: () =>
    $localize`:@@admin.notes.visitorDefinitionApproximate:A visitor is one distinct browser-and-network pair inside the window. That over-counts when a browser updates, and under-counts when several people share a network.`,

  catalog_series_is_additions_only: () =>
    $localize`:@@admin.notes.catalogSeriesIsAdditionsOnly:This series counts additions, not running totals: rows can be removed without leaving a per-row record.`,

  catalog_series_starts_at: (p) =>
    $localize`:@@admin.notes.catalogSeriesStartsAt:The window starts before record-keeping began (${String(p?.['day'] ?? '')}:DAY:), so the earliest days read as zero for want of data, not for want of activity.`,

  internal_filter_unavailable: () =>
    $localize`:@@admin.notes.internalFilterUnavailable:Internal-traffic filtering is not configured, so every figure here is unfiltered.`,

  internal_filter_applied: (p) =>
    $localize`:@@admin.notes.internalFilterApplied:Figures are shown both unfiltered and excluding internal traffic (AS${String(p?.['asns'] ?? '')}:ASNS:). The unfiltered figure is always the primary one.`,

  requires_recompute: () =>
    $localize`:@@admin.notes.requiresRecompute:Some checks were left out because they are slow to run. Re-run them to fill in the gaps.`,

  algolia_credentials_absent: () =>
    $localize`:@@admin.notes.algoliaCredentialsAbsent:Search-index drift could not be measured. The Algolia credentials are not configured on this environment.`,
};
