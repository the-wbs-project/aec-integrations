import { DatePipe, DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import type { ContestDecision, ContestStatus, VendorContest } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { cardClass } from '../../shared/card/card';
import { Chip, type ChipTone } from '../../shared/chip/chip';
import {
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { readVendorApiError } from '../vendor-api-error';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  contestFieldLabel,
  contestRouteLabel,
  contestStatusLabel,
  contestValueDisplay,
} from './vendor-contest-labels';
import { VendorContestProtest } from './vendor-contest-protest';
import { VendorDocsLink } from './vendor-docs-link';

type Busy = { readonly id: string; readonly action: ContestDecision | 'withdraw' };

/**
 * The Messages section's field contests block (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b and §6.5).
 *
 * Two lists off one read, `GET /api/vendor/contests`:
 *
 *  - **Received** is the owner inbox: contests other vendors sent about an
 *    integration this vendor owns, with Accept and Decline. It stays empty until
 *    the vendor owns a claimed integration, because only those route to a vendor;
 *    everything else goes to AEC Integrations (§11b.4).
 *  - **Submitted** is what this vendor sent, with where it stands and a Withdraw
 *    on the open ones.
 *
 * Unlike the notification archive below it, these rows ARE current state: each
 * carries a status the vendor acts on, so they render open, not in a disclosure.
 *
 * Every write is pessimistic and re-read (the `vendor-seat-roster.ts` pattern):
 * a decision can write the public catalog, and a row that changed state
 * optimistically and then snapped back would leave the owner unsure what was
 * published. A lost race answers `409 CONTEST_NOT_OPEN`, which is told plainly
 * and followed by a reload so the row shows the state that won.
 *
 * Withdraw confirms inline rather than with `confirm()`, which blocks the whole
 * page, and a withdrawn contest cannot be reopened.
 *
 * Each row also carries its protest to AECi (AECI-1009, §11b.12), rendered by
 * `VendorContestProtest`: the request form on the submitted side, the one-time
 * reply on the received side, and the whole record on both.
 */
@Component({
  selector: 'aec-vendor-contests-list',
  imports: [AecButton, Chip, DatePipe, NgTemplateOutlet, VendorContestProtest, VendorDocsLink],
  styles: [':host { display: block; }'],
  template: `
    <!-- AECI-1812: the shared white card. Received and Submitted are overline
         groups, their rows divided by hairlines. AECI-2045: on an owned row's page the
         list sits inside that page's card, under its heading, so it draws no card. -->
    <section
      [class]="labelledBy() ? '' : cardSectionClass"
      [attr.aria-labelledby]="labelledBy() ?? 'vendor-contests-heading'"
    >
      @if (!labelledBy()) {
        <h3 id="vendor-contests-heading" i18n="@@vendor.contests.heading">Change requests</h3>
        <p
          class="mt-2 max-w-[30rem] text-sm leading-relaxed text-(--text-secondary)"
          i18n="@@vendor.contests.intro"
        >
          A change request says one detail of an integration is wrong and proposes the right value.
          You can request a change from any integration under your products.
        </p>
      }
      <p class="mt-2"><aec-vendor-docs-link page="requesting-changes-and-appeals" /></p>

      <div class="mt-6" [attr.aria-busy]="loading() ? 'true' : null">
        @if (loading()) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.contests.loading">
            Loading change requests…
          </p>
        } @else if (failed()) {
          <div class="flex flex-wrap items-center gap-4">
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.contests.failed">
              Could not load your change requests.
            </p>
            <button
              aecButton
              variant="secondary"
              compact
              type="button"
              (click)="retry()"
              i18n="@@vendor.contests.retry"
            >
              Try again
            </button>
          </div>
        } @else {
          <div class="space-y-8">
            <div>
              <h4
                class="aec-overline text-(--text-secondary)"
                i18n="@@vendor.contests.received.heading"
              >
                Received
              </h4>
              @if (received().length === 0 && integrationId()) {
                <p
                  class="mt-2 max-w-[30rem] text-sm text-(--text-secondary)"
                  i18n="@@vendor.contests.received.emptyOne"
                >
                  No change requests have come in about this integration. When another company sends
                  one, it arrives here for you to accept or decline.
                </p>
              } @else if (received().length === 0) {
                <p
                  class="mt-2 max-w-[30rem] text-sm text-(--text-secondary)"
                  i18n="@@vendor.contests.received.emptyOwner"
                >
                  Nothing to decide. Once you claim an integration your company owns, change
                  requests other vendors send about it arrive here for you to accept or decline.
                  Until then AEC Integrations reviews them. A change request about who owns an
                  integration always goes to AEC Integrations.
                </p>
              } @else {
                <ul
                  class="mt-2 divide-y divide-(--border-default) border-t border-(--border-default)"
                >
                  @for (contest of received(); track contest.id) {
                    <li class="space-y-2 py-4 last:pb-0" [attr.data-contest]="contest.id">
                      <ng-container
                        [ngTemplateOutlet]="summary"
                        [ngTemplateOutletContext]="{ $implicit: contest }"
                      />
                      <p class="text-t-13 text-(--text-secondary)">
                        {{ fromLine(contest) }}
                        <span aria-hidden="true"> · </span>
                        {{ contest.created_at | date: 'mediumDate' }}
                      </p>
                      @if (contest.status === 'open') {
                        <div class="max-w-prose space-y-2 pt-2">
                          <label [for]="noteId(contest)" [class]="labelClass">{{
                            noteLabel(contest)
                          }}</label>
                          <textarea
                            [id]="noteId(contest)"
                            rows="2"
                            maxlength="2000"
                            [value]="noteFor(contest.id)"
                            (input)="setNote(contest.id, $event)"
                            [attr.aria-describedby]="noteId(contest) + '-hint'"
                            [class]="inputClass"
                          ></textarea>
                          <p
                            [id]="noteId(contest) + '-hint'"
                            [class]="hintClass"
                            i18n="@@vendor.contests.note.hint"
                          >
                            Optional. If you decline, say why, so the vendor knows what would change
                            your mind.
                          </p>
                          <div class="flex flex-wrap items-center gap-2 pt-2">
                            <button
                              aecButton
                              compact
                              type="button"
                              [disabled]="busy() !== null"
                              (click)="decide(contest, 'accept')"
                            >
                              @if (isBusy(contest, 'accept')) {
                                <span i18n="@@vendor.contests.accepting">Accepting…</span>
                              } @else {
                                <span i18n="@@vendor.contests.accept">Accept</span>
                              }
                              <span class="sr-only">&ngsp;{{ rowName(contest) }}</span>
                            </button>
                            <button
                              aecButton
                              variant="secondary"
                              compact
                              type="button"
                              [disabled]="busy() !== null"
                              (click)="decide(contest, 'decline')"
                            >
                              @if (isBusy(contest, 'decline')) {
                                <span i18n="@@vendor.contests.declining">Declining…</span>
                              } @else {
                                <span i18n="@@vendor.contests.decline">Decline</span>
                              }
                              <span class="sr-only">&ngsp;{{ rowName(contest) }}</span>
                            </button>
                          </div>
                          <p [class]="hintClass" i18n="@@vendor.contests.acceptHint">
                            Accepting changes the public integration page right away.
                          </p>
                        </div>
                      }
                      <aec-vendor-contest-protest [contest]="contest" side="received" />
                      @if (rowError()?.id === contest.id) {
                        <p role="alert" class="text-sm font-semibold text-(--text-primary)">
                          {{ rowError()?.message }}
                        </p>
                      }
                    </li>
                  }
                </ul>
              }
            </div>

            <div>
              <h4
                class="aec-overline text-(--text-secondary)"
                i18n="@@vendor.contests.submitted.heading"
              >
                Submitted
              </h4>
              @if (submitted().length === 0 && integrationId()) {
                <p
                  class="mt-2 max-w-[30rem] text-sm text-(--text-secondary)"
                  i18n="@@vendor.contests.submitted.emptyOne"
                >
                  Your company has not sent a change request about this integration.
                </p>
              } @else if (submitted().length === 0) {
                <p
                  class="mt-2 max-w-[30rem] text-sm text-(--text-secondary)"
                  i18n="@@vendor.contests.submitted.empty"
                >
                  You have not sent any change requests. Open an integration under one of your
                  products and choose Request a change beside a detail. For an integration delivered
                  through a connector, choose Request a change in your product's Connectors section.
                </p>
              } @else {
                <ul
                  class="mt-2 divide-y divide-(--border-default) border-t border-(--border-default)"
                >
                  @for (contest of submitted(); track contest.id) {
                    <li class="space-y-2 py-4 last:pb-0" [attr.data-contest]="contest.id">
                      <ng-container
                        [ngTemplateOutlet]="summary"
                        [ngTemplateOutletContext]="{ $implicit: contest }"
                      />
                      <p class="text-t-13 text-(--text-secondary)">
                        @if (contest.status === 'open') {
                          {{ routeLabel(contest) }}
                          <span aria-hidden="true"> · </span>
                        }
                        <ng-container i18n="@@vendor.contests.sent">Sent</ng-container>
                        {{ contest.created_at | date: 'mediumDate' }}
                        @if (contest.decided_at; as decided) {
                          <span aria-hidden="true"> · </span>
                          @if (isSilenceClose(contest)) {
                            <ng-container i18n="@@vendor.contests.noAnswerBy"
                              >No answer by</ng-container
                            >
                          } @else {
                            <ng-container i18n="@@vendor.contests.decided">Decided</ng-container>
                          }
                          {{ decided | date: 'mediumDate' }}
                        }
                      </p>
                      @if (contest.status === 'open') {
                        @if (confirming() === contest.id) {
                          <!-- "It cannot be reopened": the confirm is the danger button
                               (DESIGN.md §5 Buttons, ruled 2026-11-24). -->
                          <div class="flex flex-wrap items-center gap-2">
                            <p
                              class="basis-full text-sm text-(--text-primary)"
                              i18n="@@vendor.contests.withdraw.confirm"
                            >
                              Withdraw this change request? It cannot be reopened.
                            </p>
                            <button
                              aecButton
                              variant="danger"
                              compact
                              type="button"
                              [id]="'vendor-contest-withdraw-' + contest.id"
                              [disabled]="busy() !== null"
                              (click)="withdraw(contest)"
                            >
                              @if (isBusy(contest, 'withdraw')) {
                                <span i18n="@@vendor.contests.withdrawing">Withdrawing…</span>
                              } @else {
                                <span i18n="@@vendor.contests.withdraw.yes">Withdraw</span>
                              }
                              <span class="sr-only">&ngsp;{{ rowName(contest) }}</span>
                            </button>
                            <button
                              aecButton
                              variant="secondary"
                              compact
                              type="button"
                              [disabled]="busy() !== null"
                              (click)="cancelWithdraw(contest)"
                              i18n="@@vendor.contests.withdraw.keep"
                            >
                              Keep it
                            </button>
                          </div>
                        } @else {
                          <button
                            aecButton
                            variant="secondary"
                            compact
                            type="button"
                            [id]="'vendor-contest-withdraw-start-' + contest.id"
                            [disabled]="busy() !== null"
                            (click)="startWithdraw(contest)"
                          >
                            <span i18n="@@vendor.contests.withdraw">Withdraw</span>
                            <span class="sr-only">&ngsp;{{ rowName(contest) }}</span>
                          </button>
                        }
                      }
                      <aec-vendor-contest-protest [contest]="contest" side="submitted" />
                      @if (rowError()?.id === contest.id) {
                        <p role="alert" class="text-sm font-semibold text-(--text-primary)">
                          {{ rowError()?.message }}
                        </p>
                      }
                    </li>
                  }
                </ul>
              }
            </div>
          </div>
        }
      </div>
    </section>

    <ng-template #summary let-contest>
      <div class="flex flex-wrap items-start justify-between gap-2">
        <p class="min-w-0 text-sm font-semibold break-words text-(--text-primary)">
          {{ rowName(contest) }}
        </p>
        <aec-chip class="shrink-0" density="dense" [tone]="chipTone(contest.status)">{{
          statusLabelFor(contest)
        }}</aec-chip>
      </div>
      <!-- minmax(0, 1fr), not 1fr: a long URL in a value must wrap inside the column,
           not widen it past a 320px screen (AECI-1812). -->
      <dl class="grid max-w-prose grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt class="text-(--text-secondary)" i18n="@@vendor.contests.current">On record</dt>
        <dd class="break-words text-(--text-primary)">{{ currentLine(contest) }}</dd>
        <dt class="text-(--text-secondary)" i18n="@@vendor.contests.proposed">Proposed</dt>
        <dd class="break-words text-(--text-primary)">{{ proposedLine(contest) }}</dd>
        <dt class="text-(--text-secondary)" i18n="@@vendor.contests.reason">Reason</dt>
        <dd class="break-words text-(--text-primary)">{{ contest.reason }}</dd>
        @if (contest.decision_note; as note) {
          <dt class="text-(--text-secondary)" i18n="@@vendor.contests.decisionNote">Note</dt>
          <dd class="break-words text-(--text-primary)">{{ note }}</dd>
        }
      </dl>
    </ng-template>
  `,
})
export class VendorContestsList {
  private readonly store = inject(VendorPortalStore);
  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  /** The shared white card (`aecCard`), drawn only when the list stands alone. */
  protected readonly cardSectionClass = `${cardClass()} p-6`;
  protected readonly loading = this.store.contestsLoading;
  protected readonly failed = this.store.contestsFailed;
  /** AECI-2045: narrow both lists to one row's id (the owned row's detail page). */
  readonly integrationId = input<string | null>(null);
  /** AECI-2045: a heading outside the list names it. The list then drops its own
   *  heading and intro, so the page keeps one heading per section. */
  readonly labelledBy = input<string | null>(null);

  private scoped(list: readonly VendorContest[]): VendorContest[] {
    const id = this.integrationId();
    return id ? list.filter((c) => c.integration_id === id) : [...list];
  }

  protected readonly received = computed(() => this.scoped(this.store.contests().received));
  protected readonly submitted = computed(() => this.scoped(this.store.contests().submitted));

  protected readonly busy = signal<Busy | null>(null);
  protected readonly rowError = signal<{ id: string; message: string } | null>(null);
  protected readonly confirming = signal<string | null>(null);
  private readonly notes = signal<ReadonlyMap<string, string>>(new Map());

  constructor() {
    afterNextRender(() => void this.store.ensure('contests'));
  }

  protected retry(): void {
    void this.store.reload('contests').then(() => {
      this.announcer.announce(
        this.failed()
          ? $localize`:@@vendor.contests.live.failed:Your change requests could not be loaded.`
          : $localize`:@@vendor.contests.live.reloaded:Change requests updated.`,
      );
    });
  }

  /** Accept or decline an owner-routed contest. An accept writes the public
   *  catalog, so the integrations list is revalidated too. */
  protected async decide(contest: VendorContest, decision: ContestDecision): Promise<void> {
    if (this.busy()) return;
    this.busy.set({ id: contest.id, action: decision });
    this.rowError.set(null);
    const note = this.noteFor(contest.id).trim();
    try {
      await this.api.decideContest(contest.id, { decision, note: note === '' ? null : note });
      const name = this.rowName(contest);
      this.announcer.announce(
        decision === 'accept'
          ? $localize`:@@vendor.contests.live.accepted:Accepted: ${name}:CONTEST:. The public integration page now shows the proposed value.`
          : $localize`:@@vendor.contests.live.declined:Declined: ${name}:CONTEST:. The vendor that sent it will see your decision.`,
      );
      this.notes.update((current) => {
        const next = new Map(current);
        next.delete(contest.id);
        return next;
      });
      await this.store.revalidate(
        decision === 'accept' ? ['contests', 'integrations'] : ['contests'],
      );
    } catch (err) {
      await this.failWrite(
        contest,
        err,
        $localize`:@@vendor.contests.decide.error:Could not save your decision. Try again.`,
      );
    } finally {
      this.busy.set(null);
    }
  }

  protected startWithdraw(contest: VendorContest): void {
    this.rowError.set(null);
    this.confirming.set(contest.id);
    this.focusAfterRender(`vendor-contest-withdraw-${contest.id}`);
  }

  protected cancelWithdraw(contest: VendorContest): void {
    this.confirming.set(null);
    this.focusAfterRender(`vendor-contest-withdraw-start-${contest.id}`);
  }

  protected async withdraw(contest: VendorContest): Promise<void> {
    if (this.busy()) return;
    this.busy.set({ id: contest.id, action: 'withdraw' });
    this.rowError.set(null);
    try {
      await this.api.withdrawContest(contest.id);
      this.confirming.set(null);
      const name = this.rowName(contest);
      this.announcer.announce(
        $localize`:@@vendor.contests.live.withdrawn:Withdrawn: ${name}:CONTEST:.`,
      );
      await this.store.revalidate(['contests']);
    } catch (err) {
      this.confirming.set(null);
      await this.failWrite(
        contest,
        err,
        $localize`:@@vendor.contests.withdraw.error:Could not withdraw that change request. Try again.`,
      );
    } finally {
      this.busy.set(null);
    }
  }

  /** A lost race is not a failure to retry: someone else already closed the
   *  contest. Say so, then reload so the row shows the state that won. */
  private async failWrite(contest: VendorContest, err: unknown, generic: string): Promise<void> {
    const info = readVendorApiError(err);
    if (info?.code === 'CONTEST_NOT_OPEN') {
      this.rowError.set({
        id: contest.id,
        message: $localize`:@@vendor.contests.error.notOpen:This change request was already decided or withdrawn. The list now shows where it stands.`,
      });
      await this.store.reload('contests');
      return;
    }
    // AECI-1237 (§11d.5): accepting would undo AECi's locked correction.
    if (info?.code === 'FIELD_LOCKED_BY_AECI') {
      this.rowError.set({
        id: contest.id,
        message: $localize`:@@vendor.contests.error.locked:AEC Integrations corrected this field and locked it, so this change request cannot be accepted. You can still decline it.`,
      });
      return;
    }
    // The owner changed, or AEC Integrations now decides it (an entitlement cleared).
    if (info?.code === 'CONTEST_INTEGRATION_CHANGED') {
      this.rowError.set({
        id: contest.id,
        message: $localize`:@@vendor.contests.error.rerouted:AEC Integrations now decides this change request. The list now shows where it stands.`,
      });
      await this.store.reload('contests');
      return;
    }
    this.rowError.set({ id: contest.id, message: generic });
  }

  private focusAfterRender(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), {
      injector: this.injector,
    });
  }

  protected isBusy(contest: VendorContest, action: Busy['action']): boolean {
    const busy = this.busy();
    return busy?.id === contest.id && busy.action === action;
  }

  protected noteFor(id: string): string {
    return this.notes().get(id) ?? '';
  }

  protected setNote(id: string, event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    this.notes.update((current) => new Map(current).set(id, value));
  }

  protected noteId(contest: VendorContest): string {
    return `vendor-contest-note-${contest.id}`;
  }

  protected noteLabel(contest: VendorContest): string {
    const who = contest.submitter_vendor.name;
    return $localize`:@@vendor.contests.note.label:Note to ${who}:VENDOR:`;
  }

  /** "Direction on Summit ↔ Procore": the field, then the integration. */
  protected rowName(contest: VendorContest): string {
    const field = contestFieldLabel(contest.field);
    const integration =
      contest.integration_name ??
      $localize`:@@vendor.contests.integration.fallback:${contest.context_product.name}:A: and ${contest.other_product.name}:B:`;
    return $localize`:@@vendor.contests.rowName:${field}:FIELD: on ${integration}:INTEGRATION:`;
  }

  protected currentLine(contest: VendorContest): string {
    return contestValueDisplay(
      contest.field,
      contest.current_value,
      contest.current_label,
      contest.other_product.name,
    );
  }

  protected proposedLine(contest: VendorContest): string {
    return contestValueDisplay(
      contest.field,
      contest.proposed_value,
      contest.proposed_label,
      contest.other_product.name,
    );
  }

  protected fromLine(contest: VendorContest): string {
    const who = contest.submitter_vendor.name;
    return $localize`:@@vendor.contests.from:From ${who}:VENDOR:`;
  }

  protected routeLabel(contest: VendorContest): string {
    return contestRouteLabel(contest.routed_to);
  }

  /** Closed by 30 days of silence (§11b.12.3): `decided_at` is the day the owner's
   *  time ran out, not a decision, so the date reads "No answer by" (AECI-1319). */
  protected isSilenceClose(contest: VendorContest): boolean {
    return contest.status === 'declined' && contest.protest?.basis === 'silence';
  }

  /** The contest's own state. A decline by 30 days of silence (AECI-1009) is not
   *  the owner's act, so it reads as what happened rather than "Declined". */
  protected statusLabelFor(contest: VendorContest): string {
    if (this.isSilenceClose(contest)) {
      return $localize`:@@vendor.contests.status.noAnswer:No answer in 30 days`;
    }
    return contestStatusLabel(contest.status);
  }

  /** The old pill colours on the shared chip: Forest while open or accepted, the
   *  strong edge otherwise. The words carry the state. */
  protected chipTone(status: ContestStatus): ChipTone {
    return status === 'open' || status === 'accepted' ? 'forest' : 'strong';
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = `${FIELD_INPUT_CLASS} block leading-[1.6]`;
  protected readonly hintClass = FIELD_HINT_CLASS;
}
