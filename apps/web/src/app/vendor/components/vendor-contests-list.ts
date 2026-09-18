import { DatePipe, DOCUMENT, NgTemplateOutlet } from '@angular/common';
import { Component, Injector, afterNextRender, computed, inject, signal } from '@angular/core';

import type { ContestDecision, ContestStatus, VendorContest } from '@aeci/shared';

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

type Busy = { readonly id: string; readonly action: ContestDecision | 'withdraw' };

/**
 * The Messages section's field contests block (AECI-1008 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b and §6.5).
 *
 * Two lists off one read, `GET /api/vendor/contests`:
 *
 *  - **Received** is the owner inbox: contests other vendors sent about an
 *    integration this vendor built, with Accept and Decline. It stays empty until
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
 */
@Component({
  selector: 'aec-vendor-contests-list',
  imports: [DatePipe, NgTemplateOutlet],
  styles: [':host { display: block; }'],
  template: `
    <section aria-labelledby="vendor-contests-heading">
      <h3
        id="vendor-contests-heading"
        class="font-display text-lg font-semibold text-(--text-primary)"
        i18n="@@vendor.contests.heading"
      >
        Field contests
      </h3>
      <p
        class="mt-2 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@vendor.contests.intro"
      >
        A contest says one detail of an integration is wrong and proposes the right value. You can
        contest a field from any integration under your products.
      </p>

      <div class="mt-4" [attr.aria-busy]="loading() ? 'true' : null">
        @if (loading()) {
          <p class="text-sm text-(--text-secondary)" i18n="@@vendor.contests.loading">
            Loading contests…
          </p>
        } @else if (failed()) {
          <div class="flex flex-wrap items-center gap-3">
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.contests.failed">
              Could not load your contests.
            </p>
            <button
              type="button"
              [class]="retryClass"
              (click)="retry()"
              i18n="@@vendor.contests.retry"
            >
              Try again
            </button>
          </div>
        } @else {
          <div class="space-y-6">
            <div>
              <h4
                class="font-label text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.contests.received.heading"
              >
                Received
              </h4>
              @if (received().length === 0) {
                <p
                  class="mt-2 max-w-prose text-sm text-(--text-secondary)"
                  i18n="@@vendor.contests.received.empty"
                >
                  Nothing to decide. Once you claim an integration your company built, contests
                  other vendors send about it arrive here for you to accept or decline. Until then
                  AEC Integrations reviews them.
                </p>
              } @else {
                <ul
                  class="mt-2 divide-y divide-(--border-default) border-y border-(--border-default)"
                >
                  @for (contest of received(); track contest.id) {
                    <li class="space-y-2 py-4" [attr.data-contest]="contest.id">
                      <ng-container
                        [ngTemplateOutlet]="summary"
                        [ngTemplateOutletContext]="{ $implicit: contest }"
                      />
                      <p class="text-xs text-(--text-secondary)">
                        {{ fromLine(contest) }}
                        <span aria-hidden="true"> · </span>
                        {{ contest.created_at | date: 'mediumDate' }}
                      </p>
                      @if (contest.status === 'open') {
                        <div class="max-w-prose space-y-2 pt-1">
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
                            class="text-xs text-(--text-secondary)"
                            i18n="@@vendor.contests.note.hint"
                          >
                            Optional. If you decline, say why, so the vendor knows what would change
                            your mind.
                          </p>
                          <div class="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              [class]="primaryClass"
                              [disabled]="busy() !== null"
                              (click)="decide(contest, 'accept')"
                            >
                              @if (isBusy(contest, 'accept')) {
                                <span i18n="@@vendor.contests.accepting">Accepting…</span>
                              } @else {
                                <span i18n="@@vendor.contests.accept">Accept</span>
                              }
                              <span class="sr-only">{{ rowName(contest) }}</span>
                            </button>
                            <button
                              type="button"
                              [class]="secondaryClass"
                              [disabled]="busy() !== null"
                              (click)="decide(contest, 'decline')"
                            >
                              @if (isBusy(contest, 'decline')) {
                                <span i18n="@@vendor.contests.declining">Declining…</span>
                              } @else {
                                <span i18n="@@vendor.contests.decline">Decline</span>
                              }
                              <span class="sr-only">{{ rowName(contest) }}</span>
                            </button>
                          </div>
                          <p
                            class="text-xs text-(--text-secondary)"
                            i18n="@@vendor.contests.acceptHint"
                          >
                            Accepting changes the public integration page right away.
                          </p>
                        </div>
                      }
                      @if (rowError()?.id === contest.id) {
                        <p role="alert" class="text-sm font-medium text-(--text-primary)">
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
                class="font-label text-sm font-semibold text-(--text-primary)"
                i18n="@@vendor.contests.submitted.heading"
              >
                Submitted
              </h4>
              @if (submitted().length === 0) {
                <p
                  class="mt-2 max-w-prose text-sm text-(--text-secondary)"
                  i18n="@@vendor.contests.submitted.empty"
                >
                  You have not contested anything. Open an integration under one of your products
                  and choose Contest a field.
                </p>
              } @else {
                <ul
                  class="mt-2 divide-y divide-(--border-default) border-y border-(--border-default)"
                >
                  @for (contest of submitted(); track contest.id) {
                    <li class="space-y-2 py-4" [attr.data-contest]="contest.id">
                      <ng-container
                        [ngTemplateOutlet]="summary"
                        [ngTemplateOutletContext]="{ $implicit: contest }"
                      />
                      <p class="text-xs text-(--text-secondary)">
                        @if (contest.status === 'open') {
                          {{ routeLabel(contest) }}
                          <span aria-hidden="true"> · </span>
                        }
                        <ng-container i18n="@@vendor.contests.sent">Sent</ng-container>
                        {{ contest.created_at | date: 'mediumDate' }}
                        @if (contest.decided_at; as decided) {
                          <span aria-hidden="true"> · </span>
                          <ng-container i18n="@@vendor.contests.decided">Decided</ng-container>
                          {{ decided | date: 'mediumDate' }}
                        }
                      </p>
                      @if (contest.status === 'open') {
                        @if (confirming() === contest.id) {
                          <div class="flex flex-wrap items-center gap-2">
                            <p
                              class="text-sm text-(--text-primary)"
                              i18n="@@vendor.contests.withdraw.confirm"
                            >
                              Withdraw this contest? It cannot be reopened.
                            </p>
                            <button
                              type="button"
                              [id]="'vendor-contest-withdraw-' + contest.id"
                              [class]="secondaryClass"
                              [disabled]="busy() !== null"
                              (click)="withdraw(contest)"
                            >
                              @if (isBusy(contest, 'withdraw')) {
                                <span i18n="@@vendor.contests.withdrawing">Withdrawing…</span>
                              } @else {
                                <span i18n="@@vendor.contests.withdraw.yes">Withdraw</span>
                              }
                              <span class="sr-only">{{ rowName(contest) }}</span>
                            </button>
                            <button
                              type="button"
                              [class]="secondaryClass"
                              [disabled]="busy() !== null"
                              (click)="cancelWithdraw(contest)"
                              i18n="@@vendor.contests.withdraw.keep"
                            >
                              Keep it
                            </button>
                          </div>
                        } @else {
                          <button
                            type="button"
                            [id]="'vendor-contest-withdraw-start-' + contest.id"
                            [class]="secondaryClass"
                            [disabled]="busy() !== null"
                            (click)="startWithdraw(contest)"
                          >
                            <span i18n="@@vendor.contests.withdraw">Withdraw</span>
                            <span class="sr-only">{{ rowName(contest) }}</span>
                          </button>
                        }
                      }
                      @if (rowError()?.id === contest.id) {
                        <p role="alert" class="text-sm font-medium text-(--text-primary)">
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
        <p class="font-label text-sm text-(--text-primary)">{{ rowName(contest) }}</p>
        <span [class]="pillClass(contest.status)">{{ statusLabel(contest.status) }}</span>
      </div>
      <dl class="grid max-w-prose grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm">
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

  protected readonly loading = this.store.contestsLoading;
  protected readonly failed = this.store.contestsFailed;
  protected readonly received = computed(() => this.store.contests().received);
  protected readonly submitted = computed(() => this.store.contests().submitted);

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
          ? $localize`:@@vendor.contests.live.failed:Your contests could not be loaded.`
          : $localize`:@@vendor.contests.live.reloaded:Contests updated.`,
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
        $localize`:@@vendor.contests.withdraw.error:Could not withdraw that contest. Try again.`,
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
        message: $localize`:@@vendor.contests.error.notOpen:This contest was already decided or withdrawn. The list now shows where it stands.`,
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

  protected statusLabel(status: ContestStatus): string {
    return contestStatusLabel(status);
  }

  protected pillClass(status: ContestStatus): string {
    const base =
      'inline-flex shrink-0 items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]';
    return status === 'open' || status === 'accepted'
      ? `${base} border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)`
      : `${base} border-(--border-strong) bg-(--surface-raised) text-(--text-primary)`;
  }

  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
}
