import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';

import type {
  ContextDirection,
  DataObjectOption,
  VendorClaim,
  VendorIntegration,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { claimOutcomeLine } from '../components/vendor-claim-outcome';
import { VendorApi } from '../vendor-api';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import { IntegrationAnswerForm } from './integration-answer-form';
import {
  changeBoxId,
  companyMidSentence,
  companyOrFallback,
  dataRowId,
  dataSentence,
  deniedRowFor,
  directionShort,
  disagreementItemId,
  formatDay,
  myAnswer,
  myNote,
  noteAudience,
  ownsBoth,
  possessive,
  rowPill,
  submittedChanges,
  theirAnswer,
} from './integration-detail-model';
import { IntegrationDetailState } from './integration-detail-state';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  HELP,
  ID_STYLES,
  LABEL,
  ROW_ACTION,
} from './integration-detail-styles';
import { VendorTip } from './vendor-tip';

/**
 * "Data that's shared" (AECI-1151, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.4).
 *
 * One row per row of data, in the API's order, in a real `<table>` inside a
 * keyboard-focusable scrolling region so it reflows at 320 px.
 *
 * ── YOUR ANSWER ─────────────────────────────────────────────────────────────
 * Two `aria-pressed` toggles, Yes and No:
 * - Yes saves at once, optimistic and rolled back with a visible error, unless the
 *   other company said No: then Yes opens the note form so both sides can explain;
 * - No opens the reason form under the row, and the answer changes only on Save;
 * - pressing the pressed button again clears the answer.
 *
 * Those one-click toggles are for a row the caller has not answered. An answered
 * row shows its answer as plain text and a Change link (AECI-1246): Change reveals
 * the toggles for that row only, and a save or Escape puts it back.
 *
 * ── A SUBMITTED CHANGE ──────────────────────────────────────────────────────
 * "The direction is wrong" leaves a denied row and its correction. The correction
 * is not rendered as its own row: a "You submitted a change" box under the denied
 * row stands for it, with Change and Cancel ({@link submittedChanges}).
 *
 * Answering and adding need `attestation.author`. Without it every answer reads
 * read-only with the portal's access sentence. A connector-powered row is read-only
 * and says why. A retired row is read-only, except that a pressed answer can still
 * be cleared (§4.6.2).
 */
@Component({
  selector: 'aec-integration-shared-data',
  imports: [VendorTip, IntegrationAnswerForm],
  styles: [ID_STYLES],
  template: `
    @let i = integration();
    <div class="flex items-center gap-1">
      <h3
        id="data-shared-heading"
        tabindex="-1"
        class="id-h3 text-(--text-primary) focus:outline-none"
      >
        {{ heading() }}
      </h3>
      <aec-vendor-tip [label]="aboutHeading" [lines]="[headingTip()]" />
      @if (canAdd()) {
        <button
          #addButton
          type="button"
          class="id-icon-btn-bordered ms-auto inline-flex h-8 w-8 items-center justify-center rounded-(--radius-md) text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          [attr.aria-label]="addLabel"
          [attr.aria-expanded]="state.addingRow()"
          aria-controls="data-shared-add"
          data-testid="add-row"
          (click)="toggleAdd()"
        >
          <svg
            aria-hidden="true"
            class="h-4 w-4"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      }
    </div>

    <div id="data-shared-add">
      @if (state.addingRow() && canAdd()) {
        <form
          class="id-well mt-3 space-y-3 p-4 text-sm"
          [attr.aria-label]="addFormLabel"
          (submit)="add($event)"
          data-testid="add-row-form"
        >
          <p id="data-shared-add-how" class="max-w-prose text-(--text-secondary)">
            {{ addHelp() }}
          </p>
          <div class="flex flex-wrap items-end gap-3">
            <div>
              <label for="data-shared-add-type" [class]="label" i18n="@@vendor.im.add.data"
                >Data</label
              >
              <select
                #addFirst
                id="data-shared-add-type"
                class="id-input mt-1 min-w-[12rem]"
                aria-describedby="data-shared-add-how"
                (change)="draftData.set(selectValue($event))"
              >
                @for (option of dataOptions(); track option.slug) {
                  <option [value]="option.slug" [selected]="draftData() === option.slug">
                    {{ option.name }}
                  </option>
                }
              </select>
            </div>
            <div>
              <label for="data-shared-add-dir" [class]="label" i18n="@@vendor.im.add.direction"
                >Direction</label
              >
              <select
                id="data-shared-add-dir"
                class="id-input mt-1 min-w-[12rem]"
                (change)="draftDirection.set(asDirection($event))"
              >
                @for (d of directions; track d) {
                  <option [value]="d" [selected]="draftDirection() === d">
                    {{ directionText(d) }}
                  </option>
                }
              </select>
            </div>
          </div>
          <div>
            <label for="data-shared-add-note" [class]="label">
              {{ addNoteLabel() }}
              <span class="font-normal text-(--text-secondary)" i18n="@@vendor.im.answer.optional">
                (optional)</span
              >
            </label>
            <textarea
              id="data-shared-add-note"
              rows="2"
              maxlength="2000"
              class="id-input mt-1"
              aria-describedby="data-shared-add-note-help"
              [value]="draftNote()"
              (input)="draftNote.set(textValue($event))"
            ></textarea>
            <p id="data-shared-add-note-help" [class]="help">{{ audience() }}</p>
          </div>
          @if (vocabularyFailed()) {
            <p [class]="alert" role="alert" i18n="@@vendor.im.add.vocabularyFailed">
              The list of data types could not be loaded, so a row cannot be added right now.
            </p>
          }
          @if (addError()) {
            <p [class]="alert" role="alert">{{ addError() }}</p>
          }
          <div class="flex flex-wrap gap-3">
            <button
              type="submit"
              [class]="primary"
              [disabled]="adding() || dataOptions().length === 0"
              data-testid="add-row-submit"
            >
              <span i18n="@@vendor.im.add.submit">Add</span>
            </button>
            <button
              type="button"
              [class]="secondary"
              [disabled]="adding()"
              (click)="closeAdd()"
              i18n="@@vendor.im.add.cancel"
            >
              Cancel
            </button>
          </div>
        </form>
      }
    </div>

    @if (!i.attestable) {
      <p class="mt-3 max-w-prose text-sm text-(--text-secondary)" data-testid="connector-note">
        {{ connectorNote() }}
      </p>
    } @else if (!state.canAuthor()) {
      <p class="mt-3 max-w-prose text-sm text-(--text-secondary)" i18n="@@vendor.attest.readOnly">
        You can review everything on record here. Confirming data flows and adding new ones opens up
        with active vendor access. That access is arranged with AEC Integrations, not something you
        switch on from this portal.
      </p>
    }

    @if (i.claims.length === 0) {
      <p class="mt-3 text-sm text-(--text-secondary)" i18n="@@vendor.im.data.empty">
        No data is listed as shared yet.
      </p>
    } @else {
      <div
        class="mt-3 overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        tabindex="0"
        role="region"
        [attr.aria-label]="caption()"
      >
        <table class="w-full min-w-[40rem] border-collapse text-sm">
          <caption class="sr-only">
            {{
              caption()
            }}
          </caption>
          <thead>
            <tr class="border-b border-(--border-default)">
              @for (col of columns(); track col.key) {
                <th scope="col" class="py-2 pe-4 text-start font-semibold text-(--text-secondary)">
                  <span class="inline-flex items-center gap-1"
                    >{{ col.label }}<aec-vendor-tip [label]="col.about" [lines]="[col.tip]"
                  /></span>
                </th>
              }
            </tr>
          </thead>
          <tbody>
            @for (claim of rows(); track claim.id) {
              @let pill = pillFor(claim);
              @let mine = answerOf(claim);
              @let change = changeOf(claim);
              <tr
                [id]="rowId(claim.id)"
                tabindex="-1"
                class="scroll-mt-20 focus:outline-2 focus:-outline-offset-2 focus:outline-(--accent-primary)"
                [class.border-b]="!change"
                [attr.data-testid]="'data-row-' + claim.data_object_slug"
              >
                <th scope="row" class="py-2 pe-4 text-start font-semibold text-(--text-primary)">
                  {{ claim.data_object_name }}
                </th>
                <td class="py-2 pe-4 text-(--text-primary)">
                  <span class="inline-flex items-center gap-1.5">
                    @switch (claim.direction) {
                      @case ('outbound') {
                        <svg
                          aria-hidden="true"
                          class="h-4 w-4 shrink-0 text-(--text-secondary) rtl:-scale-x-100"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M5 12h14" />
                          <path d="m12 5 7 7-7 7" />
                        </svg>
                      }
                      @case ('inbound') {
                        <svg
                          aria-hidden="true"
                          class="h-4 w-4 shrink-0 text-(--text-secondary) rtl:-scale-x-100"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="m12 19-7-7 7-7" />
                          <path d="M19 12H5" />
                        </svg>
                      }
                      @default {
                        <svg
                          aria-hidden="true"
                          class="h-4 w-4 shrink-0 text-(--text-secondary)"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M8 3 4 7l4 4" />
                          <path d="M4 7h16" />
                          <path d="m16 21 4-4-4-4" />
                          <path d="M20 17H4" />
                        </svg>
                      }
                    }
                    {{ directionText(claim.direction) }}
                  </span>
                </td>
                <td class="py-2 pe-4">
                  @if (!i.attestable) {
                    <span class="text-(--text-secondary)" i18n="@@vendor.im.data.notNeeded"
                      >Not needed</span
                    >
                  } @else if (mine !== null && editing() !== claim.id) {
                    <span class="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span
                        class="inline-flex items-center gap-1 font-medium text-(--text-primary)"
                        [attr.data-testid]="'answer-' + claim.data_object_slug"
                      >
                        @if (mine === 'yes') {
                          <svg
                            aria-hidden="true"
                            class="h-3.5 w-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                          <span i18n="@@vendor.im.answer.yes">Yes</span>
                        } @else {
                          <svg
                            aria-hidden="true"
                            class="h-3.5 w-3.5"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2.5"
                            stroke-linecap="round"
                          >
                            <path d="M18 6 6 18M6 6l12 12" />
                          </svg>
                          <span i18n="@@vendor.im.answer.no">No</span>
                        }
                      </span>
                      @if (!change && canChange()) {
                        <button
                          type="button"
                          [class]="rowAction"
                          [attr.aria-label]="changeLabel(claim)"
                          [attr.data-change-for]="claim.id"
                          [attr.data-testid]="'change-' + claim.data_object_slug"
                          (click)="startEdit(claim)"
                          i18n="@@vendor.im.answer.change"
                        >
                          Change
                        </button>
                      }
                    </span>
                  } @else {
                    <div
                      class="id-seg"
                      role="group"
                      [attr.aria-label]="groupLabel(claim)"
                      [attr.data-answer-group]="claim.id"
                      (keydown.escape)="stopEdit(claim)"
                    >
                      <button
                        type="button"
                        class="id-seg-btn inline-flex min-h-8 items-center gap-1 px-2.5 py-1 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                        [attr.aria-pressed]="mine === 'yes'"
                        [attr.aria-expanded]="
                          yesOpensForm(claim) ? openForm() === claim.id + ':yes' : null
                        "
                        [attr.aria-label]="yesLabel"
                        [disabled]="!canPress(claim, 'yes') || busy() === claim.id"
                        [attr.data-testid]="'yes-' + claim.data_object_slug"
                        (click)="pressYes(claim)"
                      >
                        <svg
                          aria-hidden="true"
                          class="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                        <span i18n="@@vendor.im.answer.yes">Yes</span>
                      </button>
                      <button
                        type="button"
                        class="id-seg-btn inline-flex min-h-8 items-center gap-1 px-2.5 py-1 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                        [attr.aria-pressed]="mine === 'no'"
                        [attr.aria-expanded]="
                          mine === 'no' ? null : openForm() === claim.id + ':no'
                        "
                        [attr.aria-label]="noLabel"
                        [disabled]="!canPress(claim, 'no') || busy() === claim.id"
                        [attr.data-testid]="'no-' + claim.data_object_slug"
                        (click)="pressNo(claim)"
                      >
                        <svg
                          aria-hidden="true"
                          class="h-3.5 w-3.5"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.5"
                          stroke-linecap="round"
                        >
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                        <span i18n="@@vendor.im.answer.no">No</span>
                      </button>
                    </div>
                  }
                  @if (i.attestable && rowError()?.id === claim.id) {
                    <p role="alert" [class]="alert" class="mt-1">{{ rowError()?.message }}</p>
                  }
                </td>
                <td class="py-2">
                  <span class="inline-flex items-center gap-1">
                    <aec-vendor-tip
                      variant="pill"
                      [label]="pill.label"
                      [tone]="pill.tone"
                      [lines]="statusLines(claim)"
                      [testId]="'status-' + claim.data_object_slug"
                    />
                    @if (claim.agreement === 'conflict' && i.attestable) {
                      <aec-vendor-tip
                        variant="flag"
                        [label]="disagreementFlagLabel(claim)"
                        [lines]="[disagreementFlagText(claim)]"
                        (activate)="state.jumpTo(disagreementTarget(claim), true)"
                      />
                    }
                  </span>
                </td>
              </tr>
              @if (openForm() === claim.id + ':no' || openForm() === claim.id + ':yes') {
                <tr class="border-b border-(--border-default)">
                  <td colspan="4" class="py-3">
                    <aec-integration-answer-form
                      [integration]="i"
                      [claim]="claim"
                      [mode]="openForm() === claim.id + ':no' ? 'no' : 'yes'"
                      (saved)="formSaved.set(true)"
                      (closed)="closeForm(claim)"
                    />
                  </td>
                </tr>
              }
              @if (change) {
                <tr class="border-b" [attr.data-testid]="'change-box-' + claim.data_object_slug">
                  <td
                    colspan="4"
                    [id]="boxId(claim.id)"
                    tabindex="-1"
                    class="id-change-box scroll-mt-20 space-y-1 px-4 py-3 text-(--text-primary) focus:outline-2 focus:-outline-offset-2 focus:outline-(--accent-primary)"
                  >
                    <p class="font-semibold" i18n="@@vendor.im.change.title">
                      You submitted a change
                    </p>
                    <p>{{ changeLine(claim, change) }}</p>
                    @if (reasonOf(claim); as reason) {
                      <p class="text-(--text-secondary)">{{ yourReason(reason) }}</p>
                    }
                    @if (!ownsBoth()) {
                      <p
                        class="inline-flex flex-wrap items-center gap-1"
                        [attr.data-testid]="'change-answer-' + claim.data_object_slug"
                      >
                        <span>{{ theirChangeAnswer(change) }}</span>
                        @if (theirNote(change); as note) {
                          <aec-vendor-tip
                            [label]="theirReasonAbout()"
                            [lines]="[theirReason(note)]"
                          />
                        }
                        @if (change.agreement === 'conflict') {
                          <aec-vendor-tip
                            variant="flag"
                            [label]="disagreementFlagLabel(change)"
                            [lines]="[disagreementFlagText(change)]"
                            (activate)="state.jumpTo(disagreementTarget(change), true)"
                          />
                        }
                      </p>
                    }
                    @if (state.canAuthor()) {
                      <div class="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                        @if (live()) {
                          <button
                            type="button"
                            [class]="rowAction"
                            [attr.aria-label]="changeBoxLabel(claim)"
                            [attr.aria-expanded]="changeForm()?.id === claim.id"
                            [attr.aria-controls]="boxId(claim.id) + '-form'"
                            [attr.data-box-change]="claim.id"
                            [disabled]="busy() === claim.id"
                            [attr.data-testid]="'change-box-change-' + claim.data_object_slug"
                            (click)="toggleChangeForm(claim)"
                            i18n="@@vendor.im.answer.change"
                          >
                            Change
                          </button>
                        }
                        <button
                          type="button"
                          [class]="rowAction"
                          [attr.aria-label]="cancelBoxLabel(claim)"
                          [disabled]="busy() === claim.id"
                          [attr.data-testid]="'change-box-cancel-' + claim.data_object_slug"
                          (click)="cancelChange(claim, change)"
                          i18n="@@vendor.im.change.cancel"
                        >
                          Cancel
                        </button>
                      </div>
                    }
                    @if (boxError()?.id === claim.id) {
                      <p role="alert" [class]="alert">{{ boxError()?.message }}</p>
                    }
                    <div [id]="boxId(claim.id) + '-form'">
                      @if (changeForm()?.id === claim.id) {
                        <div class="pt-2">
                          <aec-integration-answer-form
                            [integration]="i"
                            [claim]="claim"
                            mode="no"
                            [change]="change"
                            (closed)="closeChangeForm(claim)"
                          />
                        </div>
                      }
                    </div>
                  </td>
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
  `,
})
export class IntegrationSharedData {
  protected readonly state = inject(IntegrationDetailState);
  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();

  private readonly addFirst = viewChild<ElementRef<HTMLSelectElement>>('addFirst');
  private readonly addButton = viewChild<ElementRef<HTMLButtonElement>>('addButton');

  /** Which row's form is open: "claimId:no" or "claimId:yes". */
  protected readonly openForm = signal<string | null>(null);
  /** Set by the open form's `saved`, read when it closes: a save, not a Cancel. */
  protected readonly formSaved = signal(false);
  protected readonly busy = signal<string | null>(null);
  protected readonly rowError = signal<{ id: string; message: string } | null>(null);
  /** The answered row whose toggles Change has revealed (§6.17.4, AECI-1246). */
  protected readonly editing = signal<string | null>(null);
  /**
   * The submitted change whose reason form is open, by the denied row's id. It
   * holds the correction as it was when Change opened, so the box and its form stay
   * on the page while a save withdraws that correction and adds the next one.
   */
  protected readonly changeForm = signal<{ id: string; correction: VendorClaim } | null>(null);
  protected readonly boxError = signal<{ id: string; message: string } | null>(null);

  protected readonly dataObjects = signal<readonly DataObjectOption[]>([]);
  protected readonly vocabularyFailed = signal(false);
  protected readonly draftData = signal('');
  protected readonly draftDirection = signal<ContextDirection>('outbound');
  protected readonly draftNote = signal('');
  protected readonly adding = signal(false);
  protected readonly addError = signal<string | null>(null);

  /** Outbound, both, inbound: the one order every direction picker uses
   *  (AECI-1243). */
  protected readonly directions = ['outbound', 'both', 'inbound'] as const;

  protected readonly live = computed(() => !this.integration().retired_at);

  protected readonly canAdd = computed(
    () => this.integration().attestable && this.live() && this.state.canAuthor(),
  );

  /** Whether an answered row offers Change. On a retired row Change still opens,
   *  because a pressed answer can be cleared there (§4.6.2). */
  protected readonly canChange = computed(
    () => this.integration().attestable && this.state.canAuthor(),
  );

  protected readonly ownsBoth = computed(() => ownsBoth(this.integration()));

  /** Submitted changes: the denied row's id to its correction (§6.17.4). */
  private readonly changes = computed(() => submittedChanges(this.integration()));

  /** The rows the table renders: every row but a correction a box stands for. */
  protected readonly rows = computed(() => {
    const folded = new Set([...this.changes().values()].map((c) => c.id));
    return this.integration().claims.filter((c) => !folded.has(c.id));
  });

  protected readonly heading = computed(() => {
    const n = this.rows().length;
    return $localize`:@@vendor.im.data.heading:Data that's shared (${n}:count:)`;
  });

  protected readonly headingTip = computed(() => {
    const i = this.integration();
    const a = i.context_product.name;
    const b = i.other_product.name;
    return i.attestable
      ? $localize`:@@vendor.im.data.tip:The types of data that move between ${a}:a: and ${b}:b:. Say whether each row is right. Only the badge your answer produces is public.`
      : $localize`:@@vendor.im.data.tipConnector:The types of data that move between ${a}:a: and ${b}:b:. AEC Integrations keeps this list up to date.`;
  });

  protected readonly caption = computed(() => {
    const i = this.integration();
    const a = i.context_product.name;
    const b = i.other_product.name;
    return $localize`:@@vendor.im.data.caption:Data that is shared between ${a}:a: and ${b}:b:`;
  });

  protected readonly connectorNote = computed(() => {
    const i = this.integration();
    const connector =
      i.powered_by?.name ??
      i.mechanism_name ??
      $localize`:@@vendor.im.connector.fallback:a connector service`;
    return $localize`:@@vendor.im.data.connectorNote:AEC Integrations keeps these up to date. They run through ${connector}:connector:, so neither company answers for them.`;
  });

  protected readonly columns = computed(() => {
    const i = this.integration();
    return [
      {
        key: 'data',
        label: $localize`:@@vendor.im.data.col.data:Data`,
        about: $localize`:@@vendor.im.data.col.data.about:About data`,
        tip: $localize`:@@vendor.im.data.col.data.tip:The type of information that moves between the two products. Rows belong to the two product companies, not to the owner of the integration.`,
      },
      {
        key: 'direction',
        label: $localize`:@@vendor.im.data.col.direction:Direction`,
        about: $localize`:@@vendor.im.data.col.direction.about:About direction`,
        tip: $localize`:@@vendor.im.data.col.direction.tip:Which way the data moves, from ${i.context_product.name}:product:. The public page groups the rows by direction.`,
      },
      {
        key: 'answer',
        label: $localize`:@@vendor.im.data.col.answer:Your answer`,
        about: $localize`:@@vendor.im.data.col.answer.about:About your answer`,
        tip: $localize`:@@vendor.im.data.col.answer.tip:Whether your company says the row is right. Only the badge it produces is public. Your reason is not.`,
      },
      {
        key: 'status',
        label: $localize`:@@vendor.im.data.col.status:Status`,
        about: $localize`:@@vendor.im.data.col.status.about:About status`,
        tip: $localize`:@@vendor.im.data.col.status.tip:Where the row stands, from your side. The public page shows a badge such as "Confirmed by both companies" or "Companies disagree".`,
      },
    ];
  });

  protected readonly dataOptions = computed(() =>
    [...this.dataObjects()].sort((a, b) => compareText(a.name, b.name)),
  );

  protected readonly addHelp = computed(() => {
    const i = this.integration();
    if (ownsBoth(i)) {
      return $localize`:@@vendor.im.add.help.self:Both products are yours, so the row is recorded as confirmed by you and nobody else needs to confirm it.`;
    }
    const me = this.state.myCompany();
    const company = this.state.company();
    const themMid = companyMidSentence(company);
    const them = companyOrFallback(company);
    return $localize`:@@vendor.im.add.help:The row is recorded as confirmed by you and shows publicly as "Confirmed by ${me}:me:" until ${themMid}:themMid: answers. ${them}:them: is asked to confirm it.`;
  });

  protected readonly addNoteLabel = computed(() => {
    const i = this.integration();
    if (ownsBoth(i)) return $localize`:@@vendor.im.add.noteSelf:Note for AEC Integrations`;
    const them = companyMidSentence(this.state.company());
    return $localize`:@@vendor.im.add.noteFor:Note for ${them}:company:`;
  });

  protected readonly audience = computed(() =>
    noteAudience(this.integration(), this.state.myVendorId()),
  );

  protected readonly aboutHeading = $localize`:@@vendor.im.data.about:About data that is shared`;
  protected readonly addLabel = $localize`:@@vendor.im.add.label:Add data that's shared`;
  protected readonly addFormLabel = $localize`:@@vendor.im.add.form:Add data that is shared`;
  protected readonly yesLabel = $localize`:@@vendor.im.answer.yes.aria:Yes, this is right`;
  protected readonly noLabel = $localize`:@@vendor.im.answer.no.aria:No, this is wrong`;

  protected readonly label = LABEL;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly rowAction = ROW_ACTION;

  protected rowId(claimId: string): string {
    return dataRowId(claimId);
  }

  protected boxId(claimId: string): string {
    return changeBoxId(claimId);
  }

  /** The correction a box under this row stands for, if any. While the box's form
   *  is open, the correction it opened on. */
  protected changeOf(claim: VendorClaim): VendorClaim | null {
    const open = this.changeForm();
    if (open?.id === claim.id) return open.correction;
    return this.changes().get(claim.id) ?? null;
  }

  protected disagreementTarget(claim: VendorClaim): string {
    return disagreementItemId(claim.id);
  }

  protected answerOf(claim: VendorClaim): 'yes' | 'no' | null {
    return myAnswer(claim);
  }

  protected pillFor(claim: VendorClaim) {
    return rowPill(this.integration(), claim, this.state.company());
  }

  protected directionText(direction: ContextDirection): string {
    return directionShort(direction, this.integration().other_product.name);
  }

  /** "Change your answer: Models are sent to Procore". Starts with the visible
   *  word, so speech input can say "Change". */
  protected changeLabel(claim: VendorClaim): string {
    const sentence = this.sentence(claim);
    return $localize`:@@vendor.im.answer.change.aria:Change your answer: ${sentence}:sentence:`;
  }

  protected changeBoxLabel(claim: VendorClaim): string {
    const data = claim.data_object_name;
    return $localize`:@@vendor.im.change.change.aria:Change your submitted change to ${data}:data:`;
  }

  protected cancelBoxLabel(claim: VendorClaim): string {
    const data = claim.data_object_name;
    return $localize`:@@vendor.im.change.cancel.aria:Cancel your submitted change to ${data}:data:`;
  }

  /** "Documents: To AccuLynx becomes Both ways". */
  protected changeLine(denied: VendorClaim, correction: VendorClaim): string {
    const data = denied.data_object_name;
    const from = this.directionText(denied.direction);
    const to = this.directionText(correction.direction);
    return $localize`:@@vendor.im.change.line:${data}:data:: ${from}:from: becomes ${to}:to:`;
  }

  protected reasonOf(claim: VendorClaim): string | null {
    return myNote(claim);
  }

  protected yourReason(note: string): string {
    return $localize`:@@vendor.im.data.status.yourReason:Your reason: ${note}:note:`;
  }

  /** The other company's answer on the correction. */
  protected theirChangeAnswer(correction: VendorClaim): string {
    const who = companyOrFallback(this.state.company());
    switch (theirAnswer(correction)) {
      case 'yes':
        return $localize`:@@vendor.im.change.agrees:${who}:company: agrees.`;
      case 'no':
        return $localize`:@@vendor.im.change.disagrees:${who}:company: disagrees.`;
      default:
        return $localize`:@@vendor.im.change.notAnswered:${who}:company: has not answered yet.`;
    }
  }

  protected theirNote(correction: VendorClaim): string | null {
    const note = correction.counterparty?.note;
    return note && note.trim() !== '' ? note : null;
  }

  protected readonly theirReasonAbout = computed(() => {
    const who = possessive(companyOrFallback(this.state.company()));
    return $localize`:@@vendor.im.change.theirReason.about:About ${who}:who: answer`;
  });

  protected theirReason(note: string): string {
    const who = possessive(companyOrFallback(this.state.company()));
    return $localize`:@@vendor.im.data.status.theirReason:${who}:who: reason: ${note}:note:`;
  }

  private sentence(claim: VendorClaim): string {
    return dataSentence(
      claim.data_object_name,
      claim.direction,
      this.integration().other_product.name,
    );
  }

  protected groupLabel(claim: VendorClaim): string {
    const sentence = dataSentence(
      claim.data_object_name,
      claim.direction,
      this.integration().other_product.name,
    );
    return $localize`:@@vendor.im.answer.group:Your answer: ${sentence}:sentence:`;
  }

  /** The status tooltip: your reason, their reason, then the §6.2 sentence verbatim. */
  protected statusLines(claim: VendorClaim): string[] {
    const lines: string[] = [];
    const mine = myNote(claim);
    if (mine) lines.push($localize`:@@vendor.im.data.status.yourReason:Your reason: ${mine}:note:`);
    const theirs = claim.counterparty?.note;
    if (theirs && theirs.trim() !== '') {
      const who = possessive(companyOrFallback(this.state.company()));
      lines.push(
        $localize`:@@vendor.im.data.status.theirReason:${who}:who: reason: ${theirs}:note:`,
      );
    }
    if (this.integration().attestable) {
      lines.push(claimOutcomeLine(claim, this.integration().other_product.name));
    } else {
      lines.push(
        $localize`:@@vendor.im.data.status.connector:AEC Integrations checks it. Neither company answers for it.`,
      );
    }
    return lines;
  }

  protected disagreementFlagLabel(claim: VendorClaim): string {
    const data = claim.data_object_name;
    return $localize`:@@vendor.im.data.flag.label:Open disagreement on ${data}:data:`;
  }

  protected disagreementFlagText(claim: VendorClaim): string {
    const date = formatDay(claim.disagreement?.raised_at ?? null);
    return date
      ? $localize`:@@vendor.im.data.flag.text:Disagreement raised ${date}:date:. Select the flag to see it in Change requests.`
      : $localize`:@@vendor.im.data.flag.textNoDate:Disagreement open. Select the flag to see it in Change requests.`;
  }

  /** Yes opens a note form only when the other company said No. */
  protected yesOpensForm(claim: VendorClaim): boolean {
    return myAnswer(claim) !== 'yes' && theirAnswer(claim) === 'no';
  }

  /** A retired row only lets a pressed answer be cleared (§4.6.2). */
  protected canPress(claim: VendorClaim, which: 'yes' | 'no'): boolean {
    if (!this.state.canAuthor() || !this.integration().attestable) return false;
    if (this.live()) return true;
    return myAnswer(claim) === which;
  }

  protected async pressYes(claim: VendorClaim): Promise<void> {
    this.rowError.set(null);
    if (myAnswer(claim) === 'yes') {
      await this.clear(claim, 'yes');
      return;
    }
    if (this.yesOpensForm(claim)) {
      this.openForm.set(`${claim.id}:yes`);
      return;
    }
    this.openForm.set(null);
    // Hold the toggles on screen until the write lands, so an optimistic Yes does
    // not swap the pressed button for plain text under the pointer.
    const wasEditing = this.editing() === claim.id;
    this.editing.set(claim.id);
    this.busy.set(claim.id);
    const error = await this.state.answerYes(claim);
    this.busy.set(null);
    if (error) {
      if (!wasEditing) this.editing.set(null);
      this.rowError.set({ id: claim.id, message: error });
      return;
    }
    this.editing.set(null);
    this.focusAnswer(claim.id);
  }

  protected async pressNo(claim: VendorClaim): Promise<void> {
    this.rowError.set(null);
    if (myAnswer(claim) === 'no') {
      await this.clear(claim, 'no');
      return;
    }
    const key = `${claim.id}:no`;
    this.openForm.set(this.openForm() === key ? null : key);
  }

  private async clear(claim: VendorClaim, which: 'yes' | 'no'): Promise<void> {
    this.openForm.set(null);
    this.busy.set(claim.id);
    const error = await this.state.clearAnswer(claim);
    this.busy.set(null);
    if (error) {
      this.rowError.set({ id: claim.id, message: error });
      return;
    }
    // The row has no answer now, so its one-click toggles are back.
    this.editing.set(null);
    this.focusAnswer(claim.id, which);
  }

  /** Change on an answered row: reveal its toggles, and focus the pressed one. */
  protected startEdit(claim: VendorClaim): void {
    this.rowError.set(null);
    this.editing.set(claim.id);
    this.focusAnswer(claim.id, myAnswer(claim) ?? 'yes');
  }

  /** Escape on revealed toggles: back to plain text, focus on Change. */
  protected stopEdit(claim: VendorClaim): void {
    if (this.editing() !== claim.id || this.busy() === claim.id) return;
    if (this.openForm()?.startsWith(`${claim.id}:`)) this.openForm.set(null);
    this.editing.set(null);
    this.focusAnswer(claim.id);
  }

  /**
   * Close the form. After a save the row reads as plain text again and focus goes
   * to its Change link (or the box's, when the save submitted a change). After a
   * Cancel focus returns to the row's pressed control.
   */
  protected closeForm(claim: VendorClaim): void {
    const which = this.openForm()?.endsWith(':yes') ? 'yes' : 'no';
    const saved = this.formSaved();
    this.formSaved.set(false);
    this.openForm.set(null);
    if (saved && this.editing() === claim.id) this.editing.set(null);
    this.focusAnswer(claim.id, which);
  }

  // ── A submitted change (§6.17.4, AECI-1246) ────────────────────────────────

  protected toggleChangeForm(claim: VendorClaim): void {
    this.boxError.set(null);
    if (this.changeForm()?.id === claim.id) {
      this.closeChangeForm(claim);
      return;
    }
    const correction = this.changes().get(claim.id);
    if (correction) this.changeForm.set({ id: claim.id, correction });
  }

  protected closeChangeForm(claim: VendorClaim): void {
    this.changeForm.set(null);
    this.focusAnswer(claim.id);
  }

  /** Cancel: withdraw the Yes on the correction, then the No on this row. */
  protected async cancelChange(claim: VendorClaim, correction: VendorClaim): Promise<void> {
    this.boxError.set(null);
    this.rowError.set(null);
    this.changeForm.set(null);
    this.busy.set(claim.id);
    const error = await this.state.cancelChange(claim, correction);
    this.busy.set(null);
    if (error) {
      // The box is gone once the correction's Yes is withdrawn, so a failure on the
      // second write shows beside the row's answer instead.
      if (this.changes().has(claim.id)) this.boxError.set({ id: claim.id, message: error });
      else this.rowError.set({ id: claim.id, message: error });
    }
    this.focusAnswer(claim.id);
  }

  /**
   * Focus what stands for a row's answer, once it has rendered: the box when the
   * row is a correction a box stands for; else the Yes or No toggle when the
   * toggles show; else the box's Change; else the row's Change; else the row.
   */
  focusAnswer(claimId: string, which: 'yes' | 'no' = 'yes'): void {
    afterNextRender(
      () => {
        const denied = deniedRowFor(this.integration(), claimId);
        if (denied) {
          this.document.getElementById(changeBoxId(denied.id))?.focus();
          return;
        }
        const group = this.document.querySelector(`[data-answer-group="${claimId}"]`);
        const buttons = group?.querySelectorAll<HTMLButtonElement>('button');
        const target =
          buttons?.[which === 'yes' ? 0 : 1] ??
          this.document.querySelector<HTMLElement>(`[data-box-change="${claimId}"]`) ??
          this.document.querySelector<HTMLElement>(`[data-change-for="${claimId}"]`) ??
          this.document.getElementById(dataRowId(claimId));
        target?.focus();
      },
      { injector: this.injector },
    );
  }

  // ── Add a row ──────────────────────────────────────────────────────────────

  protected toggleAdd(): void {
    if (this.state.addingRow()) {
      this.closeAdd();
      return;
    }
    this.state.addingRow.set(true);
    this.addError.set(null);
    void this.loadVocabulary();
    afterNextRender(() => this.addFirst()?.nativeElement.focus(), { injector: this.injector });
  }

  protected closeAdd(): void {
    this.state.addingRow.set(false);
    this.draftNote.set('');
    this.addError.set(null);
    afterNextRender(() => this.addButton()?.nativeElement.focus(), { injector: this.injector });
  }

  private async loadVocabulary(): Promise<void> {
    if (this.dataObjects().length > 0) return;
    try {
      const res = await this.api.getDataObjects();
      this.dataObjects.set(res.data_objects);
      this.vocabularyFailed.set(res.data_objects.length === 0);
      if (!this.draftData() && this.dataOptions().length > 0) {
        this.draftData.set(this.dataOptions()[0].slug);
      }
    } catch {
      this.vocabularyFailed.set(true);
    }
  }

  protected async add(event: Event): Promise<void> {
    event.preventDefault();
    if (this.adding()) return;
    const data = this.draftData() || this.dataOptions()[0]?.slug;
    if (!data) return;
    this.adding.set(true);
    this.addError.set(null);
    const result = await this.state.addRow(data, this.draftDirection(), this.draftNote());
    this.adding.set(false);
    if (result.ok) {
      this.state.addingRow.set(false);
      this.draftNote.set('');
      this.focusAnswer(result.claimId);
      return;
    }
    if (result.duplicateOf) {
      this.state.addingRow.set(false);
      this.announcer.announce(result.error);
      this.focusAnswer(result.duplicateOf);
      return;
    }
    this.addError.set(result.error);
  }

  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  protected textValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected asDirection(event: Event): ContextDirection {
    const value = (event.target as HTMLSelectElement).value;
    return value === 'inbound' || value === 'both' ? value : 'outbound';
  }
}
