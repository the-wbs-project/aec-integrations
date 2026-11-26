import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ChecklistStepStatus } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { AecCard } from '../../shared/card/card';
import { Chip } from '../../shared/chip/chip';
import { AecIcon } from '../../shared/icon/icon';

import { VendorDocsLink } from './vendor-docs-link';
import { VendorLooksRight, type LooksRightTarget } from './vendor-looks-right';
import { latchReviewDecisions, type ReviewLatchEntry } from './vendor-review-strip';

/** What a checklist row offers the vendor. */
export type ChecklistAction =
  | { readonly kind: 'link'; readonly label: string; readonly commands: readonly string[] }
  | {
      readonly kind: 'looksRight';
      readonly target: LooksRightTarget;
      readonly productId: string | null;
      readonly productName: string | null;
      /** A secondary link beside the button, e.g. to the form behind it. */
      readonly link: { readonly label: string; readonly commands: readonly string[] } | null;
    }
  /** Plain text, for a step the plan does not include ("Available on Managed"). */
  | { readonly kind: 'note'; readonly label: string };

type LooksRightAction = Extract<ChecklistAction, { kind: 'looksRight' }>;

/** The latch key for one control: the step's target on its product (or the company). */
function looksRightRecord(action: LooksRightAction): string {
  return `${action.target}:${action.productId ?? 'company'}`;
}

/** One step, already worded. The caller maps the API's step key to copy. */
export interface ChecklistRow {
  readonly key: string;
  readonly title: string;
  readonly body: string;
  readonly status: ChecklistStepStatus;
  readonly counts: boolean;
  /** The step is outside this product's plan: a lock replaces the number. */
  readonly locked: boolean;
  readonly action: ChecklistAction | null;
}

/**
 * A checklist card (AECI-1218, `STAGE_2_PAID_TIERS_SPEC.md` §13.10): the vendor
 * one on Vendor Overview and the product one on each product's overview.
 *
 * Presentational. The score is the server's (`done` of `total`, counted steps
 * only), never re-derived here, so a product reads "x of 4" exactly when the API
 * says it does (on every plan since AECI-2038).
 *
 * Anchor: the in-repo mockup (`docs/design/mockups/free-plan-portal/`) and the
 * DoorDash Merchant "Get ready to go live" setup list on Mobbin: numbered steps,
 * one action each, the optional step marked in words. The segment bar is
 * decoration (`aria-hidden`); the "x of y done" text carries the score.
 *
 * AECI-1241: a "Looks right" row offers the button only when its step was not
 * done the first time this card saw it. A row pressed in this view keeps the
 * button and its "Checked" mark until the vendor leaves. The row itself, and
 * any link beside the button, always render. The rule is
 * `latchReviewDecisions` in `vendor-review-strip.ts`, the one the page strips use.
 */
@Component({
  selector: 'aec-vendor-checklist',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, AecButton, AecCard, AecIcon, Chip, VendorDocsLink, VendorLooksRight],
  template: `
    <section aecCard class="block p-6" [attr.aria-labelledby]="headingId()">
      <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        @if (headingLevel() === 2) {
          <!-- The card title size: the global h2 is 24px, so the 20px sits on a span. -->
          <h2 [id]="headingId()">
            <span class="text-t-20">{{ heading() }}</span>
          </h2>
        } @else {
          <h3 [id]="headingId()">{{ heading() }}</h3>
        }
        <p
          class="text-t-13 whitespace-nowrap text-(--text-secondary)"
          data-testid="checklist-score"
        >
          {{ scoreLine() }}
        </p>
      </div>
      @if (lede(); as l) {
        <p class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)">{{ l }}</p>
      }
      <p class="mt-1"><aec-vendor-docs-link page="checklists" /></p>

      <div aria-hidden="true" class="mt-4 flex gap-1">
        @for (seg of segments(); track $index) {
          <span
            [class]="
              'h-2 flex-1 rounded-full ' + (seg ? 'bg-(--accent-primary)' : 'bg-(--border-default)')
            "
          ></span>
        }
      </div>

      <ol class="m-0 mt-2 list-none divide-y divide-(--border-default) p-0">
        @for (row of rows(); track row.key; let i = $index) {
          <li class="flex flex-col gap-2 py-4" [attr.data-step]="row.key">
            <div class="flex min-w-0 items-start gap-3">
              <span [class]="markerClass(row)" aria-hidden="true">
                @if (row.status === 'done') {
                  <aec-icon name="check" decorative [size]="3.5" />
                } @else if (row.locked) {
                  <aec-icon name="lock" decorative [size]="3.5" />
                } @else {
                  {{ i + 1 }}
                }
              </span>
              <div class="min-w-0">
                <p
                  class="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-(--text-primary)"
                >
                  <span>{{ row.title }}</span>
                  @if (!row.counts) {
                    &ngsp;<aec-chip density="dense" i18n="@@vendor.checklist.optional"
                      >Optional</aec-chip
                    >
                  }
                  <span class="sr-only">&ngsp;{{ statusText(row.status) }}</span>
                </p>
                <p class="text-sm leading-relaxed text-(--text-secondary)">{{ row.body }}</p>
              </div>
            </div>
            @if (row.action; as a) {
              <div class="flex flex-wrap items-center gap-3 ps-10">
                @switch (a.kind) {
                  @case ('link') {
                    <a aecButton variant="secondary" compact [routerLink]="a.commands">{{
                      a.label
                    }}</a>
                  }
                  @case ('looksRight') {
                    @if (a.link; as l) {
                      <a [routerLink]="l.commands" [class]="textLinkClass">{{ l.label }}</a>
                    }
                    @if (looksRightShown(a)) {
                      <aec-vendor-looks-right
                        [target]="a.target"
                        [productId]="a.productId"
                        [productName]="a.productName"
                        [done]="row.status === 'done'"
                      />
                    }
                  }
                  @case ('note') {
                    <aec-chip density="dense">{{ a.label }}</aec-chip>
                  }
                }
              </div>
            }
          </li>
        }
      </ol>
    </section>
  `,
  styles: [':host { display: block; }'],
})
export class VendorChecklist {
  readonly heading = input.required<string>();
  readonly headingId = input.required<string>();
  readonly headingLevel = input<2 | 3>(2);
  readonly lede = input<string | null>(null);
  readonly rows = input.required<readonly ChecklistRow[]>();
  readonly done = input.required<number>();
  readonly total = input.required<number>();

  /** AECI-1241: which "Looks right" controls this card offers, keyed by record. */
  private readonly looksRightLatch = linkedSignal<
    readonly ReviewLatchEntry[],
    ReadonlyMap<string, boolean>
  >({
    source: () =>
      this.rows().flatMap((row) =>
        row.action?.kind === 'looksRight'
          ? [
              {
                record: looksRightRecord(row.action),
                state: row.status === 'done' ? ('done' as const) : ('todo' as const),
              },
            ]
          : [],
      ),
    computation: (next, prev) => latchReviewDecisions(prev?.value, next),
  });

  protected looksRightShown(action: LooksRightAction): boolean {
    return this.looksRightLatch().get(looksRightRecord(action)) === true;
  }

  protected readonly scoreLine = computed(
    () => $localize`:@@vendor.checklist.score:${this.done()}:DONE: of ${this.total()}:TOTAL: done`,
  );

  /** One segment per counted step, filled for each done one. */
  protected readonly segments = computed(() =>
    Array.from({ length: this.total() }, (_, i) => i < this.done()),
  );

  protected readonly textLinkClass =
    'rounded-mark text-sm font-semibold text-(--accent-primary) underline underline-offset-2 hover:text-(--accent-primary-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

  protected markerClass(row: ChecklistRow): string {
    const base =
      'inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-t-13 font-semibold';
    if (row.status === 'done') {
      return `${base} border-(--accent-primary) bg-(--accent-primary) text-(--surface-base)`;
    }
    return `${base} border-(--border-strong) bg-(--surface-base) text-(--text-secondary)`;
  }

  protected statusText(status: ChecklistStepStatus): string {
    switch (status) {
      case 'done':
        return $localize`:@@vendor.checklist.status.done:Done`;
      case 'optional':
        return $localize`:@@vendor.checklist.status.optional:Not done, optional`;
      default:
        return $localize`:@@vendor.checklist.status.todo:Not done`;
    }
  }
}
