import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';

import {
  CONNECTOR_POWERED_FROZEN_EDIT_FIELDS,
  INTEGRATION_EDIT_MAX_LENGTH,
  OWNER_EDITABLE_MECHANISM_KINDS,
  type IntegrationEditField,
  type OfferedContestField,
  type VendorContest,
  type VendorIntegration,
} from '@aeci/shared';

import {
  claimErrorMessage,
  editSaveErrorMessage,
  editValueMessage,
} from '../components/vendor-integration-ownership-labels';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  contestItemId,
  contestValue,
  formatDay,
  howYouGetIt,
  notSetLabel,
  openOwnerRequest,
  openRequestOn,
  pageFieldLabel,
  rowTargetId,
  submittedOutcome,
  receivedOutcome,
  canClaim,
  isLive,
} from './integration-detail-model';
import { IntegrationDetailState } from './integration-detail-state';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  ICON_BUTTON,
  ID_STYLES,
  ROW_ACTION,
} from './integration-detail-styles';
import { VendorTip } from './vendor-tip';

type RowKey = IntegrationEditField | 'owner' | 'maintained' | 'added';
type Control = 'text' | 'url' | 'textarea' | 'select';

interface Row {
  readonly key: RowKey;
  readonly label: string;
  readonly value: string;
  readonly empty: boolean;
  readonly tip: readonly string[];
  /** The contestable field, or `null` when nobody requests a change to it. */
  readonly field: OfferedContestField | null;
  /** The owner's edit field, or `null` when the owner does not edit it here. */
  readonly edit: IntegrationEditField | null;
  readonly control: Control;
  readonly clamp: boolean;
}

interface Group {
  readonly key: 'details' | 'ownership';
  readonly title: string;
  readonly rows: readonly Row[];
}

/** Who the caller is to this integration, for the row actions (§6.17.3). */
type Seat = 'owner-claimed' | 'owner-unclaimed' | 'other';

const PENCIL =
  'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z';

/**
 * The Overview section (AECI-1150, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.3).
 *
 * Two groups of rows, "Details" and "Ownership", in a `<dl>`: a label and one
 * value at one size. Every explanation lives in the label's tooltip. Each row has
 * the one action the caller's seat allows:
 *
 * - the claimed owner edits it in place with a pencil (`PATCH
 *   /api/vendor/integrations/:id`, one field, pessimistic, §4.5.6);
 * - the recorded owner before its claim gets "Claim to edit";
 * - anyone else gets "Request a change", which opens the Change requests form on
 *   that field, or the open-request flag when a request is already open. The page
 *   never tells a company to ask for a field it already has a request on
 *   (AECI-1143).
 *
 * No Direction row (ruled 2026-09-28): direction lives on the rows of data.
 */
@Component({
  selector: 'aec-integration-overview',
  imports: [VendorTip],
  styles: [ID_STYLES],
  template: `
    <div class="space-y-6">
      @for (group of groups(); track group.key) {
        <div>
          <h4 class="id-h4">{{ group.title }}</h4>
          <dl class="mt-1 divide-y divide-(--border-default)">
            @for (row of group.rows; track row.key) {
              <div
                [id]="rowId(row.key)"
                tabindex="-1"
                class="grid scroll-mt-20 items-start gap-x-6 gap-y-0.5 py-2 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-(--accent-primary) sm:grid-cols-[11rem_minmax(0,1fr)]"
                [attr.data-testid]="'overview-row-' + row.key"
              >
                <dt class="flex min-h-8 items-center gap-1 text-(--text-secondary)">
                  {{ row.label }}
                  <aec-vendor-tip [label]="aboutLabel(row.label)" [lines]="row.tip" />
                </dt>
                <dd class="flex min-h-8 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                  @if (editing() === row.key && row.edit) {
                    <form
                      class="flex min-w-0 flex-1 flex-wrap items-start gap-2"
                      [attr.aria-label]="editFormLabel(row.label)"
                      (submit)="save($event, row)"
                    >
                      @switch (row.control) {
                        @case ('textarea') {
                          <textarea
                            #editField
                            rows="3"
                            class="id-input min-w-0 flex-1 basis-full"
                            [attr.aria-label]="row.label"
                            [attr.maxlength]="max(row.edit)"
                            [attr.aria-invalid]="error() ? 'true' : null"
                            [attr.aria-describedby]="error() ? rowId(row.key) + '-error' : null"
                            [value]="draft()"
                            (input)="draft.set(inputValue($event))"
                          ></textarea>
                        }
                        @case ('select') {
                          <select
                            #editField
                            class="id-input min-w-[12rem] flex-1"
                            [attr.aria-label]="row.label"
                            (change)="draft.set(inputValue($event))"
                          >
                            @for (kind of kindOptions; track kind) {
                              <option [value]="kind" [selected]="draft() === kind">
                                {{ howLabel(kind) }}
                              </option>
                            }
                          </select>
                        }
                        @default {
                          <input
                            #editField
                            [type]="row.control === 'url' ? 'url' : 'text'"
                            class="id-input min-w-[14rem] flex-1"
                            [attr.aria-label]="row.label"
                            [attr.maxlength]="max(row.edit)"
                            [attr.inputmode]="row.control === 'url' ? 'url' : null"
                            [attr.placeholder]="row.control === 'url' ? 'https://' : null"
                            [attr.aria-invalid]="error() ? 'true' : null"
                            [attr.aria-describedby]="error() ? rowId(row.key) + '-error' : null"
                            [value]="draft()"
                            (input)="draft.set(inputValue($event))"
                          />
                        }
                      }
                      <div class="flex gap-2">
                        <button type="submit" [class]="primary" [disabled]="busy()">
                          <span i18n="@@vendor.im.edit.save">Save</span>
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          [disabled]="busy()"
                          (click)="cancelEdit(row)"
                          i18n="@@vendor.im.edit.cancel"
                        >
                          Cancel
                        </button>
                      </div>
                      @if (error()) {
                        <p
                          [id]="rowId(row.key) + '-error'"
                          role="alert"
                          [class]="alert"
                          class="basis-full"
                        >
                          {{ error() }}
                        </p>
                      }
                    </form>
                  } @else {
                    @if (row.clamp) {
                      <span class="min-w-0 max-w-prose flex-1 py-1">
                        <span
                          #clampValue
                          [id]="rowId(row.key) + '-value'"
                          [class]="
                            'break-words ' +
                            (expanded() ? 'block ' : 'line-clamp-2 ') +
                            (row.empty ? 'text-(--text-secondary)' : 'text-(--text-primary)')
                          "
                          data-testid="description-value"
                          >{{ row.value }}</span
                        >
                        @if (overflows() || expanded()) {
                          <button
                            type="button"
                            [class]="rowAction"
                            [attr.aria-expanded]="expanded()"
                            [attr.aria-controls]="rowId(row.key) + '-value'"
                            (click)="expanded.set(!expanded())"
                            data-testid="show-more"
                          >
                            @if (expanded()) {
                              <span i18n="@@vendor.im.showLess">Show less</span>
                            } @else {
                              <span i18n="@@vendor.im.showMore">Show more</span>
                            }
                          </button>
                        }
                      </span>
                    } @else {
                      <span
                        [class]="
                          'min-w-0 break-words py-1 ' +
                          (row.empty ? 'text-(--text-secondary)' : 'text-(--text-primary)')
                        "
                        >{{ row.value }}</span
                      >
                    }
                    @if (row.field && flagFor(row.field); as c) {
                      <aec-vendor-tip
                        variant="flag"
                        [testId]="'flag-' + row.key"
                        [label]="flagLabel(row.label)"
                        [lines]="[flagText(c)]"
                        (activate)="state.jumpTo(requestTarget(c), true)"
                      />
                    }
                    <span class="ms-auto flex shrink-0 items-center">
                      @if (live()) {
                        @if (row.key === 'owner') {
                          @switch (ownerAction()) {
                            @case ('claim') {
                              <button
                                type="button"
                                [class]="rowAction"
                                [disabled]="claiming()"
                                (click)="claim()"
                                data-testid="claim-integration"
                                i18n="@@vendor.im.owner.claim"
                              >
                                Claim this integration
                              </button>
                            }
                            @case ('ask') {
                              <button
                                type="button"
                                [class]="rowAction"
                                (click)="askToOwn()"
                                data-testid="ask-owner"
                                i18n="@@vendor.im.owner.ask"
                              >
                                Ask to be recorded as the owner
                              </button>
                            }
                            @case ('see') {
                              <button
                                type="button"
                                [class]="rowAction"
                                (click)="seeOwnerRequest()"
                                data-testid="see-owner-request"
                                i18n="@@vendor.im.owner.see"
                              >
                                See your request
                              </button>
                            }
                          }
                        } @else {
                          @switch (seat()) {
                            @case ('owner-claimed') {
                              @if (row.edit && canEdit(row.edit)) {
                                <button
                                  #pencil
                                  type="button"
                                  [class]="iconButton"
                                  [attr.aria-label]="editLabel(row.label)"
                                  [attr.data-row]="row.key"
                                  [attr.data-testid]="'edit-' + row.key"
                                  (click)="edit(row)"
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
                                    <path [attr.d]="pencilPath" />
                                    <path d="m15 5 4 4" />
                                  </svg>
                                </button>
                              }
                            }
                            @case ('owner-unclaimed') {
                              @if (row.edit && claimAllowed()) {
                                <button
                                  type="button"
                                  [class]="rowAction"
                                  [attr.aria-label]="claimToEditLabel(row.label)"
                                  (click)="state.jumpTo(rowId('owner'))"
                                  i18n="@@vendor.im.claimToEdit"
                                >
                                  Claim to edit
                                </button>
                              }
                            }
                            @default {
                              @if (row.field && !flagFor(row.field)) {
                                <button
                                  type="button"
                                  [class]="rowAction"
                                  [attr.aria-label]="requestLabel(row.label)"
                                  [attr.data-testid]="'request-' + row.key"
                                  (click)="state.openRequestForm(row.field)"
                                  i18n="@@vendor.im.requestChange"
                                >
                                  Request a change
                                </button>
                              }
                            }
                          }
                        }
                      }
                    </span>
                  }
                  @if (row.key === 'owner' && claimError()) {
                    <p role="alert" [class]="alert" class="basis-full">{{ claimError() }}</p>
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
export class IntegrationOverview {
  protected readonly state = inject(IntegrationDetailState);
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  readonly integration = input.required<VendorIntegration>();

  private readonly editField = viewChild<ElementRef<HTMLElement>>('editField');
  private readonly clampValue = viewChild<ElementRef<HTMLElement>>('clampValue');
  private readonly pencils = viewChildren<ElementRef<HTMLButtonElement>>('pencil');

  protected readonly editing = signal<RowKey | null>(null);
  protected readonly draft = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly claiming = signal(false);
  protected readonly claimError = signal<string | null>(null);
  protected readonly expanded = signal(false);
  protected readonly overflows = signal(false);

  protected readonly live = computed(() => !this.integration().retired_at);
  private readonly connector = computed(() => !this.integration().attestable);

  protected readonly seat = computed<Seat>(() => {
    const i = this.integration();
    if (!i.is_owner) return 'other';
    return i.claimed_at ? 'owner-claimed' : 'owner-unclaimed';
  });

  protected readonly claimAllowed = computed(() =>
    canClaim(this.integration(), this.state.entitled()),
  );

  /** The Owner row's action (§6.17.3). */
  protected readonly ownerAction = computed<'claim' | 'ask' | 'see' | null>(() => {
    const i = this.integration();
    if (i.is_owner) return this.claimAllowed() ? 'claim' : null;
    if (i.owner !== null) return null;
    return openOwnerRequest(this.state.contests()) ? 'see' : 'ask';
  });

  protected readonly kindOptions = OWNER_EDITABLE_MECHANISM_KINDS;

  constructor() {
    // Measure the clamped description after each render. Browser only:
    // afterRenderEffect never runs on the server, so SSR shows the clamp alone.
    afterRenderEffect(() => {
      const el = this.clampValue()?.nativeElement;
      if (!el || this.expanded()) return;
      const over = el.scrollHeight > el.clientHeight + 1;
      if (over !== untracked(this.overflows)) this.overflows.set(over);
    });
  }

  /** Whether the claimed owner may edit this field: the connector-powered row
   *  needs a plan and keeps `mechanism_kind` frozen (§4.5.6). */
  protected canEdit(field: IntegrationEditField): boolean {
    if (!this.connector()) return true;
    return this.state.entitled() && !CONNECTOR_POWERED_FROZEN_EDIT_FIELDS.has(field);
  }

  protected readonly groups = computed<readonly Group[]>(() => {
    const i = this.integration();
    const f = i.contestable_fields;
    const who = this.whoChanges();
    const connectorName = i.powered_by?.name ?? null;
    const text = (field: IntegrationEditField, value: string | null | undefined) => ({
      value: value && value !== '' ? value : notSetLabel(),
      empty: !value,
      field: field === 'pricing_url' ? null : (field as OfferedContestField),
      edit: field,
    });
    const frozenKind = this.connector();
    return [
      {
        key: 'details',
        title: $localize`:@@vendor.im.overview.details:Details`,
        rows: [
          {
            key: 'name',
            label: pageFieldLabel('name'),
            ...text('name', f['name']),
            control: 'text',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.name:The integration's name, used here and in change requests.`,
              $localize`:@@vendor.im.tip.name.public:The public page uses it as the card title when there is no connection name.`,
              who,
            ],
          },
          {
            key: 'description',
            label: pageFieldLabel('description'),
            ...text('description', f['description']),
            control: 'textarea',
            clamp: true,
            tip: [
              $localize`:@@vendor.im.tip.description:What the integration does, in a sentence or two.`,
              $localize`:@@vendor.im.tip.description.public:Shows on the integration's card on the public page.`,
              who,
            ],
          },
          {
            key: 'mechanism_kind',
            label: pageFieldLabel('mechanism_kind'),
            value: howYouGetIt(f['mechanism_kind'] ?? i.mechanism_kind, connectorName),
            empty: !(f['mechanism_kind'] ?? i.mechanism_kind),
            field: 'mechanism_kind',
            edit: 'mechanism_kind',
            control: 'select',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.how:How customers get it: built into a product, a marketplace app, a direct connection, or through a connector service.`,
              $localize`:@@vendor.im.tip.how.public:Shows as a label on the integration's card on the public page.`,
              frozenKind
                ? $localize`:@@vendor.im.tip.how.frozen:It runs through a connector service, so this cannot be changed here. Request a change if it is wrong.`
                : who,
            ],
          },
          {
            key: 'mechanism_name',
            label: pageFieldLabel('mechanism_name'),
            ...text('mechanism_name', f['mechanism_name'] ?? i.mechanism_name),
            control: 'text',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.connectionName:The name of the feature or add-on that makes the connection.`,
              $localize`:@@vendor.im.tip.connectionName.public:Shows as the title of the integration's card on the public page.`,
              who,
            ],
          },
          {
            key: 'maturity',
            label: pageFieldLabel('maturity'),
            ...text('maturity', f['maturity']),
            control: 'text',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.maturity:Whether it is in beta or generally available, in your own words.`,
              $localize`:@@vendor.im.tip.maturity.public:Shows in the "At a glance" row of the integration's card on the public page.`,
              who,
            ],
          },
          {
            key: 'pricing_model',
            label: pageFieldLabel('pricing_model'),
            ...text('pricing_model', f['pricing_model']),
            control: 'text',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.pricing:What customers pay for it, in up to 200 characters.`,
              $localize`:@@vendor.im.tip.pricing.public:Shows in the "At a glance" row of the integration's card on the public page.`,
              who,
            ],
          },
          {
            key: 'pricing_url',
            label: pageFieldLabel('pricing_url'),
            ...text('pricing_url', i.pricing_url),
            control: 'url',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.pricingUrl:An optional link to where customers see the price.`,
              $localize`:@@vendor.im.tip.pricingUrl.public:The public page will link the price to it. That part is not live yet.`,
              this.seat() === 'owner-claimed'
                ? $localize`:@@vendor.im.tip.pricingUrl.owner:You own this integration, so you set it directly.`
                : $localize`:@@vendor.im.tip.pricingUrl.other:Only the owner sets it. Nobody requests a change to it.`,
            ],
          },
        ],
      },
      {
        key: 'ownership',
        title: $localize`:@@vendor.im.overview.ownership:Ownership`,
        rows: [
          {
            key: 'owner',
            label: pageFieldLabel('owner'),
            value: this.ownerValue(),
            empty: i.owner === null,
            field: 'owner',
            edit: null,
            control: 'text',
            clamp: false,
            tip: this.ownerTip(),
          },
          {
            key: 'maintained',
            label: $localize`:@@vendor.im.field.maintained:Kept up to date by`,
            value: this.maintainedValue(),
            empty: false,
            field: null,
            edit: null,
            control: 'text',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.maintained:Who keeps the details up to date: the owner once it claims the integration, otherwise AEC Integrations.`,
              $localize`:@@vendor.im.tip.maintained.public:The public page shows "AEC Integrations maintained" or "Vendor maintained".`,
              $localize`:@@vendor.im.tip.maintained.who:It changes when the owner claims the integration or edits it.`,
            ],
          },
          {
            key: 'added',
            label: $localize`:@@vendor.im.field.added:Added by`,
            value: this.addedValue(),
            empty: false,
            field: null,
            edit: null,
            control: 'text',
            clamp: false,
            tip: [
              $localize`:@@vendor.im.tip.added:Who first added the integration to the directory, and when.`,
              $localize`:@@vendor.im.tip.added.public:The public page says "Added by the vendor" when a company added it.`,
            ],
          },
        ],
      },
    ];
  });

  /** Who changes a detail, in one sentence, for its tooltip. */
  private readonly whoChanges = computed(() => {
    const i = this.integration();
    const owner = i.owner?.name ?? '';
    if (i.is_owner) {
      if (!i.claimed_at) {
        return $localize`:@@vendor.im.tip.who.ownerUnclaimed:Your company is the recorded owner. Claim the integration to change it.`;
      }
      if (this.connector() && !this.state.entitled()) {
        return $localize`:@@vendor.im.tip.who.ownerNoPlan:Editing an integration that runs through a connector service needs an active plan.`;
      }
      return $localize`:@@vendor.im.tip.who.owner:You own this integration, so you change it directly. Changes go live on the public page straight away.`;
    }
    if (i.owner === null) {
      return $localize`:@@vendor.im.tip.who.none:AEC Integrations keeps it until an owner takes over. Request a change if it is wrong.`;
    }
    return i.claimed_at
      ? $localize`:@@vendor.im.tip.who.other:${owner}:owner: owns this integration and decides a change. Request a change if it is wrong.`
      : $localize`:@@vendor.im.tip.who.otherUnclaimed:${owner}:owner: has not claimed it, so AEC Integrations reviews a change. Request a change if it is wrong.`;
  });

  private ownerValue(): string {
    const i = this.integration();
    if (i.owner === null) {
      return $localize`:@@vendor.im.owner.notRecorded:Not recorded yet`;
    }
    if (i.is_owner) {
      const name = i.owner.name;
      return $localize`:@@vendor.im.owner.you:${name}:company: (you)`;
    }
    return i.owner.name;
  }

  private ownerTip(): string[] {
    const i = this.integration();
    const lines = [
      $localize`:@@vendor.im.tip.owner:The company that offers this integration and keeps its details up to date.`,
      $localize`:@@vendor.im.tip.owner.public:Shows as "Offered by" on the public page.`,
    ];
    if (i.is_owner && !i.claimed_at && this.connector() && isLive(i) && !this.claimAllowed()) {
      lines.push(
        $localize`:@@vendor.im.tip.owner.needsPlan:Claiming an integration that runs through a connector service needs an active plan.`,
      );
    } else if (i.is_owner && i.claimed_at && this.connector() && !this.state.entitled()) {
      lines.push(
        $localize`:@@vendor.im.tip.owner.editNeedsPlan:Editing an integration that runs through a connector service needs an active plan.`,
      );
    } else if (!i.is_owner && i.owner !== null) {
      const owner = i.owner.name;
      lines.push(
        $localize`:@@vendor.im.tip.owner.decides:${owner}:owner: decides a request about its details. A request about the owner always goes to AEC Integrations.`,
      );
    } else {
      lines.push(
        $localize`:@@vendor.im.tip.owner.aeci:AEC Integrations decides who the owner is. A request about the owner always goes to AEC Integrations.`,
      );
    }
    return lines;
  }

  private maintainedValue(): string {
    const i = this.integration();
    const label =
      i.maintained_by === 'vendor'
        ? $localize`:@@vendor.im.maintained.vendor:Vendor maintained`
        : $localize`:@@vendor.im.maintained.aeci:AEC Integrations maintained`;
    if (!i.last_reviewed_at) return label;
    const date = formatDay(i.last_reviewed_at);
    return i.maintained_by === 'vendor'
      ? $localize`:@@vendor.im.maintained.updated:${label}:label:, updated ${date}:date:`
      : $localize`:@@vendor.im.maintained.reviewed:${label}:label:, reviewed ${date}:date:`;
  }

  private addedValue(): string {
    const i = this.integration();
    const date = formatDay(i.created_at);
    if (i.origin === 'vendor') {
      const who = i.owner?.name ?? $localize`:@@vendor.im.added.aCompany:A company`;
      return date ? `${who}, ${date}` : who;
    }
    return date
      ? $localize`:@@vendor.im.added.aeci:AEC Integrations, ${date}:date:`
      : $localize`:@@vendor.im.added.aeciNoDate:AEC Integrations`;
  }

  protected flagFor(field: OfferedContestField): VendorContest | null {
    return openRequestOn(this.state.contests(), field);
  }

  protected flagText(contest: VendorContest): string {
    const date = formatDay(contest.created_at);
    const from = contestValue(contest, 'current');
    const to = contestValue(contest, 'proposed');
    const received = this.state.contests().received.some((c) => c.id === contest.id);
    const status = received ? receivedOutcome(contest).label : submittedOutcome(contest).label;
    return $localize`:@@vendor.im.flag.text:Change requested ${date}:date:: from ${from}:from: to ${to}:to:. ${status}:status:. Select the flag to see the request.`;
  }

  protected requestTarget(contest: VendorContest): string {
    return contestItemId(contest.id);
  }

  protected rowId(key: string): string {
    return rowTargetId(key);
  }

  protected max(field: IntegrationEditField): number {
    return INTEGRATION_EDIT_MAX_LENGTH[field];
  }

  protected howLabel(kind: string): string {
    return howYouGetIt(kind, null);
  }

  protected aboutLabel(label: string): string {
    return $localize`:@@vendor.im.tip.about:About ${label}:label:`;
  }
  protected editLabel(label: string): string {
    return $localize`:@@vendor.im.edit.label:Edit ${label}:label:`;
  }
  protected editFormLabel(label: string): string {
    return $localize`:@@vendor.im.edit.form:Edit ${label}:label:`;
  }
  protected claimToEditLabel(label: string): string {
    return $localize`:@@vendor.im.claimToEdit.label:Claim to edit ${label}:label:`;
  }
  protected requestLabel(label: string): string {
    return $localize`:@@vendor.im.requestChange.label:Request a change to ${label}:label:`;
  }
  protected flagLabel(label: string): string {
    return $localize`:@@vendor.im.flag.label:Open change request on ${label}:label:`;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected readonly pencilPath = PENCIL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly iconButton = ICON_BUTTON;
  protected readonly rowAction = ROW_ACTION;
  protected readonly alert = ALERT;

  // ── Edit (§4.5.6) ──────────────────────────────────────────────────────────

  protected edit(row: Row): void {
    if (!row.edit) return;
    const i = this.integration();
    const current =
      row.edit === 'pricing_url' ? i.pricing_url : (i.contestable_fields[row.edit] ?? null);
    this.draft.set(current ?? (row.control === 'select' ? (this.kindOptions[0] ?? '') : ''));
    this.error.set(null);
    this.editing.set(row.key);
    afterNextRender(() => this.editField()?.nativeElement.focus(), { injector: this.injector });
  }

  protected cancelEdit(row: Row): void {
    this.editing.set(null);
    this.error.set(null);
    this.focusPencil(row.key);
  }

  protected async save(event: Event, row: Row): Promise<void> {
    event.preventDefault();
    const field = row.edit;
    if (!field || this.busy()) return;
    const raw = this.draft().trim();
    const value = raw === '' ? null : raw;
    const problem = editValueMessage(field, value);
    if (problem) {
      this.error.set(problem);
      return;
    }
    const i = this.integration();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.updateIntegration(i.id, {
        [field]: value,
        context_product_id: i.context_product.id,
      });
      this.splice(field, value);
      this.announcer.announce(
        $localize`:@@vendor.im.edit.saved:${row.label}:label: saved. It is live on the public page.`,
      );
      this.editing.set(null);
      this.focusPencil(row.key);
      void this.store.revalidate(['integrations']);
    } catch (err) {
      this.error.set(editSaveErrorMessage(err));
    } finally {
      this.busy.set(false);
    }
  }

  /** Put the saved value into every entry of this integration, so the row does not
   *  show the old value until the revalidation lands. The server said 200. */
  private splice(field: IntegrationEditField, value: string | null): void {
    const id = this.integration().id;
    this.store
      .apply('integrations', (list) =>
        list.map((entry) =>
          entry.id !== id
            ? entry
            : field === 'pricing_url'
              ? { ...entry, pricing_url: value, maintained_by: 'vendor' as const }
              : {
                  ...entry,
                  maintained_by: 'vendor' as const,
                  contestable_fields: { ...entry.contestable_fields, [field]: value },
                  ...(field === 'mechanism_kind' && value
                    ? { mechanism_kind: value as VendorIntegration['mechanism_kind'] }
                    : {}),
                  ...(field === 'mechanism_name' ? { mechanism_name: value } : {}),
                  ...(field === 'name' ? { name: value } : {}),
                },
        ),
      )
      .commit();
  }

  private focusPencil(key: RowKey): void {
    afterNextRender(
      () => {
        const pencil = this.pencils().find((p) => p.nativeElement.dataset['row'] === key);
        pencil?.nativeElement.focus();
      },
      { injector: this.injector },
    );
  }

  // ── Owner (§6.17.3) ────────────────────────────────────────────────────────

  protected async claim(): Promise<void> {
    if (this.claiming()) return;
    this.claiming.set(true);
    this.claimError.set(null);
    const connector = this.connector();
    try {
      await this.api.claimIntegration(this.integration().id);
      this.announcer.announce(
        connector
          ? $localize`:@@vendor.im.claim.doneConnector:You claimed this integration. AEC Integrations no longer updates it.`
          : $localize`:@@vendor.im.claim.done:You claimed this integration. You can now edit its details.`,
      );
      await this.store.revalidate(['integrations']);
      afterNextRender(
        () => {
          const first = this.pencils()[0]?.nativeElement;
          (first ?? this.document.getElementById(rowTargetId('owner')))?.focus();
        },
        { injector: this.injector },
      );
    } catch (err) {
      this.claimError.set(claimErrorMessage(err));
    } finally {
      this.claiming.set(false);
    }
  }

  protected askToOwn(): void {
    this.state.openRequestForm('owner');
  }

  protected seeOwnerRequest(): void {
    const request = openOwnerRequest(this.state.contests());
    if (request) this.state.jumpTo(contestItemId(request.id), true);
  }
}
