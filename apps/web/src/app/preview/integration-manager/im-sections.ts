import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { IntegrationContestField, VendorContest } from '@aeci/shared';

import { NgTemplateOutlet } from '@angular/common';

import { ImAnswerForm } from './im-answer-form';
import { ImTip } from './im-tip';
import { BTN_DANGER, BTN_LINK, BTN_PRIMARY, BTN_SECONDARY, IM_STYLES, LABEL } from './im-ui';
import {
  addedByThem,
  addedByYou,
  addedItemId,
  contestFlagText,
  contestSearchText,
  currentValue,
  directionShort,
  disputeFlagText,
  disputeItemId,
  disputeRaised,
  disputeReviewDay,
  disputes,
  disputeSearchText,
  disputeTitle,
  fieldLabel,
  flowClause,
  flowRowId,
  flowSentence,
  flowStatus,
  formatDay,
  formatWhen,
  IM_INFO_TYPES,
  isConnector,
  isOwner,
  isReceived,
  maintainedBy,
  openContestFor,
  openOwnerRequest,
  openRequests,
  OWNER_DEFINITION,
  ownerCopy,
  pastRequests,
  possessive,
  PREVIEW_NOW,
  reasonSummary,
  receivedEvents,
  receivedOpen,
  receivedOutcome,
  receivedPast,
  REQUEST_FIELDS,
  requestEvents,
  requestItemId,
  requestOutcome,
  requestRouteLine,
  requestValue,
  rowId,
  statusLines,
  VIEWER,
  type FlowDirection,
  type ImFlow,
  type ImIntegration,
  type ImSide,
  type SectionKey,
} from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

/** The small link-style action that sits on a row. */
const ROW_ACTION =
  'rounded-(--radius-sm) text-sm font-semibold text-(--accent-primary) underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

const ICON_BUTTON =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-(--radius-md) text-(--text-secondary) hover:bg-(--surface-sunken) hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

// ─── Overview ────────────────────────────────────────────────────────────────

type DetailKey = 'name' | 'description' | 'maturity' | 'pricing' | 'pricingUrl' | 'mechanismName';

interface FactRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** "Not set" and similar render quieter. */
  readonly empty: boolean;
  /** The label's tooltip: what the field means, where it shows publicly, who changes it. */
  readonly tip: readonly string[] | null;
  /** The contestable field, so an open request can flag the row and a non-owner can ask. */
  readonly field: IntegrationContestField | null;
  /** What the claimed owner edits directly with the row's pencil. */
  readonly edit: DetailKey | null;
  /** Long values show two lines, with Show more when they overflow. */
  readonly clamp: boolean;
  /** Input type and length cap for the owner's inline editor. */
  readonly input?: 'text' | 'url';
  readonly max?: number;
}

interface FactGroup {
  readonly title: string;
  readonly tip: string | null;
  readonly rows: readonly FactRow[];
}

/**
 * Overview: every contestable detail as one row, a label and one value at one
 * size. Explanations live in tooltips. Each row carries the one action the
 * viewer's role allows: the claimed owner edits it with a pencil; an owner that
 * has not claimed is sent to Claim; anyone else gets "Request a change". A value
 * with an open change request carries a flag instead.
 *
 * Round 6: Direction left Overview (the data rows imply it, and the public chip
 * is computed from them). Pricing gained a "Pricing page" link, which is a new
 * field: it needs a new column and has no contest field yet.
 */
@Component({
  selector: 'aec-im-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImTip],
  styles: [IM_STYLES],
  template: `
    @let i = integration();
    @let owner = ownerInfo();
    <div class="space-y-6">
      @for (group of groups(); track group.title) {
        <div>
          <div class="flex items-center gap-1">
            <h4 class="im-h4">{{ group.title }}</h4>
            @if (group.tip) {
              <aec-im-tip [label]="'About ' + group.title" [lines]="[group.tip]" />
            }
          </div>
          <dl class="mt-1 divide-y divide-(--border-default)">
            @for (row of group.rows; track row.key) {
              <div
                [id]="rowTarget(row.key)"
                tabindex="-1"
                class="grid scroll-mt-24 items-center gap-x-6 gap-y-0.5 py-1.5 text-sm focus:outline-none sm:grid-cols-[11rem_1fr]"
              >
                <dt class="flex items-center gap-1 text-(--text-secondary)">
                  {{ row.label }}
                  @if (row.tip) {
                    <aec-im-tip [label]="'About ' + row.label" [lines]="row.tip" />
                  }
                </dt>
                <dd class="flex min-h-8 min-w-0 items-center gap-1.5">
                  @if (editing() === row.key) {
                    <form
                      class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
                      (submit)="save($event, row)"
                    >
                      <input
                        #editField
                        [type]="row.input ?? 'text'"
                        class="im-input min-w-[16rem] flex-1"
                        [attr.aria-label]="row.label"
                        [attr.maxlength]="row.max ?? null"
                        [value]="draft()"
                        (input)="draft.set(inputValue($event))"
                      />
                      <button type="submit" [class]="primary">Save</button>
                      <button type="button" [class]="secondary" (click)="editing.set(null)">
                        Cancel
                      </button>
                      @if (error()) {
                        <p role="alert" class="basis-full font-medium text-(--status-error)">
                          {{ error() }}
                        </p>
                      }
                    </form>
                  } @else {
                    @if (row.clamp) {
                      <span class="min-w-0 py-1">
                        <span
                          #clampValue
                          [id]="rowTarget(row.key) + '-value'"
                          [class]="
                            'break-words ' +
                            (expandedText() ? 'block ' : 'line-clamp-2 ') +
                            (row.empty ? 'text-(--text-secondary)' : 'text-(--text-primary)')
                          "
                          >{{ row.value }}</span
                        >
                        @if (overflows() || expandedText()) {
                          <button
                            type="button"
                            [class]="rowAction"
                            [attr.aria-expanded]="expandedText()"
                            [attr.aria-controls]="rowTarget(row.key) + '-value'"
                            (click)="expandedText.set(!expandedText())"
                            data-testid="show-more"
                          >
                            {{ expandedText() ? 'Show less' : 'Show more' }}
                          </button>
                        }
                      </span>
                    } @else {
                      <span
                        [class]="
                          'min-w-0 break-words ' +
                          (row.empty ? 'text-(--text-secondary)' : 'text-(--text-primary)')
                        "
                        >{{ row.value }}</span
                      >
                    }
                    @if (row.field && contestOn(row.field); as c) {
                      <aec-im-tip
                        variant="flag"
                        [label]="'Open change request on ' + row.label"
                        [lines]="[flagText(c)]"
                        (activate)="goToItem.emit(requestTarget(c.id))"
                      />
                    }
                    <span class="ms-auto flex shrink-0 items-center">
                      @if (row.key === 'owner') {
                        @if (
                          actions() &&
                          owner.action &&
                          owner.action !== 'request-pending' &&
                          !i.retired
                        ) {
                          <button type="button" [class]="rowAction" (click)="onOwnerAction()">
                            {{ owner.actionLabel }}
                          </button>
                        }
                      } @else if (actions() && !i.retired) {
                        @switch (i.owner.state) {
                          @case ('you-claimed') {
                            @if (row.edit) {
                              <button
                                type="button"
                                [class]="iconButton"
                                [attr.aria-label]="'Edit ' + row.label"
                                (click)="edit(row)"
                                [attr.data-testid]="'edit-' + row.key"
                              >
                                <svg
                                  aria-hidden="true"
                                  class="h-4 w-4"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="2"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                >
                                  <path
                                    d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
                                  />
                                  <path d="m15 5 4 4" />
                                </svg>
                              </button>
                            }
                          }
                          @case ('you-unclaimed') {
                            @if (row.edit) {
                              <button
                                type="button"
                                [class]="rowAction"
                                [attr.aria-label]="'Claim to edit ' + row.label"
                                (click)="goToItem.emit(rowTarget('owner'))"
                              >
                                Claim to edit
                              </button>
                            }
                          }
                          @default {
                            @if (row.field && !contestOn(row.field)) {
                              <button
                                type="button"
                                [class]="rowAction"
                                [attr.aria-label]="'Request a change to ' + row.label"
                                (click)="requestChange(row.field)"
                              >
                                Request a change
                              </button>
                            }
                          }
                        }
                      }
                    </span>
                  }
                </dd>
              </div>
            }
          </dl>
        </div>
      }
    </div>
  `,
})
export class ImAbout {
  private readonly store = inject(IntegrationManagerStore);

  readonly integration = input.required<ImIntegration>();
  /** false hides the row actions (D's action bar holds them). */
  readonly actions = input(true);
  /** Ask the concept to move to a section (switch tab, scroll, and so on). */
  readonly goTo = output<SectionKey>();
  /** Ask the concept to jump to one element (a row or a change request). */
  readonly goToItem = output<string>();

  protected readonly ownerInfo = computed(() => ownerCopy(this.integration()));
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  private readonly editField = viewChild<ElementRef<HTMLInputElement>>('editField');
  /** The long value (Description) shows two lines, with Show more when it overflows. */
  private readonly clampValue = viewChild<ElementRef<HTMLElement>>('clampValue');
  protected readonly expandedText = signal(false);
  protected readonly overflows = signal(false);

  protected readonly rowAction = ROW_ACTION;
  protected readonly iconButton = ICON_BUTTON;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;

  constructor() {
    effect(() => this.editField()?.nativeElement.focus());
    // Measure the clamped value after each render; the toggle shows only when the
    // text runs past two lines. Browser only: afterRenderEffect never runs on SSR.
    afterRenderEffect(() => {
      const el = this.clampValue()?.nativeElement;
      if (!el || this.expandedText()) return;
      const over = el.scrollHeight > el.clientHeight + 1;
      if (over !== untracked(this.overflows)) this.overflows.set(over);
    });
  }

  /** Who can change a row, in one sentence, for its tooltip. */
  private readonly whoChanges = computed(() => {
    const i = this.integration();
    switch (i.owner.state) {
      case 'you-claimed':
        return 'You own this integration, so you change it directly.';
      case 'you-unclaimed':
        return 'You are the recorded owner. Claim the integration to change it.';
      case 'other-claimed':
        return `${i.owner.name} owns this integration and changes it. Request a change if it is wrong.`;
      default:
        return 'AEC Integrations keeps it until an owner takes over. Request a change if it is wrong.';
    }
  });

  protected readonly groups = computed<readonly FactGroup[]>(() => {
    const i = this.integration();
    const owner = ownerCopy(i);
    const who = this.whoChanges();
    const row = (
      f: IntegrationContestField,
      edit: DetailKey | null,
      tip: readonly string[] | null = null,
      extra: Partial<FactRow> = {},
    ): FactRow => {
      const value = currentValue(i, f);
      const clamp = extra.clamp ?? false;
      return {
        key: f,
        label: fieldLabel(f),
        value,
        empty: value === 'Not set' || value === 'No owner',
        tip,
        field: f,
        edit,
        clamp,
        ...extra,
      };
    };
    const maintained = maintainedBy(i);
    const glance = 'Shows in the "At a glance" row on the public page.';
    return [
      {
        title: 'Details',
        tip: null,
        rows: [
          row('name', 'name', [
            "The integration's name, used in the portal and in change requests.",
            'Not shown on the public page.',
            who,
          ]),
          row(
            'description',
            'description',
            [
              'What the integration does, in a sentence or two.',
              'Shows under "Offered by" on the public page.',
              who,
            ],
            { clamp: true },
          ),
          row('mechanism_kind', null, [
            'How customers get it: built into a product, a marketplace app, a direct connection, or through a connector service.',
            glance,
            who,
          ]),
          row('mechanism_name', 'mechanismName', [
            'The name of the feature or add-on that makes the connection.',
            "Shows as the title of the integration's card on the public page.",
            who,
          ]),
          row('maturity', 'maturity', [
            'Whether it is in beta or generally available.',
            glance,
            who,
          ]),
          row(
            'pricing_model',
            'pricing',
            ['What customers pay for it, in up to 200 characters.', glance, who],
            { max: 200 },
          ),
          {
            key: 'pricing-page',
            label: 'Pricing page',
            value: i.details.pricingUrl ?? 'Not set',
            empty: !i.details.pricingUrl,
            tip: [
              'An optional link to where customers see the price. This is a new field.',
              'Not shown on the public page yet.',
              i.owner.state === 'you-claimed'
                ? 'You own this integration, so you set it directly.'
                : 'Only the owner can set it for now: there is no change request for this link yet.',
            ],
            field: null,
            edit: 'pricingUrl',
            clamp: false,
            input: 'url',
          },
        ],
      },
      {
        title: 'Ownership',
        tip: null,
        rows: [
          {
            key: 'owner',
            label: 'Owner',
            value: owner.value,
            empty: false,
            tip: [
              OWNER_DEFINITION,
              'Shows as "Offered by" on the public page.',
              'AEC Integrations decides who the owner is. Request a change if it is wrong.',
              owner.reason,
            ],
            field: 'owner',
            edit: null,
            clamp: false,
          },
          {
            key: 'maintained',
            label: 'Kept up to date by',
            value: maintained,
            empty: false,
            tip: [
              'Who keeps the details up to date: the owner once it has claimed the integration, otherwise AEC Integrations.',
              'The public page shows "AEC Integrations maintained" or "Vendor maintained" at the top.',
              'It changes when the owner claims the integration.',
            ],
            field: null,
            edit: null,
            clamp: false,
          },
          {
            key: 'added',
            label: 'Added by',
            value: `AEC Integrations, ${formatDay(i.addedAt)}`,
            empty: false,
            tip: [
              'Who first added the integration to the directory, and when.',
              'Not shown on the public page.',
            ],
            field: null,
            edit: null,
            clamp: false,
          },
        ],
      },
    ];
  });

  protected contestOn(f: IntegrationContestField): VendorContest | null {
    return openContestFor(this.integration(), f);
  }
  protected flagText(c: VendorContest): string {
    return contestFlagText(c);
  }
  protected rowTarget(key: string): string {
    return rowId(key);
  }
  protected requestTarget(id: string): string {
    return requestItemId(id);
  }
  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected requestChange(field: IntegrationContestField): void {
    this.store.requestFormFor.set({ id: this.integration().id, field });
    this.goTo.emit('requests');
  }
  protected edit(row: FactRow): void {
    const empty = row.empty || row.value === 'Not set';
    this.draft.set(empty ? '' : row.value);
    this.error.set(null);
    this.editing.set(row.key);
  }
  protected save(event: Event, row: FactRow): void {
    event.preventDefault();
    if (!row.edit) return;
    const value = this.draft().trim();
    if (row.input === 'url' && value !== '' && !/^https:\/\/\S+$/.test(value)) {
      this.error.set('The link has to start with https://.');
      return;
    }
    if (row.max && value.length > row.max) {
      this.error.set(`Keep it to ${row.max} characters or fewer.`);
      return;
    }
    if (row.edit === 'name' && value === '') {
      this.error.set('The name cannot be empty.');
      return;
    }
    this.store.saveDetail(this.integration().id, row.edit, value || null);
    this.editing.set(null);
  }

  protected onOwnerAction(): void {
    const i = this.integration();
    switch (this.ownerInfo().action) {
      case 'claim':
        this.store.claim(i.id);
        break;
      case 'request-owner':
        this.store.requestFormFor.set({ id: i.id, field: 'owner' });
        this.goTo.emit('requests');
        break;
      case 'request-pending': {
        const pending = openOwnerRequest(i);
        if (pending) this.goToItem.emit(requestItemId(pending.id));
        break;
      }
    }
  }
}

// ─── Data that's shared ──────────────────────────────────────────────────────

/**
 * Data that's shared: one compact row per type of data, with a two-way Yes / No
 * toggle and a status pill whose tooltip carries both companies' reasons.
 *
 * No needs a reason (round 3): pressing No opens {@link ImAnswerForm} under the
 * row, and the answer changes only on Save. Yes saves at once, except when the
 * other company said No: then Yes opens the same form for an optional note, so
 * both sides can explain. Pressing the chosen side again clears the answer.
 */
@Component({
  selector: 'aec-im-shared',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImTip, ImAnswerForm],
  styles: [IM_STYLES],
  template: `
    @let i = integration();
    @if (adding()) {
      <form
        class="im-well mb-4 space-y-3 p-4 text-sm"
        (submit)="add($event)"
        aria-label="Add data that is shared"
      >
        <p [id]="idBase() + '-how'" class="max-w-prose text-(--text-secondary)">{{ addHelp() }}</p>
        <div class="flex flex-wrap items-end gap-3">
          <div>
            <label [for]="idBase() + '-type'" [class]="label">Data</label>
            <select
              #firstField
              [id]="idBase() + '-type'"
              class="im-input mt-1 min-w-[12rem]"
              [attr.aria-describedby]="idBase() + '-how'"
              (change)="draftType.set(selectValue($event))"
            >
              @for (t of infoTypes; track t.what) {
                <option [value]="t.what" [selected]="draftType() === t.what">{{ t.what }}</option>
              }
            </select>
          </div>
          <div>
            <label [for]="idBase() + '-dir'" [class]="label">Direction</label>
            <select
              [id]="idBase() + '-dir'"
              class="im-input mt-1 min-w-[12rem]"
              (change)="draftDirection.set(asDirection(selectValue($event)))"
            >
              <option value="outbound">{{ direction('outbound') }}</option>
              <option value="inbound">{{ direction('inbound') }}</option>
              <option value="both">{{ direction('both') }}</option>
            </select>
          </div>
        </div>
        <div>
          <label [for]="idBase() + '-note'" [class]="label">
            {{ i.ownsBoth ? 'Note for AEC Integrations' : 'Note for ' + i.other.vendor }}
            <span class="font-normal text-(--text-secondary)">(optional)</span>
          </label>
          <textarea
            [id]="idBase() + '-note'"
            rows="2"
            maxlength="2000"
            class="im-input mt-1"
            [attr.aria-describedby]="idBase() + '-note-help'"
            [value]="draftNote()"
            (input)="draftNote.set(textValue($event))"
          ></textarea>
          <p [id]="idBase() + '-note-help'" class="mt-1 text-(--text-secondary)">
            {{
              i.ownsBoth
                ? 'Only AEC Integrations sees this.'
                : 'Only ' + i.other.vendor + ' and AEC Integrations see this.'
            }}
          </p>
        </div>
        <div class="flex flex-wrap gap-3">
          <button type="submit" [class]="primary">Add</button>
          <button type="button" [class]="secondary" (click)="closeAdd()">Cancel</button>
        </div>
      </form>
    }

    @if (readOnly()) {
      <p class="mb-3 text-sm text-(--text-secondary)">
        AEC Integrations keeps these up to date. They run through {{ i.how.connector }}, so neither
        company answers for them.
      </p>
    }

    @if (i.flows.length === 0) {
      <p class="text-sm text-(--text-secondary)">No data is listed as shared yet.</p>
    } @else {
      <div class="overflow-x-auto">
        <table class="w-full min-w-[36rem] border-collapse text-sm">
          <caption class="sr-only">
            Data that is shared between
            {{
              viewerProduct
            }}
            and
            {{
              i.other.name
            }}
          </caption>
          <thead>
            <tr class="border-b border-(--border-default)">
              <th scope="col" class="py-2 pe-4 text-start font-semibold text-(--text-secondary)">
                <span class="inline-flex items-center gap-1"
                  >Data<aec-im-tip
                    label="About data"
                    [lines]="[
                      'The type of information that moves between the two products. Rows belong to the two product companies, not to the owner of the integration.',
                    ]"
                /></span>
              </th>
              <th scope="col" class="py-2 pe-4 text-start font-semibold text-(--text-secondary)">
                <span class="inline-flex items-center gap-1"
                  >Direction<aec-im-tip
                    label="About direction"
                    [lines]="[
                      'Which way the data moves. The public page groups rows by direction, and its direction chip is worked out from them.',
                    ]"
                /></span>
              </th>
              <th scope="col" class="py-2 pe-4 text-start font-semibold text-(--text-secondary)">
                <span class="inline-flex items-center gap-1"
                  >Your answer<aec-im-tip
                    label="About your answer"
                    [lines]="[
                      'Whether your company says the row is right. Only the badge it produces is public. Your reason is not.',
                    ]"
                /></span>
              </th>
              <th scope="col" class="py-2 text-start font-semibold text-(--text-secondary)">
                <span class="inline-flex items-center gap-1"
                  >Status<aec-im-tip
                    label="About status"
                    [lines]="[
                      'Where the row stands. The public page shows a badge: Both vendors confirmed, Confirmed by one company, Unverified, or Vendors disagree.',
                    ]"
                /></span>
              </th>
            </tr>
          </thead>
          <tbody>
            @for (f of i.flows; track f.id) {
              @let s = status(f);
              <tr
                [id]="flowTarget(f.id)"
                tabindex="-1"
                class="scroll-mt-24 border-b border-(--border-default) focus:outline-none"
              >
                <th scope="row" class="py-2 pe-4 text-start font-semibold text-(--text-primary)">
                  {{ f.what }}
                </th>
                <td class="py-2 pe-4 text-(--text-primary)">
                  <span class="inline-flex items-center gap-1.5">
                    @switch (f.direction) {
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
                    {{ direction(f.direction) }}
                  </span>
                </td>
                <td class="py-2 pe-4">
                  @if (canAnswer()) {
                    <div
                      class="im-seg"
                      role="group"
                      [attr.aria-label]="'Your answer: ' + sentence(f)"
                    >
                      <button
                        type="button"
                        class="im-seg-btn inline-flex items-center gap-1 px-2.5 py-1 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                        [attr.aria-pressed]="f.mine === 'yes'"
                        [attr.aria-expanded]="yesOpensForm(f) ? formFor() === f.id + ':yes' : null"
                        aria-label="Yes, this is right"
                        (click)="pressYes(f)"
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
                        Yes
                      </button>
                      <button
                        type="button"
                        class="im-seg-btn inline-flex items-center gap-1 px-2.5 py-1 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                        [attr.aria-pressed]="f.mine === 'no'"
                        [attr.aria-expanded]="f.mine === 'no' ? null : formFor() === f.id + ':no'"
                        aria-label="No, this is wrong"
                        (click)="pressNo(f)"
                        [attr.data-testid]="'no-' + f.id"
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
                        No
                      </button>
                    </div>
                  } @else {
                    <span class="text-(--text-secondary)">Not needed</span>
                  }
                </td>
                <td class="py-2">
                  <span class="inline-flex items-center gap-1">
                    <aec-im-tip
                      variant="pill"
                      [label]="s.label"
                      [tone]="s.tone"
                      [lines]="lines(f)"
                    />
                    @if (s.tone === 'conflict') {
                      <aec-im-tip
                        variant="flag"
                        [label]="'Open disagreement on ' + f.what"
                        [lines]="[disputeText(f)]"
                        (activate)="goToItem.emit(disputeTarget(f.id))"
                      />
                    }
                  </span>
                </td>
              </tr>
              @if (formFor() === f.id + ':no' || formFor() === f.id + ':yes') {
                <tr class="border-b border-(--border-default)">
                  <td colspan="4" class="pb-3">
                    <aec-im-answer-form
                      [integration]="i"
                      [flow]="f"
                      [mode]="formFor() === f.id + ':no' ? 'no' : 'yes'"
                      (closed)="closeForm(f)"
                    />
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
export class ImShared {
  private readonly store = inject(IntegrationManagerStore);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly integration = input.required<ImIntegration>();
  /** Kept for concept B's markup; the table serves every width now. */
  readonly layout = input<'table' | 'list'>('table');
  readonly goToItem = output<string>();

  protected readonly viewerProduct = VIEWER.product;
  protected readonly infoTypes = IM_INFO_TYPES;
  protected readonly draftType = signal(IM_INFO_TYPES[2].what);
  protected readonly draftDirection = signal<FlowDirection>('outbound');
  protected readonly draftNote = signal('');
  /** Which row's answer form is open: "flowId:no" or "flowId:yes". */
  protected readonly formFor = signal<string | null>(null);

  private readonly firstField = viewChild<ElementRef<HTMLSelectElement>>('firstField');

  protected readonly adding = computed(() => this.store.addingFlowFor() === this.integration().id);
  protected readonly canAnswer = computed(
    () => !isConnector(this.integration()) && !this.integration().retired,
  );
  protected readonly idBase = computed(() => `im-shared-${this.integration().id}`);
  protected readonly readOnly = computed(() => isConnector(this.integration()));
  /**
   * How adding a row really works. Data rows belong to the two product companies,
   * not to the integration's owner, so a row is added directly rather than
   * requested. It is recorded as confirmed by the viewer, and the other company
   * is asked to confirm it (an open item in its Change requests).
   */
  protected readonly addHelp = computed(() => {
    const i = this.integration();
    if (i.ownsBoth) {
      return 'Both products are yours, so the row is recorded as confirmed by you and nobody else needs to confirm it.';
    }
    return `Rows of data belong to the two product companies, not to the integration's owner, so you add this directly. It is recorded as confirmed by you and shows publicly as "Confirmed by ${VIEWER.vendor}" until ${i.other.vendor} answers. ${i.other.vendor} is asked to confirm it.`;
  });

  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly label = LABEL;

  constructor() {
    effect(() => this.firstField()?.nativeElement.focus());
  }

  protected status(f: ImFlow) {
    return flowStatus(f, this.integration());
  }
  protected lines(f: ImFlow): readonly string[] {
    return statusLines(f, this.integration());
  }
  protected sentence(f: ImFlow): string {
    return flowSentence(f, this.integration());
  }
  protected direction(d: FlowDirection): string {
    return directionShort(d, this.integration().other.name);
  }
  protected disputeText(f: ImFlow): string {
    return disputeFlagText(f, this.integration());
  }
  protected flowTarget(id: string): string {
    return flowRowId(id);
  }
  protected disputeTarget(id: string): string {
    return disputeItemId(id);
  }
  /** Yes opens a note form only when the other company said No. */
  protected yesOpensForm(f: ImFlow): boolean {
    return f.mine !== 'yes' && f.theirs === 'no';
  }
  protected pressYes(f: ImFlow): void {
    if (f.mine === 'yes') {
      this.store.setAnswer(this.integration().id, f.id, null);
    } else if (this.yesOpensForm(f)) {
      this.formFor.set(`${f.id}:yes`);
    } else {
      this.formFor.set(null);
      this.store.setAnswer(this.integration().id, f.id, 'yes');
    }
  }
  /** No always asks for a reason; pressing it again clears the answer. */
  protected pressNo(f: ImFlow): void {
    if (f.mine === 'no') {
      this.store.setAnswer(this.integration().id, f.id, null);
      return;
    }
    this.formFor.set(this.formFor() === `${f.id}:no` ? null : `${f.id}:no`);
  }
  /** Close the form and hand focus back to the row's control. */
  protected closeForm(f: ImFlow): void {
    const which = this.formFor()?.endsWith(':yes') ? 'Yes, this is right' : 'No, this is wrong';
    this.formFor.set(null);
    queueMicrotask(() =>
      (this.host.nativeElement as HTMLElement)
        .querySelector<HTMLButtonElement>(`#${flowRowId(f.id)} button[aria-label="${which}"]`)
        ?.focus(),
    );
  }
  protected selectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }
  protected asDirection(value: string): FlowDirection {
    return value === 'inbound' || value === 'both' ? value : 'outbound';
  }
  protected textValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }
  protected closeAdd(): void {
    this.draftNote.set('');
    this.store.addingFlowFor.set(null);
  }
  protected add(event: Event): void {
    event.preventDefault();
    const type = IM_INFO_TYPES.find((t) => t.what === this.draftType()) ?? IM_INFO_TYPES[0];
    this.store.addFlow(
      this.integration().id,
      type.what,
      type.whatInSentence,
      this.draftDirection(),
      this.draftNote().trim() || null,
    );
    this.closeAdd();
  }
}

// ─── Integration links ───────────────────────────────────────────────────────

type RecordLinkKey = 'listingUrl' | 'docsUrl' | 'website' | 'mechanismUrl';

interface RecordLinkRow {
  readonly key: RecordLinkKey;
  readonly field: IntegrationContestField;
  readonly label: string;
  readonly value: string | null;
}

/**
 * Integration links (round 3): every link on the integration, grouped by who
 * provides it.
 *
 * 1. The integration's own links (listing page, documentation, website,
 *    connection link): contestable fields. The claimed owner edits them; anyone
 *    else gets "Request a change", which opens the correction form on that field.
 *    An open request flags the row.
 * 2. Each of the viewer's products' own links (own_links): pencil to edit inline.
 *    When the viewer owns both products, both sides are editable.
 * 3. The other company's own links: read-only, with a lock and who provides them.
 */
@Component({
  selector: 'aec-im-links',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImTip, NgTemplateOutlet],
  styles: [IM_STYLES],
  template: `
    @let i = integration();
    <div class="space-y-6 text-sm">
      <div>
        <div class="flex items-center gap-1">
          <h4 class="im-h4">On the integration</h4>
          <aec-im-tip label="About the integration's links" [lines]="[recordTip()]" />
        </div>
        @if (i.how.connector && i.owner.state !== 'you-claimed') {
          <p class="mt-1 text-(--text-secondary)">
            Links come from {{ i.how.connector }}. Request a change if one is wrong.
          </p>
        }
        <dl class="mt-1 divide-y divide-(--border-default)">
          @for (row of recordRows(); track row.key) {
            <div
              [id]="rowTarget(row.field)"
              tabindex="-1"
              class="grid scroll-mt-24 items-center gap-x-6 gap-y-1 py-1.5 focus:outline-none sm:grid-cols-[11rem_1fr]"
            >
              <dt class="flex items-center gap-1 text-(--text-secondary)">
                {{ row.label }}
                <aec-im-tip [label]="'About ' + row.label" [lines]="recordLabelTip(row)" />
              </dt>
              <dd class="flex min-w-0 items-center gap-2">
                @if (editing() === 'record:' + row.key) {
                  <ng-container
                    *ngTemplateOutlet="
                      editor;
                      context: { label: row.label, target: 'record:' + row.key }
                    "
                  />
                } @else {
                  @if (i.how.connector && row.key === 'listingUrl' && row.value) {
                    <a
                      [href]="row.value"
                      target="_blank"
                      rel="noopener"
                      class="font-medium text-(--accent-primary) underline-offset-4 hover:underline"
                    >
                      View on {{ i.how.connector }}
                      <span class="sr-only">(opens in a new tab)</span>
                    </a>
                  } @else {
                    <span
                      [class]="
                        'min-w-0 break-all ' +
                        (row.value ? 'text-(--text-primary)' : 'text-(--text-secondary)')
                      "
                      >{{ row.value ?? 'Not set' }}</span
                    >
                  }
                  @if (contestOn(row.field); as c) {
                    <aec-im-tip
                      variant="flag"
                      [label]="'Open change request on ' + row.label"
                      [lines]="[flagText(c)]"
                      (activate)="goToItem.emit(requestTarget(c.id))"
                    />
                  }
                  <span class="ms-auto flex shrink-0 items-center">
                    @if (!i.retired) {
                      @switch (i.owner.state) {
                        @case ('you-claimed') {
                          <button
                            type="button"
                            [class]="iconButton"
                            [attr.aria-label]="'Edit ' + row.label"
                            (click)="edit('record:' + row.key, row.value)"
                          >
                            <ng-container *ngTemplateOutlet="pencil" />
                          </button>
                        }
                        @case ('you-unclaimed') {
                          <button
                            type="button"
                            [class]="rowAction"
                            [attr.aria-label]="'Claim to edit ' + row.label"
                            (click)="goToItem.emit(rowTarget('owner'))"
                          >
                            Claim to edit
                          </button>
                        }
                        @default {
                          @if (!contestOn(row.field)) {
                            <button
                              type="button"
                              [class]="rowAction"
                              [attr.aria-label]="'Request a change to ' + row.label"
                              (click)="requestChange(row.field)"
                              [attr.data-testid]="'request-' + row.field"
                            >
                              Request a change
                            </button>
                          }
                        }
                      }
                    }
                  </span>
                }
              </dd>
            </div>
          }
        </dl>
      </div>

      @for (side of i.sides; track side.product) {
        <div>
          <div class="flex items-center gap-1.5">
            <h4 class="im-h4">{{ side.product }}</h4>
            @if (side.mine) {
              <span class="text-(--text-secondary)">Your product</span>
              <aec-im-tip
                [label]="'About the links for ' + side.product"
                [lines]="[sideTip(side.product)]"
              />
            } @else {
              <svg
                aria-hidden="true"
                class="h-3.5 w-3.5 text-(--text-secondary)"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span class="text-(--text-secondary)">Provided by {{ side.vendor }}</span>
              <aec-im-tip
                [label]="'About the links from ' + side.vendor"
                [lines]="[otherTip(side.vendor)]"
              />
            }
          </div>
          <dl class="mt-1 divide-y divide-(--border-default)">
            @for (kind of sideKinds; track kind.key) {
              @let value = side.links[kind.key];
              <div class="grid items-center gap-x-6 gap-y-1 py-1.5 sm:grid-cols-[11rem_1fr]">
                <dt class="flex items-center gap-1 text-(--text-secondary)">
                  {{ kind.label }}
                  <aec-im-tip
                    [label]="'About ' + kind.label + ' for ' + side.product"
                    [lines]="sideLabelTip(side, kind.key)"
                  />
                </dt>
                <dd class="flex min-w-0 items-center gap-2">
                  @if (editing() === 'side:' + side.product + ':' + kind.key) {
                    <ng-container
                      *ngTemplateOutlet="
                        editor;
                        context: {
                          label: kind.label + ' for ' + side.product,
                          target: 'side:' + side.product + ':' + kind.key,
                        }
                      "
                    />
                  } @else {
                    <span
                      [class]="
                        'min-w-0 flex-1 break-all ' +
                        (value ? 'text-(--text-primary)' : 'text-(--text-secondary)')
                      "
                      >{{ value ?? 'Not added yet' }}</span
                    >
                    @if (side.mine && actions() && !i.retired) {
                      <button
                        type="button"
                        [class]="iconButton"
                        [attr.aria-label]="'Edit ' + kind.label + ' for ' + side.product"
                        (click)="edit('side:' + side.product + ':' + kind.key, value)"
                      >
                        <ng-container *ngTemplateOutlet="pencil" />
                      </button>
                    }
                  }
                </dd>
              </div>
            }
          </dl>
        </div>
      } @empty {
        <p class="text-(--text-secondary)">
          Products cannot add their own links to an integration that runs through
          {{ i.how.connector ?? 'a connector' }}.
        </p>
      }
    </div>

    <ng-template #editor let-label="label" let-target="target">
      <form
        class="flex min-w-0 flex-1 flex-wrap items-center gap-2"
        (submit)="save($event, target)"
      >
        <input
          #editField
          type="url"
          class="im-input min-w-[16rem] flex-1"
          [attr.aria-label]="label"
          [value]="draft()"
          (input)="draft.set(inputValue($event))"
          placeholder="https://"
        />
        <button type="submit" [class]="primary">Save</button>
        <button type="button" [class]="secondary" (click)="cancel()">Cancel</button>
        @if (error()) {
          <p role="alert" class="basis-full font-medium text-(--status-error)">{{ error() }}</p>
        }
      </form>
    </ng-template>

    <ng-template #pencil>
      <svg
        aria-hidden="true"
        class="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path
          d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"
        />
        <path d="m15 5 4 4" />
      </svg>
    </ng-template>
  `,
})
export class ImLinks {
  private readonly store = inject(IntegrationManagerStore);

  readonly integration = input.required<ImIntegration>();
  readonly actions = input(true);
  readonly idSuffix = input('');
  readonly goTo = output<SectionKey>();
  readonly goToItem = output<string>();

  protected readonly sideKinds = [
    { key: 'listing' as const, label: 'Where customers get it' },
    { key: 'docs' as const, label: 'Setup guide' },
  ];
  /** "record:<key>" or "side:<product>:<kind>". */
  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);

  /**
   * Listing page and Documentation only (ruled 2026-09-28): website and connection
   * link never render publicly. Connector rows keep all four until the separate
   * connector-links investigation reports.
   */
  protected readonly recordRows = computed<readonly RecordLinkRow[]>(() => {
    const i = this.integration();
    const d = i.details;
    const rows: RecordLinkRow[] = [
      {
        key: 'listingUrl',
        field: 'listing_url',
        label: fieldLabel('listing_url'),
        value: d.listingUrl,
      },
      { key: 'docsUrl', field: 'docs_url', label: fieldLabel('docs_url'), value: d.docsUrl },
      { key: 'website', field: 'website', label: fieldLabel('website'), value: d.website },
      {
        key: 'mechanismUrl',
        field: 'mechanism_url',
        label: fieldLabel('mechanism_url'),
        value: d.mechanismUrl,
      },
    ];
    return rows.slice(0, 2);
  });
  protected readonly recordTip = computed(() => {
    const i = this.integration();
    switch (i.owner.state) {
      case 'you-claimed':
        return 'You own this integration, so you edit these directly. Changes go live on the public page straight away.';
      case 'you-unclaimed':
        return 'You are the recorded owner. Claim the integration to edit these.';
      case 'other-claimed':
        return `${i.owner.name} owns this integration and keeps these up to date. Request a change if one is wrong.`;
      default:
        return 'No company has taken over this integration, so AEC Integrations keeps these. Request a change if one is wrong.';
    }
  });

  private readonly editField = viewChild<ElementRef<HTMLInputElement>>('editField');

  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly iconButton = ICON_BUTTON;
  protected readonly rowAction = ROW_ACTION;

  constructor() {
    effect(() => this.editField()?.nativeElement.focus());
    // Concept D's action bar opens the first of the viewer's own links.
    effect(() => {
      if (this.store.editingLinksFor() !== this.integration().id) return;
      untracked(() => {
        const side = this.integration().sides.find((s) => s.mine);
        if (side) this.edit(`side:${side.product}:listing`, side.links.listing);
        this.store.editingLinksFor.set(null);
      });
    });
  }

  protected recordLabelTip(row: RecordLinkRow): readonly string[] {
    const i = this.integration();
    const listing = row.field === 'listing_url';
    const who =
      i.owner.state === 'you-claimed'
        ? 'You own this integration, so you change it directly.'
        : i.owner.state === 'you-unclaimed'
          ? 'Claim the integration to change it.'
          : i.owner.state === 'other-claimed'
            ? `${i.owner.name} changes it. Request a change if it is wrong.`
            : 'AEC Integrations keeps it. Request a change if it is wrong.';
    if (i.how.connector) {
      return [
        listing
          ? `Where customers find the integration on ${i.how.connector}.`
          : `The help article for the integration on ${i.how.connector}.`,
        `Shows below the integration's card on the public page as "${listing ? 'View listing' : 'Documentation'}".`,
        who,
      ];
    }
    return [
      listing
        ? "The integration's own listing page."
        : "The integration's own help or setup article.",
      `Shows below the integration's card on the public page as "${listing ? 'View listing' : 'Documentation'}", unless either company adds its own ${listing ? 'listing' : 'setup guide'} link, which shows instead.`,
      who,
    ];
  }
  protected sideLabelTip(side: ImSide, kind: 'listing' | 'docs'): readonly string[] {
    const listing = kind === 'listing';
    return [
      listing
        ? `Where customers get it for ${side.product}.`
        : `How to set it up in ${side.product}.`,
      `Shows below the integration's card on the public page as "${side.vendor} ${listing ? 'listing' : 'documentation'}".`,
      side.mine ? 'Your company changes it.' : `Only ${side.vendor} changes it.`,
    ];
  }
  protected sideTip(product: string): string {
    return `Your own links for ${product}. The public page shows them beside ${product}. Where no company adds a link, it falls back to the integration's link.`;
  }
  protected otherTip(vendor: string): string {
    return `Only ${vendor} can change these. If one is wrong, tell ${vendor}.`;
  }
  protected contestOn(f: IntegrationContestField): VendorContest | null {
    return openContestFor(this.integration(), f);
  }
  protected flagText(c: VendorContest): string {
    return contestFlagText(c);
  }
  protected rowTarget(key: string): string {
    return rowId(key);
  }
  protected requestTarget(id: string): string {
    return requestItemId(id);
  }
  protected requestChange(field: IntegrationContestField): void {
    this.store.requestFormFor.set({ id: this.integration().id, field });
    this.goTo.emit('requests');
  }
  protected edit(target: string, value: string | null): void {
    this.draft.set(value ?? '');
    this.error.set(null);
    this.editing.set(target);
  }
  protected cancel(): void {
    this.editing.set(null);
  }
  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected save(event: Event, target: string): void {
    event.preventDefault();
    const value = this.draft().trim();
    if (value !== '' && !/^https:\/\/\S+$/.test(value)) {
      this.error.set('The link has to start with https://.');
      return;
    }
    const id = this.integration().id;
    if (target.startsWith('record:')) {
      this.store.saveRecordLink(id, target.slice(7) as RecordLinkKey, value || null);
    } else {
      const [, product, kind] = target.split(':');
      this.store.saveSideLink(id, product, kind === 'docs' ? 'docs' : 'listing', value || null);
    }
    this.editing.set(null);
  }
}

// ─── Change requests ─────────────────────────────────────────────────────────

type OpenItem =
  | { readonly kind: 'dispute'; readonly id: string; readonly flow: ImFlow }
  | { readonly kind: 'added-them'; readonly id: string; readonly flow: ImFlow }
  | { readonly kind: 'added-you'; readonly id: string; readonly flow: ImFlow }
  | { readonly kind: 'received'; readonly id: string; readonly contest: VendorContest }
  | { readonly kind: 'contest'; readonly id: string; readonly contest: VendorContest };

/**
 * Change requests: one searchable list of everything open between the two
 * companies and AEC Integrations, and a collapsed history.
 *
 * Open items, by kind:
 * - `received`: a change request another company sent the viewer as owner.
 *   Accept or Decline, with an optional note (vendor-contests-list.ts's flow).
 * - `added-them`: the other company added a row of data. "Is this right?" Yes,
 *   or No with a reason. In the model this is a vendor-created claim the viewer
 *   has not attested; the item itself is new (see the report).
 * - `added-you`: a row the viewer added, waiting on the other company.
 * - `dispute`: the two companies disagree about a row (a claim in conflict).
 * - `contest`: a correction the viewer sent.
 *
 * Only `contest` and `received` are field contests. The rest come from claims and
 * attestations, merged here in the browser. Nothing here is a message thread:
 * each side has one note, and "Replies coming soon" marks where a reply would go.
 */
@Component({
  selector: 'aec-im-requests',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImAnswerForm],
  styles: [IM_STYLES],
  template: `
    @let i = integration();
    <div class="flex flex-wrap items-center gap-3">
      <div class="relative min-w-[14rem] flex-1 sm:max-w-sm">
        <label [for]="idBase() + '-search'" class="sr-only">Search change requests</label>
        <svg
          aria-hidden="true"
          class="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m21 21-4.34-4.34" />
          <circle cx="11" cy="11" r="8" />
        </svg>
        <input
          [id]="idBase() + '-search'"
          type="search"
          class="im-input im-input-search"
          placeholder="Search requests, values or notes"
          [value]="store.requestQuery()"
          (input)="store.requestQuery.set(inputValue($event))"
        />
      </div>
      <div class="flex items-center gap-1.5" role="group" aria-label="Show">
        @for (c of chips; track c.key) {
          <button
            type="button"
            class="im-chip rounded-(--radius-pill) px-3 py-1 text-sm text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            [attr.aria-pressed]="store.requestFilter() === c.key"
            (click)="store.requestFilter.set(c.key)"
          >
            {{ c.label }}
          </button>
        }
      </div>
      @if (actions() && !owner() && !i.retired && !formOpen()) {
        <button type="button" [class]="primary" class="ms-auto" (click)="openForm()">
          Request a correction
        </button>
      }
    </div>
    @if (i.owner.state === 'you-claimed') {
      <p class="mt-3 text-sm text-(--text-secondary)">
        You own this integration. Change requests other companies send about its details come to you
        here.
      </p>
    } @else if (owner()) {
      <p class="mt-3 text-sm text-(--text-secondary)">
        You are the recorded owner. Claim the integration to edit its details and decide requests
        from other companies.
      </p>
    }

    @if (formOpen()) {
      <form
        class="im-well mt-4 space-y-4 p-4"
        (submit)="send($event)"
        [attr.aria-labelledby]="idBase() + '-form-title'"
      >
        <p [id]="idBase() + '-form-title'" class="im-h4">Request a correction</p>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label [for]="idBase() + '-field'" [class]="label">What is wrong?</label>
            <select
              #firstField
              [id]="idBase() + '-field'"
              class="im-input mt-1"
              (change)="pickField($event)"
            >
              <option value="" [selected]="draftField() === null" disabled>Choose a detail</option>
              @for (f of fields; track f) {
                <option
                  [value]="f"
                  [selected]="draftField() === f"
                  [disabled]="f === 'owner' && ownerPending()"
                >
                  {{ fieldName(f)
                  }}{{ f === 'owner' && ownerPending() ? ' (you already asked)' : '' }}
                </option>
              }
            </select>
          </div>
          @if (draftField(); as field) {
            <div>
              <p [class]="label">On the public page now</p>
              <p class="mt-2 truncate text-sm text-(--text-primary)">{{ current(field) }}</p>
            </div>
          }
        </div>
        @if (draftField(); as field) {
          <div>
            <label [for]="idBase() + '-value'" [class]="label">What it should say</label>
            @if (field === 'owner') {
              <select
                [id]="idBase() + '-value'"
                class="im-input mt-1"
                (change)="draftValue.set(inputValue($event))"
              >
                <option value="Autodesk" [selected]="draftValue() === 'Autodesk'">
                  Autodesk (your company)
                </option>
                <option value="Neither company" [selected]="draftValue() === 'Neither company'">
                  Neither company
                </option>
              </select>
            } @else {
              <input
                [id]="idBase() + '-value'"
                type="text"
                class="im-input mt-1"
                [value]="draftValue()"
                (input)="draftValue.set(inputValue($event))"
              />
            }
          </div>
          <div>
            <label [for]="idBase() + '-reason'" [class]="label">Why is it wrong?</label>
            <textarea
              [id]="idBase() + '-reason'"
              rows="3"
              class="im-input mt-1"
              [attr.aria-describedby]="idBase() + '-route'"
              [value]="draftReason()"
              (input)="draftReason.set(inputValue($event))"
            ></textarea>
            <p [id]="idBase() + '-route'" class="mt-1 text-sm text-(--text-secondary)">
              At least 20 characters. {{ routeFor(field) }}
            </p>
          </div>
        }
        @if (error()) {
          <p role="alert" class="text-sm font-medium text-(--status-error)">{{ error() }}</p>
        }
        <div class="flex flex-wrap gap-3">
          <button type="submit" [class]="primary">Send request</button>
          <button type="button" [class]="secondary" (click)="closeForm()">Cancel</button>
        </div>
      </form>
    }

    @if (store.requestFilter() !== 'closed') {
      <div class="mt-6">
        <p role="heading" [attr.aria-level]="subLevel()" class="im-h4">
          Open ({{ openItems().length }})
        </p>
        @if (openItems().length === 0) {
          <p class="mt-2 text-sm text-(--text-secondary)">
            {{ query() ? 'No open requests match your search.' : 'Nothing is open.' }}
          </p>
        } @else {
          <ul class="mt-2 list-none space-y-3 p-0">
            @for (item of openItems(); track item.id) {
              <li
                [id]="item.id"
                tabindex="-1"
                class="im-well scroll-mt-24 p-4 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-(--accent-primary)"
              >
                @switch (item.kind) {
                  @case ('received') {
                    @let c = item.contest;
                    @let o = receivedOutcome(c);
                    <p class="text-(--text-secondary)">
                      Change request from {{ c.submitter_vendor.name }} · sent
                      {{ when(c.created_at) }}
                    </p>
                    <p class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-semibold text-(--text-primary)"
                        >{{ fieldName(c.field) }}: {{ value(c, 'current') }} →
                        {{ value(c, 'proposed') }}</span
                      >
                      <span class="im-pill" [attr.data-tone]="o.tone">{{ o.label }}</span>
                    </p>
                    <blockquote class="mt-2 rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                      <p class="font-semibold text-(--text-secondary)">
                        {{ owns(c.submitter_vendor.name) }} reason
                      </p>
                      <p class="mt-0.5 text-(--text-primary)">{{ c.reason }}</p>
                    </blockquote>
                    <p class="mt-1 text-(--text-secondary)">Replies coming soon</p>
                    <div class="mt-3">
                      <label [for]="item.id + '-note'" [class]="label"
                        >Note to {{ c.submitter_vendor.name }}
                        <span class="font-normal text-(--text-secondary)">(optional)</span></label
                      >
                      <textarea
                        [id]="item.id + '-note'"
                        rows="2"
                        maxlength="2000"
                        class="im-input mt-1"
                        [attr.aria-describedby]="item.id + '-note-help'"
                        [value]="decisionNote(c.id)"
                        (input)="setDecisionNote(c.id, $event)"
                      ></textarea>
                      <p [id]="item.id + '-note-help'" class="mt-1 text-(--text-secondary)">
                        If you decline, say why, so {{ c.submitter_vendor.name }} knows what would
                        change your mind.
                      </p>
                    </div>
                    <div class="mt-3 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        [class]="primary"
                        (click)="decide(c, 'accept')"
                        [attr.data-testid]="'accept-' + c.id"
                      >
                        Accept<span class="sr-only">: {{ fieldName(c.field) }}</span>
                      </button>
                      <button type="button" [class]="secondary" (click)="decide(c, 'decline')">
                        Decline<span class="sr-only">: {{ fieldName(c.field) }}</span>
                      </button>
                      <span class="text-(--text-secondary)"
                        >Accepting changes the public integration page right away.</span
                      >
                    </div>
                  }
                  @case ('added-them') {
                    @let f = item.flow;
                    <p class="text-(--text-secondary)">
                      Added row · {{ i.other.vendor }} · {{ day(f.addedAt ?? now) }}
                    </p>
                    <p class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-semibold text-(--text-primary)"
                        >{{ i.other.vendor }} added {{ f.what }}. Is this right?</span
                      >
                      <span class="im-pill" data-tone="attention">Needs your answer</span>
                    </p>
                    <p class="mt-1 text-(--text-primary)">
                      They say {{ clause(f) }}. Until you answer, the public page shows it as
                      "Confirmed by {{ i.other.vendor }}".
                    </p>
                    @if (f.addedNote) {
                      <blockquote
                        class="mt-2 rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2"
                      >
                        <p class="font-semibold text-(--text-secondary)">
                          {{ owns(i.other.vendor) }} note
                        </p>
                        <p class="mt-0.5 text-(--text-primary)">{{ f.addedNote }}</p>
                      </blockquote>
                    }
                    <p class="mt-1 text-(--text-secondary)">Replies coming soon</p>
                    @let af = answerForm();
                    @if (af && af.flowId === f.id) {
                      <div class="mt-3">
                        <aec-im-answer-form
                          [integration]="i"
                          [flow]="f"
                          [mode]="af.mode"
                          (closed)="answerForm.set(null)"
                        />
                      </div>
                    } @else {
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          [class]="secondary"
                          (click)="yes(f)"
                          [attr.data-testid]="'added-yes-' + f.id"
                        >
                          Yes, this is right
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          (click)="answerForm.set({ flowId: f.id, mode: 'no' })"
                        >
                          No, this is wrong
                        </button>
                      </div>
                    }
                  }
                  @case ('added-you') {
                    @let f = item.flow;
                    <p class="text-(--text-secondary)">
                      Added row · you · {{ day(f.addedAt ?? now) }}
                    </p>
                    <p class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-semibold text-(--text-primary)"
                        >You added {{ f.what }}. Waiting for {{ i.other.vendor }}.</span
                      >
                      <span class="im-pill" data-tone="neutral">Waiting</span>
                    </p>
                    <p class="mt-1 text-(--text-primary)">
                      {{ i.other.vendor }} is asked to confirm it. Until they answer, the public
                      page shows it as "Confirmed by {{ vendor }}".
                    </p>
                    @if (f.addedNote) {
                      <blockquote
                        class="mt-2 rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2"
                      >
                        <p class="font-semibold text-(--text-secondary)">
                          Your note for {{ i.other.vendor }}
                        </p>
                        <p class="mt-0.5 text-(--text-primary)">{{ f.addedNote }}</p>
                      </blockquote>
                    }
                    <p class="mt-1 text-(--text-secondary)">Replies coming soon</p>
                  }
                  @case ('dispute') {
                    @let f = item.flow;
                    <p class="text-(--text-secondary)">
                      Disagreement · raised {{ day(raised(f)) }}
                    </p>
                    <p class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-semibold text-(--text-primary)">{{ title(f) }}</span>
                      <span class="im-pill" data-tone="conflict">Disputed</span>
                    </p>
                    <div class="mt-3 grid gap-3 sm:grid-cols-2">
                      <div class="rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                        <p class="font-semibold text-(--text-secondary)">
                          Your answer: {{ f.mine === 'yes' ? 'Yes' : 'No' }}
                        </p>
                        @if (f.mine === 'no') {
                          <p class="mt-0.5 text-(--text-primary)">You say {{ why(f) }}.</p>
                        }
                        <p class="mt-0.5 text-(--text-primary)">
                          {{ f.myNote ?? 'You have not given a reason.' }}
                        </p>
                      </div>
                      <div class="rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                        <p class="font-semibold text-(--text-secondary)">
                          {{ owns(i.other.vendor) }} answer: {{ f.theirs === 'yes' ? 'Yes' : 'No' }}
                        </p>
                        <p class="mt-0.5 text-(--text-primary)">
                          {{ f.theirNote ?? 'They have not given a reason.' }}
                        </p>
                      </div>
                    </div>
                    <p class="mt-1 text-(--text-secondary)">Replies coming soon</p>
                    <p class="mt-2 text-(--text-primary)">
                      If neither answer changes by {{ reviewDay(f) }}, AEC Integrations reviews it
                      and emails you both.
                    </p>
                    @let df = answerForm();
                    @if (df && df.flowId === f.id) {
                      <div class="mt-3">
                        <aec-im-answer-form
                          [integration]="i"
                          [flow]="f"
                          [mode]="df.mode"
                          (closed)="answerForm.set(null)"
                        />
                      </div>
                    } @else {
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          [class]="secondary"
                          (click)="
                            answerForm.set({ flowId: f.id, mode: f.mine === 'yes' ? 'no' : 'yes' })
                          "
                        >
                          Change my answer to {{ f.mine === 'yes' ? 'No' : 'Yes' }}
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          (click)="
                            answerForm.set({ flowId: f.id, mode: f.mine === 'no' ? 'no' : 'yes' })
                          "
                          [attr.data-testid]="'edit-reason-' + f.id"
                        >
                          {{ f.myNote ? 'Edit my reason' : 'Add my reason' }}
                        </button>
                        @if (f.kept) {
                          <span class="text-(--text-secondary)">You kept your answer.</span>
                        } @else {
                          <button type="button" [class]="link" (click)="keep(f)">
                            Keep my answer
                          </button>
                        }
                      </div>
                    }
                  }
                  @case ('contest') {
                    @let c = item.contest;
                    @let o = outcome(c);
                    <p class="text-(--text-secondary)">
                      Correction · sent {{ when(c.created_at) }}
                    </p>
                    <p class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <span class="font-semibold text-(--text-primary)"
                        >{{ fieldName(c.field) }}: {{ value(c, 'current') }} →
                        {{ value(c, 'proposed') }}</span
                      >
                      <span class="im-pill" [attr.data-tone]="o.tone">{{ o.label }}</span>
                    </p>
                    <p class="mt-2 text-(--text-primary)">{{ o.explain }}</p>
                    @if (confirming() === c.id) {
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        <span class="text-(--text-primary)">Withdraw this request?</span>
                        <button type="button" [class]="secondary" (click)="withdraw(c)">
                          Yes, withdraw it
                        </button>
                        <button type="button" [class]="link" (click)="confirming.set(null)">
                          Keep it
                        </button>
                      </div>
                    } @else if (c.status === 'open') {
                      <button
                        type="button"
                        [class]="link"
                        class="mt-3"
                        (click)="confirming.set(c.id)"
                        [attr.aria-label]="'Withdraw request: ' + fieldName(c.field)"
                      >
                        Withdraw request
                      </button>
                    }
                  }
                }
              </li>
            }
          </ul>
        }
      </div>
    }

    @if (store.requestFilter() !== 'open') {
      <div class="mt-6">
        <p role="heading" [attr.aria-level]="subLevel()" class="im-h4">
          Closed ({{ closedItems().length }})
        </p>
        @if (closedItems().length === 0) {
          <p class="mt-2 text-sm text-(--text-secondary)">
            {{ query() ? 'No closed requests match your search.' : 'No past requests.' }}
          </p>
        } @else {
          <ul class="im-card mt-2 list-none divide-y divide-(--border-default) p-0">
            @for (c of closedItems(); track c.id) {
              @let o = closedOutcome(c);
              @let isOpen = expanded().has(c.id);
              <li [id]="target(c.id)" tabindex="-1" class="scroll-mt-24 text-sm focus:outline-none">
                <button
                  type="button"
                  class="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-start hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                  [attr.aria-expanded]="isOpen"
                  [attr.aria-controls]="target(c.id) + '-body'"
                  (click)="toggleItem(c.id)"
                >
                  <svg
                    aria-hidden="true"
                    class="h-4 w-4 shrink-0 text-(--text-secondary) transition-transform rtl:-scale-x-100"
                    [class.rotate-90]="isOpen"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  <span class="w-32 shrink-0 font-semibold text-(--text-primary)">{{
                    fieldName(c.field)
                  }}</span>
                  <span class="min-w-0 flex-1 truncate text-(--text-primary)"
                    >{{ value(c, 'current') }} → {{ value(c, 'proposed') }}</span
                  >
                  <span class="im-pill shrink-0" [attr.data-tone]="o.tone">{{ o.label }}</span>
                  <span class="w-28 shrink-0 text-end text-(--text-secondary)">{{
                    day(c.decided_at ?? c.updated_at)
                  }}</span>
                </button>
                @if (isOpen) {
                  <div [id]="target(c.id) + '-body'" class="px-4 pb-4 ps-11">
                    <p class="text-(--text-primary)">{{ o.explain }}</p>
                    <ol
                      class="im-rail ms-1.5 mt-3 list-none space-y-3 p-0 ps-5"
                      [attr.aria-label]="'What happened: ' + fieldName(c.field)"
                    >
                      @for (e of closedEvents(c); track e.at + e.text) {
                        <li class="relative">
                          <span
                            aria-hidden="true"
                            class="im-rail-dot absolute -start-[1.625rem] top-1.5 h-3 w-3 rounded-full"
                          ></span>
                          <p class="text-(--text-primary)">
                            {{ e.text }}
                            <span class="text-(--text-secondary)">{{ when(e.at) }}</span>
                          </p>
                          @if (e.note) {
                            <blockquote
                              class="mt-1 max-w-prose rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2"
                            >
                              <p class="font-semibold text-(--text-secondary)">{{ e.noteBy }}</p>
                              <p class="mt-0.5 text-(--text-primary)">{{ e.note }}</p>
                            </blockquote>
                          }
                        </li>
                      }
                    </ol>
                  </div>
                }
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class ImRequests {
  protected readonly store = inject(IntegrationManagerStore);

  readonly integration = input.required<ImIntegration>();
  /** The aria-level of the "Open" and "Closed" subheadings. */
  readonly subLevel = input(4);
  readonly actions = input(true);
  readonly idSuffix = input('');

  protected readonly now = PREVIEW_NOW;
  protected readonly vendor = VIEWER.vendor;
  protected readonly fields = REQUEST_FIELDS;
  protected readonly chips = [
    { key: 'all' as const, label: 'All' },
    { key: 'open' as const, label: 'Open' },
    { key: 'closed' as const, label: 'Closed' },
  ];
  protected readonly owner = computed(() => isOwner(this.integration()));
  protected readonly ownerPending = computed(() => openOwnerRequest(this.integration()) !== null);
  protected readonly formOpen = computed(
    () => this.store.requestFormFor()?.id === this.integration().id,
  );
  protected readonly idBase = computed(() => `im-req-form-${this.integration().id}`);
  protected readonly query = computed(() => this.store.requestQuery().trim().toLowerCase());

  protected readonly openItems = computed<readonly OpenItem[]>(() => {
    const i = this.integration();
    const q = this.query();
    const match = (text: string) => !q || text.toLowerCase().includes(q);
    const flowText = (f: ImFlow) =>
      [f.what, f.addedNote, f.theirNote, f.myNote, i.other.vendor, 'added row'].join(' ');
    return [
      ...receivedOpen(i)
        .filter((c) => match(contestSearchText(c) + ' ' + c.submitter_vendor.name))
        .map((c) => ({ kind: 'received' as const, id: requestItemId(c.id), contest: c })),
      ...addedByThem(i)
        .filter((f) => match(flowText(f)))
        .map((f) => ({ kind: 'added-them' as const, id: addedItemId(f.id), flow: f })),
      ...disputes(i)
        .filter((f) => match(disputeSearchText(f, i)))
        .map((f) => ({ kind: 'dispute' as const, id: disputeItemId(f.id), flow: f })),
      ...addedByYou(i)
        .filter((f) => match(flowText(f)))
        .map((f) => ({ kind: 'added-you' as const, id: addedItemId(f.id), flow: f })),
      ...openRequests(i)
        .filter((c) => match(contestSearchText(c)))
        .map((c) => ({ kind: 'contest' as const, id: requestItemId(c.id), contest: c })),
    ];
  });
  protected readonly closedItems = computed(() => {
    const q = this.query();
    const i = this.integration();
    return [...receivedPast(i), ...pastRequests(i)].filter(
      (c) => !q || (contestSearchText(c) + ' ' + c.submitter_vendor.name.toLowerCase()).includes(q),
    );
  });

  protected readonly draftField = signal<IntegrationContestField | null>(null);
  protected readonly draftValue = signal('');
  protected readonly draftReason = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** The row whose answer form is open inside an item, and which answer it saves. */
  protected readonly answerForm = signal<{ flowId: string; mode: 'yes' | 'no' } | null>(null);
  private readonly decisionNotes = signal<Readonly<Record<string, string>>>({});

  private readonly firstField = viewChild<ElementRef<HTMLSelectElement>>('firstField');

  protected readonly label = LABEL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly link = BTN_LINK;

  constructor() {
    effect(() => {
      const el = this.firstField();
      if (!el) return;
      const field = this.store.requestFormFor()?.field ?? null;
      untracked(() => {
        this.draftField.set(field);
        this.draftValue.set(field === 'owner' ? 'Autodesk' : '');
        this.draftReason.set('');
        this.error.set(null);
      });
      el.nativeElement.focus();
    });
  }

  protected fieldName(field: IntegrationContestField): string {
    return fieldLabel(field);
  }
  protected current(field: IntegrationContestField): string {
    return currentValue(this.integration(), field);
  }
  protected routeFor(field: IntegrationContestField): string {
    return requestRouteLine(this.integration(), field);
  }
  protected value(c: VendorContest, which: 'current' | 'proposed'): string {
    return requestValue(c, which);
  }
  protected outcome(c: VendorContest) {
    return requestOutcome(c);
  }
  protected receivedOutcome(c: VendorContest) {
    return receivedOutcome(c);
  }
  protected closedOutcome(c: VendorContest) {
    return isReceived(c) ? receivedOutcome(c) : requestOutcome(c);
  }
  protected closedEvents(c: VendorContest) {
    return isReceived(c) ? receivedEvents(c) : requestEvents(c);
  }
  protected when(iso: string): string {
    return formatWhen(iso);
  }
  protected day(iso: string): string {
    return formatDay(iso);
  }
  protected target(id: string): string {
    return requestItemId(id);
  }
  protected raised(f: ImFlow): string {
    return disputeRaised(f);
  }
  protected reviewDay(f: ImFlow): string {
    return disputeReviewDay(f);
  }
  protected title(f: ImFlow): string {
    return disputeTitle(f, this.integration());
  }
  protected clause(f: ImFlow): string {
    return flowClause(f, this.integration());
  }
  protected why(f: ImFlow): string {
    return reasonSummary(f, this.integration());
  }
  protected owns(name: string): string {
    return possessive(name);
  }
  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
  protected decisionNote(id: string): string {
    return this.decisionNotes()[id] ?? '';
  }
  protected setDecisionNote(id: string, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.decisionNotes.update((notes) => ({ ...notes, [id]: value }));
  }
  protected decide(c: VendorContest, decision: 'accept' | 'decline'): void {
    const note = this.decisionNote(c.id).trim();
    this.store.decideReceived(this.integration().id, c.id, decision, note || null);
  }
  protected yes(f: ImFlow): void {
    this.store.setAnswer(this.integration().id, f.id, 'yes');
  }
  protected toggleItem(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  protected keep(f: ImFlow): void {
    this.store.keepAnswer(this.integration().id, f.id);
  }
  protected pickField(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as IntegrationContestField;
    this.draftField.set(value);
    this.draftValue.set(value === 'owner' ? 'Autodesk' : '');
  }
  protected openForm(): void {
    this.store.requestFormFor.set({ id: this.integration().id, field: null });
  }
  protected closeForm(): void {
    this.store.requestFormFor.set(null);
  }
  protected send(event: Event): void {
    event.preventDefault();
    const field = this.draftField();
    if (!field) {
      this.error.set('Choose which detail is wrong.');
      return;
    }
    if (field !== 'owner' && this.draftValue().trim() === '') {
      this.error.set('Say what it should say instead.');
      return;
    }
    if (this.draftReason().trim().length < 20) {
      this.error.set('Give a reason of at least 20 characters.');
      return;
    }
    this.error.set(null);
    this.store.sendRequest(
      this.integration().id,
      field,
      this.current(field),
      this.draftValue().trim(),
      this.draftReason().trim(),
    );
  }
  protected withdraw(c: VendorContest): void {
    this.confirming.set(null);
    this.store.withdraw(this.integration().id, c.id);
  }
}

// ─── Retire ──────────────────────────────────────────────────────────────────

/** The danger area. Only the owner of a claimed integration can retire it. */
@Component({
  selector: 'aec-im-retire',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [IM_STYLES],
  template: `
    @let i = integration();
    @if (i.owner.state === 'you-claimed') {
      <div class="im-danger p-4 text-sm">
        @if (i.retired) {
          <p class="font-semibold text-(--text-primary)">This integration is retired</p>
          <p class="mt-1 max-w-prose text-(--text-secondary)">
            It is hidden from the public page and from search.
          </p>
          <button type="button" [class]="secondary" class="mt-3" (click)="restore()">
            Restore integration
          </button>
        } @else {
          <p class="font-semibold text-(--text-primary)">Retire this integration</p>
          <p class="mt-1 max-w-prose text-(--text-secondary)">
            Hides it from the public page and search, and closes open correction requests. You can
            restore it later.
          </p>
          @if (confirming()) {
            <div class="mt-3 flex flex-wrap items-center gap-3">
              <span class="text-(--text-primary)">Retire it now?</span>
              <button type="button" [class]="danger" (click)="retire()">Yes, retire it</button>
              <button type="button" [class]="secondary" (click)="confirming.set(false)">
                Cancel
              </button>
            </div>
          } @else {
            <button type="button" [class]="secondary" class="mt-3" (click)="confirming.set(true)">
              Retire integration
            </button>
          }
        }
      </div>
    } @else if (showWhenNotOwner()) {
      <p class="max-w-prose text-sm text-(--text-secondary)">{{ notOwnerLine() }}</p>
    }
  `,
})
export class ImRetire {
  private readonly store = inject(IntegrationManagerStore);

  readonly integration = input.required<ImIntegration>();
  readonly showWhenNotOwner = input(false);

  protected readonly confirming = signal(false);
  protected readonly notOwnerLine = computed(() =>
    this.integration().owner.state === 'you-unclaimed'
      ? 'Once you claim this integration, you can retire it here if it is no longer offered.'
      : 'Only the owner can retire an integration. If it is no longer offered, request a correction and say so.',
  );

  protected readonly secondary = BTN_SECONDARY;
  protected readonly danger = BTN_DANGER;

  protected retire(): void {
    this.confirming.set(false);
    this.store.setRetired(this.integration().id, true);
  }
  protected restore(): void {
    this.store.setRetired(this.integration().id, false);
  }
}
