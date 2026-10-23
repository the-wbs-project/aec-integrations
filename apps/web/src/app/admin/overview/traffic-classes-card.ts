import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import type { AdminClassificationSummary } from '@aeci/shared';

import { type NotComparableReason, statDeltaText } from './stat-tile';
import { TRAFFIC_CLASS_FILLS, TRAFFIC_CLASS_ORDER, trafficClassLabel } from './traffic-classes';

/**
 * AECI-1346 — the Overview's lead card: the reported day's page requests in the
 * four D19 traffic classes (`docs/ADMIN_PANEL_SPEC.md` §5.1, §13 D19).
 *
 * The rules it carries, each from D19:
 *
 * - **Every figure names its basis** (D19(a)). The basis line says "requests, not
 *   people" under the heading, before any number.
 * - **Internal traffic is its own line, never inside a class** (D19(b)). It sits
 *   under a rule, after the four classes, in body text rather than a figure.
 * - **A day that was not classified shows no counts** (D19(c), §3c step 5). The
 *   API sends four zeros with a null version; the card shows "Not classified"
 *   and never those zeros.
 * - **A delta the API declined is "Not comparable", with the reason** the page
 *   can read from the series. It is never dropped and never "no change".
 *
 * Layout follows the breakdown row of Klaviyo's "Business performance summary"
 * card (Mobbin anchor, recorded in AECI-1346): a heading with its metadata, then
 * one cell per category with the count first. Drawn in the console's own card
 * vocabulary (bordered `--surface-raised`, Forest figures, `tabular-nums`), per
 * the Anchor-Site Rule. Each class name carries the chart's swatch, so the card
 * doubles as the key for the 30-day chart below it.
 *
 * The rows are a `<dl>`, not headings: the page allows no level below `h3`.
 */
@Component({
  selector: 'aec-traffic-classes-card',
  imports: [DecimalPipe],
  template: `
    <section
      aria-labelledby="admin-overview-classes-heading"
      class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-5"
    >
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3
          id="admin-overview-classes-heading"
          class="text-sm font-bold text-(--text-primary)"
          i18n="@@admin.overview.classes.heading"
        >
          Traffic by class
        </h3>
        <!-- The version is part of what the numbers mean (D19(c)), so it sits
             beside the heading rather than in a footnote. Neutral chip: it is
             metadata, not a status. -->
        <span
          data-classifier-version
          class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
            bg-(--surface-base) px-2.5 py-1 text-xs font-medium tracking-[0.01em]
            text-(--text-secondary)"
        >
          @if (summary().classifier_version; as v) {
            <ng-container i18n="@@admin.overview.classes.version">Classifier {{ v }}</ng-container>
          } @else {
            <ng-container i18n="@@admin.overview.classes.notClassifiedChip"
              >Not classified</ng-container
            >
          }
        </span>
        <span class="ms-auto text-xs text-(--text-secondary)" i18n="@@admin.overview.classes.day"
          >UTC day {{ day() }}</span
        >
      </div>

      <p class="mt-1 text-xs text-(--text-secondary)" i18n="@@admin.overview.classes.basis">
        Requests, not people. Each figure counts page requests; a visitor is a distinct
        browser-and-network pair.
      </p>

      @if (classified()) {
        <!-- Each cell is a subgrid over five shared rows (name, figure, visitors,
             delta, caveat), so a class name that wraps to two lines does not push
             its figure below its neighbours' figures. -->
        <dl class="mt-5 grid gap-x-6 gap-y-6 sm:grid-cols-2 xl:grid-cols-4">
          @for (row of rows(); track row.cls) {
            <div
              [attr.data-class]="row.cls"
              class="row-span-5 grid grid-rows-subgrid content-start gap-y-1"
            >
              <dt class="flex items-start gap-1.5 self-end text-sm text-(--text-secondary)">
                <span
                  class="mt-1.5 inline-block size-2.5 shrink-0 rounded-[2px]"
                  [style.background-color]="row.fill"
                  aria-hidden="true"
                ></span>
                {{ row.label }}
              </dt>
              <dd class="font-display text-3xl font-semibold tabular-nums text-(--accent-primary)">
                {{ row.views | number }}
              </dd>
              <dd class="text-sm tabular-nums text-(--text-secondary)">
                <ng-container i18n="@@admin.overview.classes.visitors"
                  >Visitors: {{ row.visitors | number }}</ng-container
                >
              </dd>
              <dd data-delta class="text-sm text-pretty tabular-nums text-(--text-secondary)">
                {{ row.delta }}
              </dd>
              @if (row.cls === 'browser_with_human_evidence') {
                <!-- The heuristic caveat sits with the figure it qualifies, not in
                     a footer (D19, classification_is_heuristic). -->
                <dd
                  data-heuristic
                  class="mt-1 text-xs leading-relaxed text-pretty text-(--text-secondary)"
                  i18n="@@admin.overview.classes.heuristic"
                >
                  A heuristic: our app ran and nothing contradicted it. It does not prove a person
                  was there.
                </dd>
              }
            </div>
          }
        </dl>

        <!-- D19(b): internal traffic BESIDE the classes, never inside one. A rule
             and body text, not a fifth figure, so it cannot be read as a class. -->
        <p
          data-internal
          class="mt-5 border-t border-(--border-default) pt-4 text-sm tabular-nums
            text-(--text-secondary)"
        >
          <ng-container i18n="@@admin.overview.classes.internal"
            >Internal traffic, counted beside the classes and never inside one:
            {{ summary().internal_excluded.views | number }}. Operator self-traffic inferred on a
            lapsed session:
            {{ summary().internal_excluded.operator_leak_inferred | number }}.</ng-container
          >
        </p>
      } @else {
        <!-- D19(c): an unclassified day has no counts. Four zeros would claim a
             measurement that never happened. -->
        <p
          data-not-classified
          class="mt-5 text-sm text-(--text-primary)"
          i18n="@@admin.overview.classes.notClassified"
        >
          The classifier did not run for this day, so there are no class counts. Nothing is shown as
          zero.
        </p>
      }
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class TrafficClassesCard {
  readonly summary = input.required<AdminClassificationSummary>();
  /** The reported UTC day, `YYYY-MM-DD`. */
  readonly day = input.required<string>();
  /** Why the class deltas are null, when the page can tell. */
  readonly notComparable = input<NotComparableReason | undefined>(undefined);

  /** The API's own signal: a null version means nothing was classified. */
  protected readonly classified = computed(() => this.summary().classifier_version !== null);

  protected readonly rows = computed(() => {
    const byClass = new Map(this.summary().counts.map((c) => [c.class, c]));
    const reason = this.notComparable();
    return TRAFFIC_CLASS_ORDER.map((cls) => {
      const c = byClass.get(cls);
      return {
        cls,
        label: trafficClassLabel(cls),
        fill: TRAFFIC_CLASS_FILLS[cls],
        views: c?.views ?? 0,
        visitors: c?.visitors ?? 0,
        delta: statDeltaText({ delta: c?.delta_day ?? null, notComparable: reason }),
      };
    });
  });
}
