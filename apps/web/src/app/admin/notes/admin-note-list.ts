import { Component, computed, input } from '@angular/core';

import type { AdminNote, AdminNoteCode } from '@aeci/shared';

/**
 * The honesty envelope, rendered — AECI-578 / Phase 8.3 P1.4.
 * `docs/ADMIN_PANEL_SPEC.md` §1.1, §6; contract in
 * `packages/shared/src/api/admin-panel.ts`.
 *
 * Every admin read carries an array of `AdminNote`s naming the biases that apply
 * to *that* window. This component turns them into prose.
 *
 * ─── Why the localization lives here and not on the wire ─────────────────────
 *
 * The contract is explicit that **`code` is the contract and `message` is a
 * fallback**: `message` is untranslated operator text for curl and logs, and the
 * UI is expected to localize from `code` + `params`. That is what lets §1.1's
 * "machine-readable notes rather than the UI hardcoding prose" coexist with
 * CLAUDE.md's unconditional i18n rule — the API ships semantics, the UI ships
 * strings.
 *
 * So this `switch` is the single place those strings exist. It is shared rather
 * than inlined into the Traffic page because AECI-576 (Overview) and AECI-580
 * (System) render the same envelope, and three copies would drift.
 *
 * **An unknown code falls back to `message`.** The vocabulary is additive by
 * design — the API can ship a new code before the UI has a string for it — and an
 * untranslated caveat is strictly better than a swallowed one. A caveat that
 * silently disappears is the exact failure §1.1 exists to prevent.
 */
@Component({
  selector: 'aec-admin-note-list',
  template: `
    @if (notes().length > 0) {
      <ul class="space-y-1.5">
        @for (note of decorated(); track note.key) {
          <li
            class="flex gap-2 rounded-(--radius-md) border px-3 py-2 text-xs leading-relaxed"
            [class]="note.tone"
          >
            <span aria-hidden="true">{{ note.glyph }}</span>
            <span>
              <span class="sr-only">{{ note.severityLabel }}</span>
              {{ note.text }}
            </span>
          </li>
        }
      </ul>
    }
  `,
  styles: [':host { display: block; }'],
})
export class AdminNoteList {
  readonly notes = input.required<readonly AdminNote[]>();

  protected readonly decorated = computed(() =>
    this.notes().map((note, i) => ({
      key: `${note.code}-${i}`,
      text: this.text(note),
      glyph: note.severity === 'warn' ? '!' : 'i',
      severityLabel:
        note.severity === 'warn'
          ? $localize`:@@admin.notes.srWarn:Warning:`
          : $localize`:@@admin.notes.srInfo:Note:`,
      // Clay deep is the warning hue (DESIGN.md); info stays neutral. Severity is
      // never colour-alone — the glyph and the screen-reader label carry it too.
      tone:
        note.severity === 'warn'
          ? 'border-(--accent-secondary-deep)/30 bg-(--accent-warm) text-(--text-primary)'
          : 'border-(--border-default) bg-(--surface-raised) text-(--text-secondary)',
    })),
  );

  private text(note: AdminNote): string {
    // `rows`, not `count` — both note codes that interpolate a number send their
    // row count under that key (`trafficNotes` in apps/api/src/lib/admin-analytics.ts).
    const count = String(note.params?.['rows'] ?? '');
    switch (note.code as AdminNoteCode) {
      case 'partial_day':
        return $localize`:@@admin.notes.partialDayWindow:This window includes the current UTC day, so its last bucket is still filling.`;
      case 'bot_classification_incomplete':
        return $localize`:@@admin.notes.botIncomplete:${count}:COUNT: views in this window have no bot classification and are counted as human. The figure is an upper bound.`;
      case 'referrer_source_incomplete':
        return $localize`:@@admin.notes.referrerIncomplete:${count}:COUNT: human views in this window have no traffic source. The header was never stored, so this is not backfillable.`;
      case 'direct_is_mixed_bucket':
        return $localize`:@@admin.notes.directMixed:“Direct” mixes true direct arrivals with in-app navigation: a same-origin referrer classifies as direct, so the two are indistinguishable here.`;
      case 'visitor_definition_approximate':
        return $localize`:@@admin.notes.visitorApproximate:A visitor is a distinct browser-and-network pair. It over-counts when a browser updates and under-counts behind shared networks.`;
      case 'catalog_series_is_additions_only':
        return $localize`:@@admin.notes.catalogAdditions:This series counts creation events, not net totals. Rows removed later still count on the day they were added.`;
      case 'catalog_series_starts_at':
        return $localize`:@@admin.notes.catalogStartsAt:The audit log begins after this window starts, so the leading days read zero for want of data, not for want of activity.`;
      case 'internal_filter_unavailable':
        return $localize`:@@admin.notes.internalUnavailable:Internal-traffic filtering is not configured, so only unfiltered figures are shown.`;
      case 'internal_filter_applied':
        return $localize`:@@admin.notes.internalApplied:Internal-traffic filtering is applied. Both the unfiltered and the filtered figure are shown.`;
      case 'requires_recompute':
        return $localize`:@@admin.notes.requiresRecomputeSkipped:Some status items were skipped because they need network calls. Re-request with recompute to include them.`;
      case 'algolia_credentials_absent':
        return $localize`:@@admin.notes.algoliaAbsent:Algolia credentials are not configured, so index drift could not be measured.`;
      case 'series_partly_reconstructed':
        // AECI-581 / P2.1. The days named in `params` are marked per point in the
        // payload too; this is the prose half of the same caveat.
        return $localize`:@@admin.notes.seriesReconstructed:Part of this series predates the daily snapshot and was reconstructed from the audit log afterwards. Read the earlier segment as approximate, not measured.`;
      // AECI-586 / P5.1 — audience.
      case 'utm_attribution_incomplete': {
        // This code sends `missing`, not `rows` — the local `count` above is the
        // other codes' key and does not apply.
        const missing = String(note.params?.['missing'] ?? '');
        const total = String(note.params?.['total'] ?? '');
        return $localize`:@@admin.notes.utmIncomplete:${missing}:MISSING: of ${total}:TOTAL: signups in this window arrived with no campaign parameters. They are real signups grouped under “Unattributed”, not missing records.`;
      }
      case 'audience_history_is_current_state':
        return $localize`:@@admin.notes.audienceCurrentState:Churn is computed from each subscriber’s opt-out timestamp, so it is exact rather than estimated. The one thing it cannot see is a return: resubscribing clears that timestamp, so anyone who opted out and came back reads as never having left.`;
      default:
        // Unknown code — an API newer than this build. Show the operator text
        // rather than dropping the caveat.
        return note.message;
    }
  }
}
