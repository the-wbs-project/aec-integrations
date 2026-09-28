import { DOCUMENT } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import type { ContestDecision, VendorClaim, VendorContest, VendorIntegration } from '@aeci/shared';

import { claimOutcomeLine } from '../components/vendor-claim-outcome';
import { VendorContestProtest } from '../components/vendor-contest-protest';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

import { IntegrationAnswerForm } from './integration-answer-form';
import {
  addedItemId,
  companyOrFallback,
  contestChange,
  contestEvents,
  contestItemId,
  contestSearchText,
  dataSentence,
  disagreementItemId,
  disagreements,
  formatDay,
  isAddedByYouWaiting,
  isContestOpen,
  isCounterpartAddedUnanswered,
  myAnswer,
  myNote,
  newestFirst,
  pageFieldLabel,
  possessive,
  receivedOutcome,
  submittedOutcome,
  theirAnswer,
  type Outcome,
  type RailEvent,
} from './integration-detail-model';
import { IntegrationDetailState, type RequestFilter } from './integration-detail-state';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  HELP,
  ID_STYLES,
  LABEL,
  ROW_ACTION,
} from './integration-detail-styles';
import { IntegrationRequestForm } from './integration-request-form';
import { VendorTip } from './vendor-tip';

type OpenItem =
  | {
      readonly kind: 'received';
      readonly id: string;
      readonly at: string;
      readonly contest: VendorContest;
    }
  | {
      readonly kind: 'added-them';
      readonly id: string;
      readonly at: string;
      readonly claim: VendorClaim;
    }
  | {
      readonly kind: 'disagreement';
      readonly id: string;
      readonly at: string;
      readonly claim: VendorClaim;
    }
  | {
      readonly kind: 'added-you';
      readonly id: string;
      readonly at: string;
      readonly claim: VendorClaim;
    }
  | {
      readonly kind: 'submitted';
      readonly id: string;
      readonly at: string;
      readonly contest: VendorContest;
    };

interface ClosedItem {
  readonly id: string;
  readonly at: string;
  readonly contest: VendorContest;
  readonly side: 'submitted' | 'received';
}

const KIND_ORDER: readonly OpenItem['kind'][] = [
  'received',
  'added-them',
  'disagreement',
  'added-you',
  'submitted',
];

/**
 * "Change requests" (AECI-1153, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.6).
 *
 * One list of everything open between the two companies and AEC Integrations
 * about this integration, and a collapsed history. It merges three sources on the
 * client: field contests (`GET /api/vendor/contests?integration_id=`),
 * disagreements (claims whose agreement is `conflict`), and rows the other company
 * added (claims with `added_by = 'counterpart'`). Only the first are contests.
 * Nothing here is a message thread: "Replies coming soon" marks where a reply
 * would go (AECI-1145).
 *
 * Every contest action uses the same endpoints and rules as the Messages tab's
 * Field contests block (§6.5), so the two cannot disagree. Protests reuse its
 * `aec-vendor-contest-protest` (§11b.12.12). Writes are pessimistic, announced
 * through the one live region, and re-read.
 */
@Component({
  selector: 'aec-integration-change-requests',
  imports: [VendorTip, IntegrationAnswerForm, IntegrationRequestForm, VendorContestProtest],
  styles: [ID_STYLES],
  template: `
    @let i = integration();
    <div class="flex items-center gap-1">
      <h3
        id="change-requests-heading"
        tabindex="-1"
        class="id-h3 text-(--text-primary) focus:outline-none"
        i18n="@@vendor.im.section.changeRequests"
      >
        Change requests
      </h3>
      <aec-vendor-tip [label]="aboutLabel" [lines]="[aboutTip]" />
    </div>

    <div class="mt-3 flex flex-wrap items-center gap-3">
      <div class="relative min-w-[14rem] flex-1 sm:max-w-sm">
        <label for="change-requests-search" class="sr-only" i18n="@@vendor.im.requests.searchLabel"
          >Search change requests</label
        >
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
          id="change-requests-search"
          type="search"
          autocomplete="off"
          class="id-input id-input-search"
          [attr.placeholder]="searchPlaceholder"
          [value]="state.requestQuery()"
          (input)="state.requestQuery.set(inputValue($event))"
          data-testid="requests-search"
        />
      </div>
      <div class="flex items-center gap-1.5" role="group" [attr.aria-label]="showLabel">
        @for (chip of chips; track chip.key) {
          <button
            type="button"
            class="id-chip min-h-8 rounded-(--radius-md) px-3 py-1 text-sm text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            [attr.aria-pressed]="state.requestFilter() === chip.key"
            [attr.data-testid]="'requests-filter-' + chip.key"
            (click)="state.requestFilter.set(chip.key)"
          >
            {{ chip.label }}
          </button>
        }
      </div>
      @if (canRequest() && !state.requestForm()) {
        <button
          type="button"
          [class]="primary"
          class="ms-auto"
          (click)="state.openRequestForm(null)"
          data-testid="request-correction"
          i18n="@@vendor.im.requests.requestCorrection"
        >
          Request a correction
        </button>
      }
    </div>
    @if (i.is_owner && i.claimed_at) {
      <p
        class="mt-3 max-w-prose text-sm text-(--text-secondary)"
        i18n="@@vendor.im.requests.ownerLine"
      >
        You own this integration. Change requests other companies send about its details come to you
        here.
      </p>
    } @else if (i.is_owner) {
      <p
        class="mt-3 max-w-prose text-sm text-(--text-secondary)"
        i18n="@@vendor.im.requests.unclaimedLine"
      >
        Claim the integration to edit its details and decide requests from other companies.
      </p>
    }

    @if (state.requestForm(); as form) {
      @if (canRequest()) {
        <aec-integration-request-form
          [integration]="i"
          [initialField]="form.field"
          [seq]="form.seq"
          (sent)="onSent($event)"
          (cancelled)="closeForm()"
        />
      }
    }

    @if (state.contestsStatus() === 'failed') {
      <div class="mt-4 flex flex-wrap items-center gap-3">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.im.requests.failed">
          Could not load the change requests.
        </p>
        <button type="button" [class]="secondary" (click)="retry()" i18n="@@vendor.im.retry">
          Try again
        </button>
      </div>
    }

    @if (state.requestFilter() !== 'closed') {
      <div class="mt-6" data-testid="requests-open">
        <h4 class="id-h4">{{ openHeading() }}</h4>
        @if (openItems().length === 0) {
          <p class="mt-2 text-sm text-(--text-secondary)">
            @if (query()) {
              <span i18n="@@vendor.im.requests.noOpenMatch"
                >No open requests match your search.</span
              >
            } @else {
              <span i18n="@@vendor.im.requests.noneOpen">Nothing is open.</span>
            }
          </p>
        } @else {
          <ul class="mt-2 list-none space-y-3 p-0">
            @for (item of openItems(); track item.id) {
              <li
                [id]="item.id"
                tabindex="-1"
                class="id-well scroll-mt-20 p-4 text-sm focus:outline-2 focus:outline-offset-2 focus:outline-(--accent-primary)"
                [attr.data-testid]="'request-item-' + item.kind"
              >
                @switch (item.kind) {
                  @case ('received') {
                    @let c = item.contest;
                    @let o = received(c);
                    <p class="text-(--text-secondary)">{{ receivedMeta(c) }}</p>
                    <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <p class="font-semibold text-(--text-primary)">{{ change(c) }}</p>
                      <aec-vendor-tip
                        variant="pill"
                        [label]="o.label"
                        [tone]="o.tone"
                        [lines]="[o.explain]"
                      />
                    </div>
                    <div class="mt-2 rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                      <p class="font-semibold text-(--text-secondary)">
                        {{ reasonOf(c.submitter_vendor.name) }}
                      </p>
                      <p class="mt-0.5 max-w-prose break-words text-(--text-primary)">
                        {{ c.reason }}
                      </p>
                    </div>
                    <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.im.requests.repliesSoon">
                      Replies coming soon
                    </p>
                    @if (c.status === 'open') {
                      <div class="mt-3">
                        <label [for]="item.id + '-note'" [class]="label"
                          >{{ noteTo(c.submitter_vendor.name) }}
                          <span
                            class="font-normal text-(--text-secondary)"
                            i18n="@@vendor.im.answer.optional"
                          >
                            (optional)</span
                          ></label
                        >
                        <textarea
                          [id]="item.id + '-note'"
                          rows="2"
                          maxlength="2000"
                          class="id-input mt-1"
                          [attr.aria-describedby]="item.id + '-note-help'"
                          [value]="noteFor(c.id)"
                          (input)="setNote(c.id, $event)"
                        ></textarea>
                        <p [id]="item.id + '-note-help'" [class]="help">
                          {{ declineHelp(c.submitter_vendor.name) }}
                        </p>
                      </div>
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          [class]="primary"
                          [disabled]="busy() !== null"
                          (click)="decide(c, 'accept')"
                          [attr.data-testid]="'accept-' + c.id"
                        >
                          <span i18n="@@vendor.im.requests.accept">Accept</span>
                          <span class="sr-only">: {{ fieldName(c) }}</span>
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          [disabled]="busy() !== null"
                          (click)="decide(c, 'decline')"
                          [attr.data-testid]="'decline-' + c.id"
                        >
                          <span i18n="@@vendor.im.requests.decline">Decline</span>
                          <span class="sr-only">: {{ fieldName(c) }}</span>
                        </button>
                        <span class="text-(--text-secondary)" i18n="@@vendor.im.requests.acceptHint"
                          >Accepting changes the public integration page right away.</span
                        >
                      </div>
                    }
                    <aec-vendor-contest-protest [contest]="c" side="received" />
                    @if (itemError()?.id === item.id) {
                      <p role="alert" [class]="alert" class="mt-2">{{ itemError()?.message }}</p>
                    }
                  }
                  @case ('added-them') {
                    @let claim = item.claim;
                    <p class="text-(--text-secondary)">{{ addedThemMeta(claim) }}</p>
                    <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <p class="font-semibold text-(--text-primary)">{{ addedThemTitle(claim) }}</p>
                      <span class="id-pill" data-tone="attention"
                        ><span
                          aria-hidden="true"
                          class="h-2 w-2 rounded-full bg-(--accent-secondary-deep)"
                        ></span
                        ><span i18n="@@vendor.im.row.needsAnswer">Needs your answer</span></span
                      >
                    </div>
                    <p class="mt-1 max-w-prose text-(--text-primary)">{{ addedThemBody(claim) }}</p>
                    @if (claim.counterparty?.note; as note) {
                      <div class="mt-2 rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                        <p class="font-semibold text-(--text-secondary)">{{ noteOfThem() }}</p>
                        <p class="mt-0.5 max-w-prose break-words text-(--text-primary)">
                          {{ note }}
                        </p>
                      </div>
                    }
                    <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.im.requests.repliesSoon">
                      Replies coming soon
                    </p>
                    @if (formFor() === item.id) {
                      <div class="mt-3">
                        <aec-integration-answer-form
                          [integration]="i"
                          [claim]="claim"
                          [mode]="formMode()"
                          (closed)="closeAnswer(item.id)"
                        />
                      </div>
                    } @else if (state.canAuthor()) {
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          [class]="secondary"
                          [disabled]="busy() !== null"
                          (click)="yes(item.id, claim)"
                          [attr.data-testid]="'added-yes-' + claim.id"
                          i18n="@@vendor.im.answer.yes.aria"
                        >
                          Yes, this is right
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          [disabled]="busy() !== null"
                          (click)="openAnswer(item.id, 'no')"
                          [attr.data-testid]="'added-no-' + claim.id"
                          i18n="@@vendor.im.answer.no.aria"
                        >
                          No, this is wrong
                        </button>
                      </div>
                    }
                    @if (itemError()?.id === item.id) {
                      <p role="alert" [class]="alert" class="mt-2">{{ itemError()?.message }}</p>
                    }
                  }
                  @case ('disagreement') {
                    @let claim = item.claim;
                    <p class="text-(--text-secondary)">{{ raisedLine(claim) }}</p>
                    <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <p class="font-semibold text-(--text-primary)">
                        {{ disagreementTitle(claim) }}
                      </p>
                      <span class="id-pill" data-tone="conflict"
                        ><svg
                          aria-hidden="true"
                          class="h-3 w-3"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="3"
                          stroke-linecap="round"
                        >
                          <path d="M7 7l10 10M17 7L7 17" /></svg
                        ><span i18n="@@vendor.im.row.disputed">Disputed</span></span
                      >
                    </div>
                    <div class="mt-3 grid gap-3 sm:grid-cols-2">
                      <div class="rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                        <p class="font-semibold text-(--text-secondary)">
                          {{ yourAnswerLine(claim) }}
                        </p>
                        <p class="mt-0.5 max-w-prose break-words text-(--text-primary)">
                          {{ yourReason(claim) }}
                        </p>
                      </div>
                      <div class="rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                        <p class="font-semibold text-(--text-secondary)">
                          {{ theirAnswerLine(claim) }}
                        </p>
                        <p class="mt-0.5 max-w-prose break-words text-(--text-primary)">
                          {{ theirReason(claim) }}
                        </p>
                      </div>
                    </div>
                    <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.im.requests.repliesSoon">
                      Replies coming soon
                    </p>
                    <p class="mt-2 max-w-prose text-(--text-primary)">{{ outcomeLine(claim) }}</p>
                    @if (formFor() === item.id) {
                      <div class="mt-3">
                        <aec-integration-answer-form
                          [integration]="i"
                          [claim]="claim"
                          [mode]="formMode()"
                          (closed)="closeAnswer(item.id)"
                        />
                      </div>
                    } @else if (state.canAuthor()) {
                      <div class="mt-3 flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          [class]="secondary"
                          (click)="openAnswer(item.id, flipTo(claim))"
                          [attr.data-testid]="'change-answer-' + claim.id"
                        >
                          {{ changeAnswerLabel(claim) }}
                        </button>
                        <button
                          type="button"
                          [class]="secondary"
                          (click)="openAnswer(item.id, currentMode(claim))"
                          [attr.data-testid]="'edit-reason-' + claim.id"
                        >
                          @if (hasMyNote(claim)) {
                            <span i18n="@@vendor.im.requests.editReason">Edit my reason</span>
                          } @else {
                            <span i18n="@@vendor.im.requests.addReason">Add my reason</span>
                          }
                        </button>
                      </div>
                    }
                  }
                  @case ('added-you') {
                    @let claim = item.claim;
                    <p class="text-(--text-secondary)">{{ addedYouMeta(claim) }}</p>
                    <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <p class="font-semibold text-(--text-primary)">{{ addedYouTitle(claim) }}</p>
                      <span class="id-pill"
                        ><span
                          aria-hidden="true"
                          class="h-2 w-2 rounded-full bg-(--text-secondary)"
                        ></span
                        ><span i18n="@@vendor.im.requests.waiting">Waiting</span></span
                      >
                    </div>
                    @if (myNoteOf(claim); as note) {
                      <div class="mt-2 rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2">
                        <p class="font-semibold text-(--text-secondary)">{{ yourNoteFor() }}</p>
                        <p class="mt-0.5 max-w-prose break-words text-(--text-primary)">
                          {{ note }}
                        </p>
                      </div>
                    }
                    <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.im.requests.repliesSoon">
                      Replies coming soon
                    </p>
                  }
                  @case ('submitted') {
                    @let c = item.contest;
                    @let o = submitted(c);
                    <p class="text-(--text-secondary)">{{ submittedMeta(c) }}</p>
                    <div class="mt-1 flex flex-wrap items-center justify-between gap-2">
                      <p class="font-semibold text-(--text-primary)">{{ change(c) }}</p>
                      <aec-vendor-tip
                        variant="pill"
                        [label]="o.label"
                        [tone]="o.tone"
                        [lines]="[o.explain]"
                      />
                    </div>
                    <p class="mt-2 max-w-prose text-(--text-primary)">{{ o.explain }}</p>
                    @if (c.status === 'open') {
                      @if (confirming() === c.id) {
                        <div class="mt-3 flex flex-wrap items-center gap-3">
                          <span
                            class="text-(--text-primary)"
                            i18n="@@vendor.im.requests.withdrawConfirm"
                            >Withdraw this request? It cannot be reopened.</span
                          >
                          <button
                            type="button"
                            [id]="'withdraw-yes-' + c.id"
                            [class]="secondary"
                            [disabled]="busy() !== null"
                            (click)="withdraw(item.id, c)"
                            i18n="@@vendor.im.requests.withdrawYes"
                          >
                            Yes, withdraw it
                          </button>
                          <button
                            type="button"
                            [class]="rowAction"
                            [disabled]="busy() !== null"
                            (click)="cancelWithdraw(c)"
                            i18n="@@vendor.im.requests.withdrawKeep"
                          >
                            Keep it
                          </button>
                        </div>
                      } @else {
                        <button
                          type="button"
                          [id]="'withdraw-' + c.id"
                          [class]="rowAction"
                          class="mt-3"
                          [attr.aria-label]="withdrawLabel(c)"
                          (click)="startWithdraw(c)"
                          [attr.data-testid]="'withdraw-' + c.id"
                          i18n="@@vendor.im.requests.withdraw"
                        >
                          Withdraw request
                        </button>
                      }
                    }
                    <aec-vendor-contest-protest [contest]="c" side="submitted" />
                    @if (itemError()?.id === item.id) {
                      <p role="alert" [class]="alert" class="mt-2">{{ itemError()?.message }}</p>
                    }
                  }
                }
              </li>
            }
          </ul>
        }
      </div>
    }

    @if (state.requestFilter() !== 'open') {
      <div class="mt-6" data-testid="requests-closed">
        <h4 class="id-h4">{{ closedHeading() }}</h4>
        @if (closedItems().length === 0) {
          <p class="mt-2 text-sm text-(--text-secondary)">
            @if (query()) {
              <span i18n="@@vendor.im.requests.noClosedMatch"
                >No closed requests match your search.</span
              >
            } @else {
              <span i18n="@@vendor.im.requests.noneClosed">No past requests.</span>
            }
          </p>
        } @else {
          <ul class="id-card mt-2 list-none divide-y divide-(--border-default) p-0">
            @for (item of closedItems(); track item.id) {
              @let o = closedOutcome(item);
              @let open = expanded().has(item.id);
              <li
                [id]="item.id"
                tabindex="-1"
                class="scroll-mt-20 text-sm focus:outline-2 focus:-outline-offset-2 focus:outline-(--accent-primary)"
              >
                <button
                  type="button"
                  class="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-start hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                  [attr.aria-expanded]="open"
                  [attr.aria-controls]="item.id + '-body'"
                  [attr.data-testid]="'closed-toggle-' + item.contest.id"
                  (click)="toggle(item.id)"
                >
                  <svg
                    aria-hidden="true"
                    class="h-4 w-4 shrink-0 text-(--text-secondary) transition-transform rtl:-scale-x-100"
                    [class.rotate-90]="open"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                  <span class="min-w-0 flex-1 text-(--text-primary)">{{
                    change(item.contest)
                  }}</span>
                  <span class="id-pill shrink-0" [attr.data-tone]="o.tone">{{ o.label }}</span>
                  <span class="shrink-0 text-(--text-secondary)">{{ day(item.at) }}</span>
                </button>
                <div [id]="item.id + '-body'" [hidden]="!open" class="px-4 pb-4 ps-11">
                  <p class="max-w-prose text-(--text-primary)">{{ o.explain }}</p>
                  <ol
                    class="id-rail ms-1.5 mt-3 list-none space-y-3 p-0 ps-5"
                    [attr.aria-label]="railLabel(item.contest)"
                  >
                    @for (event of events(item); track $index) {
                      <li class="relative">
                        <span
                          aria-hidden="true"
                          class="id-rail-dot absolute -start-[1.625rem] top-1.5 h-3 w-3 rounded-full"
                        ></span>
                        <p class="text-(--text-primary)">
                          {{ event.text }}
                          <span class="text-(--text-secondary)">{{ day(event.at) }}</span>
                        </p>
                        @if (event.note) {
                          <div
                            class="mt-1 max-w-prose rounded-(--radius-sm) bg-(--surface-sunken) px-3 py-2"
                          >
                            <p class="font-semibold text-(--text-secondary)">{{ event.noteBy }}</p>
                            <p class="mt-0.5 max-w-prose break-words text-(--text-primary)">
                              {{ event.note }}
                            </p>
                          </div>
                        }
                      </li>
                    }
                  </ol>
                  @if (item.side === 'submitted') {
                    <aec-vendor-contest-protest [contest]="item.contest" side="submitted" />
                  }
                </div>
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
})
export class IntegrationChangeRequests {
  protected readonly state = inject(IntegrationDetailState);
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);

  readonly integration = input.required<VendorIntegration>();

  protected readonly busy = signal<string | null>(null);
  protected readonly itemError = signal<{ id: string; message: string } | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** The answer form open inside an item, and the answer it saves. */
  protected readonly formFor = signal<string | null>(null);
  protected readonly formMode = signal<'yes' | 'no'>('no');
  private readonly notes = signal<ReadonlyMap<string, string>>(new Map());

  protected readonly chips: readonly { key: RequestFilter; label: string }[] = [
    { key: 'all', label: $localize`:@@vendor.im.requests.filter.all:All` },
    { key: 'open', label: $localize`:@@vendor.im.requests.filter.open:Open` },
    { key: 'closed', label: $localize`:@@vendor.im.requests.filter.closed:Closed` },
  ];
  protected readonly showLabel = $localize`:@@vendor.im.requests.show:Show`;
  protected readonly searchPlaceholder = $localize`:@@vendor.im.requests.placeholder:Search requests, values or notes`;
  protected readonly aboutLabel = $localize`:@@vendor.im.requests.about:About change requests`;
  protected readonly aboutTip = $localize`:@@vendor.im.requests.tip:Corrections asked for, disagreements about the data that is shared, and rows the other company added. Nothing on the public page changes until a request is accepted.`;

  protected readonly query = computed(() =>
    this.state.requestQuery().trim().toLocaleLowerCase('en'),
  );

  /** A company that does not own the row may ask on a live row (§11b.2). */
  protected readonly canRequest = computed(() => {
    const i = this.integration();
    return !i.is_owner && !i.retired_at;
  });

  private matches(text: string): boolean {
    const q = this.query();
    return q === '' || text.toLocaleLowerCase('en').includes(q);
  }

  private claimText(claim: VendorClaim, marker: string): string {
    return [
      marker,
      claim.data_object_name,
      claim.counterparty?.note,
      myNote(claim),
      this.state.company(),
      this.state.myCompany(),
    ]
      .filter((v): v is string => typeof v === 'string' && v !== '')
      .join(' ');
  }

  protected readonly openItems = computed<readonly OpenItem[]>(() => {
    const i = this.integration();
    const contests = this.state.contests();
    const disagreementWord = $localize`:@@vendor.im.requests.word.disagreement:Disagreement`;
    const addedWord = $localize`:@@vendor.im.requests.word.added:Added row`;
    const items: OpenItem[] = [
      ...contests.received
        .filter((c) => isContestOpen(c) && this.matches(contestSearchText(c)))
        .map((c) => ({
          kind: 'received' as const,
          id: contestItemId(c.id),
          at: c.updated_at,
          contest: c,
        })),
      ...i.claims
        .filter(
          (c) => isCounterpartAddedUnanswered(i, c) && this.matches(this.claimText(c, addedWord)),
        )
        .map((c) => ({
          kind: 'added-them' as const,
          id: addedItemId(c.id),
          at: c.created_at ?? '',
          claim: c,
        })),
      ...disagreements(i)
        .filter((c) => this.matches(this.claimText(c, disagreementWord)))
        .map((c) => ({
          kind: 'disagreement' as const,
          id: disagreementItemId(c.id),
          at: c.disagreement?.raised_at ?? '',
          claim: c,
        })),
      ...i.claims
        .filter((c) => isAddedByYouWaiting(i, c) && this.matches(this.claimText(c, addedWord)))
        .map((c) => ({
          kind: 'added-you' as const,
          id: addedItemId(c.id),
          at: c.created_at ?? '',
          claim: c,
        })),
      ...contests.submitted
        .filter((c) => isContestOpen(c) && this.matches(contestSearchText(c)))
        .map((c) => ({
          kind: 'submitted' as const,
          id: contestItemId(c.id),
          at: c.updated_at,
          contest: c,
        })),
    ];
    return items.sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || newestFirst(a, b),
    );
  });

  protected readonly closedItems = computed<readonly ClosedItem[]>(() => {
    const contests = this.state.contests();
    const closed: ClosedItem[] = [
      ...contests.received
        .filter((c) => !isContestOpen(c))
        .map((c) => ({
          id: contestItemId(c.id),
          at: c.decided_at ?? c.updated_at,
          contest: c,
          side: 'received' as const,
        })),
      ...contests.submitted
        .filter((c) => !isContestOpen(c))
        .map((c) => ({
          id: contestItemId(c.id),
          at: c.decided_at ?? c.updated_at,
          contest: c,
          side: 'submitted' as const,
        })),
    ];
    return closed.filter((item) => this.matches(contestSearchText(item.contest))).sort(newestFirst);
  });

  protected readonly openHeading = computed(() => {
    const n = this.openItems().length;
    return $localize`:@@vendor.im.requests.openHeading:Open (${n}:count:)`;
  });

  protected readonly closedHeading = computed(() => {
    const n = this.closedItems().length;
    return $localize`:@@vendor.im.requests.closedHeading:Closed (${n}:count:)`;
  });

  // ── Copy ───────────────────────────────────────────────────────────────────

  protected change(contest: VendorContest): string {
    return contestChange(contest);
  }
  protected fieldName(contest: VendorContest): string {
    return pageFieldLabel(contest.field);
  }
  protected received(contest: VendorContest): Outcome {
    return receivedOutcome(contest);
  }
  protected submitted(contest: VendorContest): Outcome {
    return submittedOutcome(contest);
  }
  protected closedOutcome(item: ClosedItem): Outcome {
    return item.side === 'received'
      ? receivedOutcome(item.contest)
      : submittedOutcome(item.contest);
  }
  protected events(item: ClosedItem): RailEvent[] {
    return contestEvents(item.contest, item.side);
  }
  protected day(iso: string | null): string {
    return formatDay(iso);
  }
  protected receivedMeta(contest: VendorContest): string {
    const who = contest.submitter_vendor.name;
    const date = formatDay(contest.created_at);
    return $localize`:@@vendor.im.requests.receivedMeta:Change request from ${who}:company: · sent ${date}:date:`;
  }
  protected submittedMeta(contest: VendorContest): string {
    const date = formatDay(contest.created_at);
    return $localize`:@@vendor.im.requests.submittedMeta:Correction · sent ${date}:date:`;
  }
  protected reasonOf(name: string): string {
    const who = possessive(name);
    return $localize`:@@vendor.im.requests.reasonOf:${who}:who: reason`;
  }
  protected noteTo(name: string): string {
    return $localize`:@@vendor.im.requests.noteTo:Note to ${name}:company:`;
  }
  protected declineHelp(name: string): string {
    return $localize`:@@vendor.im.requests.declineHelp:If you decline, say why, so ${name}:company: knows what would change your mind.`;
  }
  protected withdrawLabel(contest: VendorContest): string {
    const field = pageFieldLabel(contest.field);
    return $localize`:@@vendor.im.requests.withdrawLabel:Withdraw request: ${field}:field:`;
  }
  protected railLabel(contest: VendorContest): string {
    const field = pageFieldLabel(contest.field);
    return $localize`:@@vendor.im.requests.railLabel:What happened: ${field}:field:`;
  }

  private companyName(): string {
    return companyOrFallback(this.state.company());
  }
  protected addedThemMeta(claim: VendorClaim): string {
    const who = this.companyName();
    const date = formatDay(claim.created_at);
    return date
      ? $localize`:@@vendor.im.requests.addedThemMeta:Added row · ${who}:company: · ${date}:date:`
      : $localize`:@@vendor.im.requests.addedThemMetaNoDate:Added row · ${who}:company:`;
  }
  protected addedThemTitle(claim: VendorClaim): string {
    const who = this.companyName();
    const data = claim.data_object_name;
    return $localize`:@@vendor.im.needs.added:${who}:company: added ${data}:data:. Is this right?`;
  }
  protected addedThemBody(claim: VendorClaim): string {
    const who = this.companyName();
    const sentence = dataSentence(
      claim.data_object_name,
      claim.direction,
      this.integration().other_product.name,
    );
    return $localize`:@@vendor.im.requests.addedThemBody:They say ${sentence}:sentence:. Until you answer, the public page shows it as "Confirmed by ${who}:company:".`;
  }
  protected noteOfThem(): string {
    const who = possessive(this.companyName());
    return $localize`:@@vendor.im.requests.noteOf:${who}:who: note`;
  }
  protected addedYouMeta(claim: VendorClaim): string {
    const date = formatDay(claim.created_at);
    return date
      ? $localize`:@@vendor.im.requests.addedYouMeta:Added row · you · ${date}:date:`
      : $localize`:@@vendor.im.requests.addedYouMetaNoDate:Added row · you`;
  }
  protected addedYouTitle(claim: VendorClaim): string {
    const who = this.companyName();
    const data = claim.data_object_name;
    return $localize`:@@vendor.im.requests.addedYouTitle:You added ${data}:data:. Waiting for ${who}:company:.`;
  }
  protected yourNoteFor(): string {
    const who = this.companyName();
    return $localize`:@@vendor.im.requests.yourNoteFor:Your note for ${who}:company:`;
  }
  protected myNoteOf(claim: VendorClaim): string | null {
    return myNote(claim);
  }
  protected hasMyNote(claim: VendorClaim): boolean {
    return myNote(claim) !== null;
  }
  protected raisedLine(claim: VendorClaim): string {
    const date = formatDay(claim.disagreement?.raised_at ?? null);
    return date
      ? $localize`:@@vendor.im.requests.raised:Disagreement · raised ${date}:date:`
      : $localize`:@@vendor.im.requests.raisedNoDate:Disagreement`;
  }
  private yesNo(answer: 'yes' | 'no' | null): string {
    return answer === 'yes'
      ? $localize`:@@vendor.im.answer.yes:Yes`
      : answer === 'no'
        ? $localize`:@@vendor.im.answer.no:No`
        : $localize`:@@vendor.im.requests.noAnswer:No answer`;
  }
  protected disagreementTitle(claim: VendorClaim): string {
    const data = claim.data_object_name;
    const mine = this.yesNo(myAnswer(claim));
    const who = this.companyName();
    const theirs = this.yesNo(theirAnswer(claim));
    return $localize`:@@vendor.im.requests.disagreementTitle:${data}:data:: you say ${mine}:mine:, ${who}:company: says ${theirs}:theirs:`;
  }
  protected yourAnswerLine(claim: VendorClaim): string {
    const answer = this.yesNo(myAnswer(claim));
    return $localize`:@@vendor.im.requests.yourAnswer:Your answer: ${answer}:answer:`;
  }
  protected theirAnswerLine(claim: VendorClaim): string {
    const who = possessive(this.companyName());
    const answer = this.yesNo(theirAnswer(claim));
    return $localize`:@@vendor.im.requests.theirAnswer:${who}:who: answer: ${answer}:answer:`;
  }
  protected yourReason(claim: VendorClaim): string {
    return (
      myNote(claim) ?? $localize`:@@vendor.im.requests.noReasonYou:You have not given a reason.`
    );
  }
  protected theirReason(claim: VendorClaim): string {
    const note = claim.counterparty?.note;
    return note && note.trim() !== ''
      ? note
      : $localize`:@@vendor.im.requests.noReasonThem:They have not given a reason.`;
  }
  /** §6.2's `conflict` sentence, verbatim. No dated review promise (§6.17.6). */
  protected outcomeLine(claim: VendorClaim): string {
    return claimOutcomeLine(claim, this.integration().other_product.name);
  }
  protected flipTo(claim: VendorClaim): 'yes' | 'no' {
    return myAnswer(claim) === 'yes' ? 'no' : 'yes';
  }
  protected currentMode(claim: VendorClaim): 'yes' | 'no' {
    return myAnswer(claim) === 'no' ? 'no' : 'yes';
  }
  protected changeAnswerLabel(claim: VendorClaim): string {
    return this.flipTo(claim) === 'yes'
      ? $localize`:@@vendor.im.requests.changeToYes:Change my answer to Yes`
      : $localize`:@@vendor.im.requests.changeToNo:Change my answer to No`;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected readonly label = LABEL;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;
  protected readonly rowAction = ROW_ACTION;

  // ── Actions ────────────────────────────────────────────────────────────────

  protected toggle(id: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected openAnswer(itemId: string, mode: 'yes' | 'no'): void {
    this.itemError.set(null);
    this.formMode.set(mode);
    this.formFor.set(itemId);
  }

  protected closeAnswer(itemId: string): void {
    this.formFor.set(null);
    this.focus(itemId);
  }

  protected async yes(itemId: string, claim: VendorClaim): Promise<void> {
    if (this.busy()) return;
    this.busy.set(itemId);
    this.itemError.set(null);
    const error = await this.state.answerYes(claim);
    this.busy.set(null);
    if (error) this.itemError.set({ id: itemId, message: error });
  }

  protected noteFor(id: string): string {
    return this.notes().get(id) ?? '';
  }

  protected setNote(id: string, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.notes.update((current) => new Map(current).set(id, value));
  }

  /** Accept or decline, as the Messages tab does (§11b.5). */
  protected async decide(contest: VendorContest, decision: ContestDecision): Promise<void> {
    if (this.busy()) return;
    const itemId = contestItemId(contest.id);
    this.busy.set(itemId);
    this.itemError.set(null);
    const note = this.noteFor(contest.id).trim();
    try {
      await this.api.decideContest(contest.id, { decision, note: note === '' ? null : note });
      const field = pageFieldLabel(contest.field);
      this.announcer.announce(
        decision === 'accept'
          ? $localize`:@@vendor.im.requests.live.accepted:You accepted the change to ${field}:field:. The public page shows it now.`
          : $localize`:@@vendor.im.requests.live.declined:You declined the change to ${field}:field:. The company that asked sees your decision.`,
      );
      this.notes.update((current) => {
        const next = new Map(current);
        next.delete(contest.id);
        return next;
      });
      await this.state.refreshContests();
      void this.store.revalidate(
        decision === 'accept' ? ['contests', 'integrations'] : ['contests'],
      );
      this.focus(itemId);
    } catch (err) {
      await this.fail(itemId, err);
    } finally {
      this.busy.set(null);
    }
  }

  protected startWithdraw(contest: VendorContest): void {
    this.itemError.set(null);
    this.confirming.set(contest.id);
    this.focusId(`withdraw-yes-${contest.id}`);
  }

  protected cancelWithdraw(contest: VendorContest): void {
    this.confirming.set(null);
    this.focusId(`withdraw-${contest.id}`);
  }

  protected async withdraw(itemId: string, contest: VendorContest): Promise<void> {
    if (this.busy()) return;
    this.busy.set(itemId);
    this.itemError.set(null);
    try {
      await this.api.withdrawContest(contest.id);
      this.confirming.set(null);
      const field = pageFieldLabel(contest.field);
      this.announcer.announce(
        $localize`:@@vendor.im.requests.live.withdrawn:You withdrew your request to change ${field}:field:.`,
      );
      await this.state.refreshContests();
      void this.store.revalidate(['contests']);
      this.focusId('change-requests-heading');
    } catch (err) {
      this.confirming.set(null);
      await this.fail(itemId, err);
    } finally {
      this.busy.set(null);
    }
  }

  /** A lost race is not a failure to retry: say so, then reload. */
  private async fail(itemId: string, err: unknown): Promise<void> {
    const info = readVendorApiError(err);
    let message: string;
    if (info?.code === 'CONTEST_NOT_OPEN') {
      message = $localize`:@@vendor.im.requests.error.notOpen:This request was already decided or withdrawn. The list now shows where it stands.`;
      await this.state.refreshContests();
    } else if (info?.code === 'INTEGRATION_ENTITLEMENT_REQUIRED') {
      message = $localize`:@@vendor.im.requests.error.entitlement:Deciding a request on an integration that runs through a connector service needs an active plan. Contact AEC Integrations to activate or renew it.`;
    } else if (info?.code === 'CONTEST_INTEGRATION_CHANGED') {
      message = $localize`:@@vendor.im.requests.error.rerouted:AEC Integrations now decides this request. The list now shows where it stands.`;
      await this.state.refreshContests();
    } else if (info?.code === 'RATE_LIMITED') {
      message = $localize`:@@vendor.im.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    } else {
      message = $localize`:@@vendor.im.requests.error.generic:Could not save that. Try again.`;
    }
    this.itemError.set({ id: itemId, message });
  }

  protected onSent(contest: VendorContest): void {
    this.state.closeRequestForm();
    this.state.requestFilter.set('all');
    this.state.requestQuery.set('');
    this.focus(contestItemId(contest.id));
  }

  protected closeForm(): void {
    this.state.closeRequestForm();
    this.focusId('change-requests-heading');
  }

  protected retry(): void {
    void this.state.refreshContests();
  }

  private focus(itemId: string): void {
    afterNextRender(
      () => {
        const el = this.document.getElementById(itemId);
        if (!el) return;
        el.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
        el.focus({ preventScroll: true });
      },
      { injector: this.injector },
    );
  }

  private focusId(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }
}
