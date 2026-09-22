import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  AdminContest,
  ContestDecision,
  ContestProtestDecision,
  ContestProtestStatus,
  ContestRoute,
  ContestStatus,
  DecideContestInput,
  ListAdminContestsQuery,
} from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { mechanismKindLabel } from '../../search/mechanism-labels';
import {
  contestFieldLabel,
  contestStatusLabel,
} from '../../vendor/components/vendor-contest-labels';
import { AdminSummaryStore } from '../admin-summary.store';
import { AdminContestsApi } from './admin-contests-api';

/** One request covers a launch-scale backlog. The API caps `perPage` at 100; we
 *  load the max and say so when the server reports more. */
const QUEUE_PAGE_SIZE = 100;

/**
 * AECI-1008 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b — the admin queue for
 * integration field contests, rendered in the `AdminShell` outlet at
 * `/admin/contests`. A sibling of `/admin/claims`: the same SSR-shell plus
 * client-fetch shape, the same pessimistic inline decision forms.
 *
 * A contest is one seated vendor saying one field of an integration is wrong. The
 * row carries the value on record, the proposed value and the vendor's reason.
 * This screen decides the rows routed to AECi (`routed_to = 'aeci'`).
 *
 * ── ACCEPT WRITES NO CATALOG DATA ───────────────────────────────────────────
 * The catalog is curated upstream and arrives through promote, so a value written
 * here would be undone by the next promote. Accept records the decision and the
 * API files a `REVIEW - ` Linear issue after commit (playbook AECI-1025). The
 * Accept control says so in plain words, because "accepted" otherwise reads as
 * "the page is fixed". An accepted row shows the issue link, or "Linear issue
 * pending" until the post-commit filing (or the §6.7 sweep) lands it.
 *
 * ── OWNER-ROUTED ROWS ARE READ-ONLY ─────────────────────────────────────────
 * The "Decided by" filter can show owner-routed rows so an operator can see a
 * dispute. They render "With the owner" and carry no decision buttons: the PATCH
 * refuses them with `409 CONTEST_ROUTED_TO_OWNER`, and two deciders on one row is
 * how a contest gets accepted twice with two values.
 *
 * ── PROTESTS (AECI-1009 / §11b.12) ──────────────────────────────────────────
 * A Contests / Protests switch. Protests lists rows by `protest_status` and shows
 * both sides in full: the contest, the owner's note (or 30 days of silence), the
 * submitter's case and links, and the owner's one reply or its due date. The
 * decision is "Agree with the submitter" or "Agree with the owner", with a
 * REQUIRED note. It is advice: it changes nothing on the listing and files no
 * Linear issue, and the form says so. The owner's reply date does not block it.
 *
 * ── THE BADGE ───────────────────────────────────────────────────────────────
 * `pending_contests` counts open AECi-routed rows, a different table from the
 * other Operations queues, so the Operations sum stays honest. A successful
 * decision on an open AECi row decrements it. A `409 CONTEST_NOT_OPEN` does not:
 * the row was closed by someone else (another admin, or the vendor withdrawing),
 * and, as on `/admin/claims`, the next full visit re-seeds the count.
 */
@Component({
  selector: 'aec-contest-queue',
  imports: [DatePipe, NewTabIcon, RouterLink],
  templateUrl: './contest-queue.html',
})
export class ContestQueue {
  private readonly api = inject(AdminContestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);

  /** The loaded contests, in server order (newest first). */
  private readonly contests = signal<readonly AdminContest[]>([]);
  /** Rows matching the current filters, as the server reports it. */
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the contest whose decision is in flight (disables its buttons). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** The contest and decision whose form is open, one at a time. */
  protected readonly formOpenId = signal<string | null>(null);
  protected readonly formMode = signal<ContestDecision | null>(null);
  /** The decision note. Shown to the submitting vendor, and on accept also copied
   *  into the Linear issue. */
  protected readonly formText = signal('');
  /** Id and message of the contest whose last decision failed (inline alert). */
  protected readonly failedActionId = signal<string | null>(null);
  protected readonly failedActionMessage = signal('');
  /** The one polite live region. Rows vanish on success, so the outcome is
   *  announced here, and it stays visible so a sighted operator sees it too. */
  protected readonly liveMessage = signal('');

  protected readonly statusFilter = signal<ContestStatus>('open');
  protected readonly routeFilter = signal<ContestRoute>('aeci');
  /** AECI-1009: which list the screen shows. */
  protected readonly view = signal<'contests' | 'protests'>('contests');
  protected readonly protestFilter = signal<ContestProtestStatus>('open');

  protected readonly viewOptions: ReadonlyArray<{ key: 'contests' | 'protests'; label: string }> = [
    { key: 'contests', label: $localize`:@@admin.contests.view.contests:Contests` },
    { key: 'protests', label: $localize`:@@admin.contests.view.protests:Protests` },
  ];

  protected readonly protestOptions: ReadonlyArray<{ key: ContestProtestStatus; label: string }> = [
    { key: 'open', label: $localize`:@@admin.contests.protest.filter.open:Open` },
    {
      key: 'upheld',
      label: $localize`:@@admin.contests.protest.filter.upheld:Agreed with the submitter`,
    },
    {
      key: 'rejected',
      label: $localize`:@@admin.contests.protest.filter.rejected:Agreed with the owner`,
    },
    { key: 'withdrawn', label: $localize`:@@admin.contests.protest.filter.withdrawn:Withdrawn` },
  ];

  protected readonly statusOptions: ReadonlyArray<{ key: ContestStatus; label: string }> = [
    { key: 'open', label: $localize`:@@admin.contests.filter.status.open:Open` },
    { key: 'accepted', label: $localize`:@@admin.contests.filter.status.accepted:Accepted` },
    { key: 'declined', label: $localize`:@@admin.contests.filter.status.declined:Declined` },
    { key: 'withdrawn', label: $localize`:@@admin.contests.filter.status.withdrawn:Withdrawn` },
  ];

  protected readonly routeOptions: ReadonlyArray<{ key: ContestRoute; label: string }> = [
    { key: 'aeci', label: $localize`:@@admin.contests.filter.route.aeci:AEC Integrations` },
    { key: 'owner', label: $localize`:@@admin.contests.filter.route.owner:The owner` },
  ];

  protected readonly visibleContests = computed(() => this.contests());
  protected readonly loadedCount = computed(() => this.contests().length);
  protected readonly truncated = computed(() => this.total() > this.contests().length);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    const query: Partial<ListAdminContestsQuery> =
      this.view() === 'protests'
        ? { protest_status: this.protestFilter(), page: 1, perPage: QUEUE_PAGE_SIZE }
        : {
            status: this.statusFilter(),
            routed_to: this.routeFilter(),
            page: 1,
            perPage: QUEUE_PAGE_SIZE,
          };
    try {
      const res = await this.api.listContests(query);
      this.contests.set(res.data);
      this.total.set(res.total);
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  protected retry(): void {
    void this.load();
  }

  protected setStatus(status: ContestStatus): void {
    if (this.statusFilter() === status) return;
    this.statusFilter.set(status);
    this.closeForm();
    void this.load();
  }

  protected setView(view: 'contests' | 'protests'): void {
    if (this.view() === view) return;
    this.view.set(view);
    this.closeForm();
    this.closeProtestForm();
    void this.load();
  }

  protected setProtestFilter(status: ContestProtestStatus): void {
    if (this.protestFilter() === status) return;
    this.protestFilter.set(status);
    this.closeProtestForm();
    void this.load();
  }

  protected setRoute(route: ContestRoute): void {
    if (this.routeFilter() === route) return;
    this.routeFilter.set(route);
    this.closeForm();
    void this.load();
  }

  /** Open rows AECi decides: AECi-routed ones, and stranded owner-routed ones. */
  protected isActionable(c: AdminContest): boolean {
    return c.status === 'open' && (c.routed_to === 'aeci' || this.isStranded(c));
  }

  /**
   * An owner-routed row whose owner vendor was deleted (`owner_vendor` is null). No
   * vendor can decide it any more, so AECi does (AECI-1005).
   */
  protected isStranded(c: AdminContest): boolean {
    return c.routed_to === 'owner' && c.owner_vendor === null;
  }

  // ── Display ──────────────────────────────────────────────────────────────

  protected readonly fieldLabel = contestFieldLabel;
  protected readonly statusLabel = contestStatusLabel;

  /** The pair, as the heading names it. */
  protected pairLabel(c: AdminContest): string {
    const a = c.integration.source_product.name;
    const b = c.integration.target_product.name;
    return $localize`:@@admin.contests.pair:${a}:a: and ${b}:b:`;
  }

  /**
   * One value, as an operator reads it. Values arrive in STORAGE form: `direction`
   * is `a_to_b | b_to_a | both` with A the source product, and `owner` is a vendor
   * id whose name the server sends as the label.
   */
  protected valueDisplay(c: AdminContest, which: 'current' | 'proposed' | 'live'): string {
    const value =
      which === 'current' ? c.current_value : which === 'live' ? c.live_value : c.proposed_value;
    const label =
      which === 'current' ? c.current_label : which === 'live' ? c.live_label : c.proposed_label;
    if (c.field === 'owner') {
      if (value === null) {
        return which !== 'proposed'
          ? $localize`:@@admin.contests.owner.noneOnRecord:No owner on record`
          : $localize`:@@admin.contests.owner.neither:Neither endpoint vendor`;
      }
      return label ?? value;
    }
    if (value === null || value === '') {
      return $localize`:@@admin.contests.value.none:Not on record`;
    }
    if (c.field === 'mechanism_kind') return mechanismKindLabel(value) || value;
    if (c.field === 'direction') {
      const a = c.integration.source_product.name;
      const b = c.integration.target_product.name;
      switch (value) {
        case 'a_to_b':
          return $localize`:@@admin.contests.direction.aToB:${a}:from: sends to ${b}:to:`;
        case 'b_to_a':
          return $localize`:@@admin.contests.direction.bToA:${b}:from: sends to ${a}:to:`;
        case 'both':
          return $localize`:@@admin.contests.direction.both:Syncs both ways`;
      }
    }
    return value;
  }

  /**
   * Whether the field's live value moved since the contest was filed (AECI-1006).
   * Only an open contest shows it: on a closed one the difference is history, not
   * a reason to act. `live_value` is `undefined` from a pre-AECI-1006 API, which
   * reads as "no difference".
   */
  protected liveDiffers(c: AdminContest): boolean {
    return c.status === 'open' && c.live_value !== undefined && c.live_value !== c.current_value;
  }

  /** The owner snapshot taken at submit, or the plain absence of one. */
  protected ownerName(c: AdminContest): string {
    return (
      c.owner_vendor?.name || $localize`:@@admin.contests.owner.noneOnRecord2:No owner on record`
    );
  }

  /** Relative age. Browser-only: the list is empty during SSR. */
  protected age(createdAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
    if (minutes < 60) return $localize`:@@admin.contests.age.minutes:${minutes}:COUNT: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@admin.contests.age.hours:${hours}:COUNT: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@admin.contests.age.days:${days}:COUNT: d`;
  }

  // ── Decisions ────────────────────────────────────────────────────────────

  protected openForm(id: string, mode: ContestDecision): void {
    this.failedActionId.set(null);
    this.formText.set('');
    this.formMode.set(mode);
    this.formOpenId.set(id);
  }

  protected closeForm(): void {
    this.formOpenId.set(null);
    this.formMode.set(null);
    this.formText.set('');
  }

  protected onFormInput(event: Event): void {
    this.formText.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirm(id: string, decision: ContestDecision): Promise<void> {
    if (this.pendingActionId()) return;
    const note = this.formText().trim();
    const input: DecideContestInput = { decision, ...(note ? { note } : {}) };
    // Read before the row is dropped: only an open AECi row is in the count.
    const row = this.contests().find((c) => c.id === id);
    const wasCounted = !!row && this.isActionable(row);
    this.failedActionId.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.decide(id, input);
      this.closeForm();
      this.removeRow(id);
      if (wasCounted) this.summaryStore.decrement('contests');
      this.liveMessage.set(
        decision === 'accept'
          ? $localize`:@@admin.contests.announce.accepted2:Contest accepted. A review issue is being filed in Linear.`
          : $localize`:@@admin.contests.announce.declined:Contest declined. The vendor that filed it can see your note.`,
      );
    } catch (err) {
      this.handleDecisionError(id, err);
    } finally {
      this.pendingActionId.set(null);
    }
  }

  /**
   * `409 CONTEST_NOT_OPEN`: someone else closed it first. Say so and reload, so the
   * row shows the state that won. `409 CONTEST_ROUTED_TO_OWNER`: the owner decides
   * this row. Anything else is a retryable failure.
   */
  private handleDecisionError(id: string, err: unknown): void {
    const code = apiErrorCode(err);
    if (code === 'CONTEST_NOT_OPEN') {
      this.closeForm();
      this.liveMessage.set(
        $localize`:@@admin.contests.announce.alreadyDecided:Already decided. That contest was closed before your decision reached it, so the list has been reloaded.`,
      );
      void this.load();
      return;
    }
    this.failedActionId.set(id);
    if (code === 'CONTEST_VALUE_STALE') {
      // The value moved since this list loaded. Reload so the row shows the live
      // value and the stale note, and say why nothing changed.
      this.closeForm();
      this.liveMessage.set(
        $localize`:@@admin.contests.announce.stale:Not accepted. The value on the integration changed after this contest was filed, so accepting would overwrite it. The list has been reloaded to show the current value.`,
      );
      void this.load();
      return;
    }
    if (code === 'CONTEST_ROUTED_TO_OWNER') {
      this.failedActionMessage.set(
        $localize`:@@admin.contests.action.routedToOwner:The integration's owner decides this contest, not AEC Integrations. Nothing was changed.`,
      );
      return;
    }
    this.failedActionMessage.set(
      $localize`:@@admin.contests.action.failed:Something went wrong. Please try again.`,
    );
  }

  // ── Protests (AECI-1009) ─────────────────────────────────────────────────

  protected readonly protestFormOpenId = signal<string | null>(null);
  protected readonly protestMode = signal<ContestProtestDecision | null>(null);
  protected readonly protestNote = signal('');
  protected readonly protestNoteMissing = signal(false);

  protected protestStatusLabel(status: ContestProtestStatus): string {
    return this.protestOptions.find((o) => o.key === status)?.label ?? status;
  }

  /** True while the owner can still reply: no reply yet and the due date ahead. */
  protected replyPending(c: AdminContest): boolean {
    const p = c.protest;
    return (
      !!p && p.status === 'open' && p.reply === null && Date.now() < Date.parse(p.reply_due_at)
    );
  }

  protected openProtestForm(id: string, mode: ContestProtestDecision): void {
    this.failedActionId.set(null);
    this.protestNote.set('');
    this.protestNoteMissing.set(false);
    this.protestMode.set(mode);
    this.protestFormOpenId.set(id);
  }

  protected closeProtestForm(): void {
    this.protestFormOpenId.set(null);
    this.protestMode.set(null);
    this.protestNote.set('');
    this.protestNoteMissing.set(false);
  }

  protected onProtestNote(event: Event): void {
    this.protestNote.set((event.target as HTMLTextAreaElement).value);
    if (this.protestNoteMissing()) this.protestNoteMissing.set(false);
  }

  protected async confirmProtest(id: string, decision: ContestProtestDecision): Promise<void> {
    if (this.pendingActionId()) return;
    const note = this.protestNote().trim();
    if (note === '') {
      this.protestNoteMissing.set(true);
      return;
    }
    this.failedActionId.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.decideProtest(id, { decision, note });
      this.closeProtestForm();
      this.removeRow(id);
      this.summaryStore.decrement('contests');
      this.liveMessage.set(
        decision === 'uphold'
          ? $localize`:@@admin.contests.protest.announce.upheld:Recorded: AEC Integrations agrees with the submitter. Both vendors can see your note. The listing did not change.`
          : $localize`:@@admin.contests.protest.announce.rejected:Recorded: AEC Integrations agrees with the owner. Both vendors can see your note, and the submitter cannot contest this field again for 90 days unless its value changes.`,
      );
    } catch (err) {
      if (apiErrorCode(err) === 'PROTEST_NOT_OPEN') {
        this.closeProtestForm();
        this.liveMessage.set(
          $localize`:@@admin.contests.protest.announce.notOpen:Already decided or withdrawn. The list has been reloaded.`,
        );
        void this.load();
      } else {
        this.failedActionId.set(id);
        this.failedActionMessage.set(
          $localize`:@@admin.contests.protest.failed:Something went wrong. Please try again.`,
        );
      }
    } finally {
      this.pendingActionId.set(null);
    }
  }

  private removeRow(id: string): void {
    this.contests.update((list) => list.filter((c) => c.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
  }
}

/** The `code` from the API's `{ error: { code } }` envelope, or `null`. */
function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof HttpErrorResponse)) return null;
  const inner = (err.error as { error?: { code?: unknown } } | null | undefined)?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}
