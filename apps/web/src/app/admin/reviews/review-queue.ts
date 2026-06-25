import {
  OverlayModule,
  type CdkConnectedOverlayConfig,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import {
  BrnDialog,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { z } from 'zod';

import type { AdminReview, RepeatOffenderPrompt } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { AdminReviewsApi } from './admin-reviews-api';

/** Score at/above which a review is flagged "high toxicity" and styled with a
 *  warning. 70 is our cutoff on the 0–100 toxicity score; the default sort
 *  already floats the worst content to the top (§22.2), this just labels it. */
const HIGH_TOXICITY_THRESHOLD = 70;

/** One request covers a launch-scale moderation backlog. The API caps `perPage`
 *  at 100; client-side sorting (toxicity/product/reviewer) only reorders what's
 *  loaded, so we load the max and surface a note if the server reports more. */
const QUEUE_PAGE_SIZE = 100;

type SortKey = 'toxicity' | 'queue_age' | 'product' | 'reviewer';

/** Reject-reason rule (local — there's no separate `@aeci/shared` schema for the
 *  field alone; the wire body is `ModerateReviewSchema`). `.trim().min(1)` makes a
 *  whitespace-only reason invalid; the API enforces the same on its side. */
const RejectReasonSchema = z.object({
  rejection_reason: z.string().trim().min(1).max(500),
});

/** Ban-reason rule (AECI-218). Same shape/limits as the reject reason; the API
 *  enforces the same via `BanReviewerSchema`'s refine. */
const BanReasonSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

/**
 * AECI-205 / Phase 5.14 — the admin review moderation queue, rendered in the
 * `AdminShell` layout's outlet at `/admin/reviews`.
 *
 * Like `/account`, the gate + badge SSR via `adminSummaryResolver` (the parent
 * route), so the queue itself paints its shell during SSR and fetches the list
 * client-side in `afterNextRender` — the same-origin `GET /api/admin/reviews`
 * carries the session cookie, which the API Worker's `requireAdmin()` verifies.
 * It never reads cookies or session state directly.
 *
 * Ordering: the 5.13 API only sorts `queue_age|created_at` server-side, but the
 * AC asks for toxicity-first plus product/reviewer sorts, so ordering is applied
 * client-side over the loaded page. Default = toxicity high→low (nulls last) to
 * "surface the worst content first" (§22.2); the user can re-sort by queue age,
 * product, or reviewer.
 *
 * Each approve/reject is a `PATCH` that, on success, removes the row and
 * decrements `AdminSummaryStore` so the nav badge ticks down immediately. Reject
 * requires a non-empty reason (Signal Forms + Aria), mirroring the review form.
 */
@Component({
  selector: 'aec-review-queue',
  imports: [
    DatePipe,
    OverlayModule,
    RouterLink,
    FormField,
    BrnDialog,
    BrnDialogContent,
    BrnDialogTitle,
    BrnDialogDescription,
  ],
  templateUrl: './review-queue.html',
})
export class ReviewQueue {
  private readonly api = inject(AdminReviewsApi);
  private readonly bansApi = inject(ReviewerBansApi);
  private readonly summaryStore = inject(AdminSummaryStore);

  /** The loaded pending reviews (server order; the view applies the sort). */
  private readonly reviews = signal<readonly AdminReview[]>([]);
  /** Total pending reported by the server (may exceed what we loaded). */
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the review whose action is in flight (disables its buttons). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** Id of the review whose reject form is open (one at a time). */
  protected readonly rejectingId = signal<string | null>(null);
  /** Last failed action, keyed to a row so the alert renders inline. */
  protected readonly failedAction = signal<{ id: string; reason: 'generic' | 'already' } | null>(
    null,
  );
  /** Polite live-region message — the row vanishes on success, so announce it. */
  protected readonly liveMessage = signal('');

  protected readonly sortKey = signal<SortKey>('toxicity');

  protected readonly sortOptions: ReadonlyArray<{ key: SortKey; label: string }> = [
    { key: 'toxicity', label: $localize`:@@admin.reviews.sort.toxicity:Toxicity` },
    { key: 'queue_age', label: $localize`:@@admin.reviews.sort.queueAge:Queue age` },
    { key: 'product', label: $localize`:@@admin.reviews.sort.product:Product` },
    { key: 'reviewer', label: $localize`:@@admin.reviews.sort.reviewer:Reviewer` },
  ];

  /** Reviews in display order. Recomputes when the list or sort key changes. */
  protected readonly sortedReviews = computed<readonly AdminReview[]>(() => {
    const list = [...this.reviews()];
    switch (this.sortKey()) {
      case 'toxicity':
        return list.sort(byToxicityDescNullsLast);
      case 'queue_age':
        return list.sort(byCreatedAtAsc);
      case 'product':
        return list.sort(
          (a, b) => a.product.name.localeCompare(b.product.name) || byCreatedAtAsc(a, b),
        );
      case 'reviewer':
        return list.sort(byReviewerNullsLast);
    }
  });

  protected readonly loadedCount = computed(() => this.reviews().length);
  /** True when the server has more pending than we loaded (note shown). */
  protected readonly truncated = computed(() => this.total() > this.reviews().length);

  /** Reject-form model + Signal Form (shared by whichever row's reject is open). */
  private readonly rejectionModel = signal<{ rejection_reason: string }>({ rejection_reason: '' });
  protected readonly rejectForm = form(this.rejectionModel, (p) => {
    validateStandardSchema(p, RejectReasonSchema);
  });

  // ── AECI-218 repeat-offender prompt + ban dialog ───────────────────────────
  /** Set by a reject whose response carried a repeat-offender prompt (reviewer's
   *  3rd+ rejection). Drives the dismissible banner atop the queue. */
  protected readonly repeatOffenderPrompt = signal<RepeatOffenderPrompt | null>(null);
  /** The reviewer being banned in the dialog (non-null → the dialog is open). */
  protected readonly banTarget = signal<RepeatOffenderPrompt | null>(null);
  protected readonly banSubmitting = signal(false);
  protected readonly banFailed = signal(false);

  /** Localized stand-in for the reviewer's name when their email is unknown
   *  (anonymized). Held here as a `$localize` string so the fallback stays
   *  translatable — an inline `?? 'This reviewer'` in the template would bake the
   *  English into the binding expression, which i18n extraction can't reach. */
  protected readonly fallbackReviewerName = $localize`:@@admin.reviews.ban.fallbackReviewer:This reviewer`;

  /** Ban-reason model + Signal Form (the dialog's required reason). */
  private readonly banReasonModel = signal<{ reason: string }>({ reason: '' });
  protected readonly banForm = form(this.banReasonModel, (p) => {
    validateStandardSchema(p, BanReasonSchema);
  });

  private readonly banDialog = viewChild(BrnDialog);

  /** Exposed so the legend can name the high-toxicity band without hard-coding 70. */
  protected readonly highToxicityThreshold = HIGH_TOXICITY_THRESHOLD;

  /** Which trigger the shared toxicity-scale legend is anchored to (null = closed).
   *  The legend is a `cdkConnectedOverlay`, not a focus-trapping dialog, so revealing
   *  it (hover, click, or keyboard) never pulls focus out of what the admin is doing. */
  protected readonly legendOrigin = signal<HTMLElement | null>(null);
  /** Below the trigger, end-aligned with a 6px gap; flips above when there's no room. */
  protected readonly legendPositions: ConnectedPosition[] = [
    { originX: 'end', originY: 'bottom', overlayX: 'end', overlayY: 'top', offsetY: 6 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -6 },
  ];
  /** Connected-overlay config (origin + positions); recomputed only when the active
   *  trigger changes, so an idle queue never churns the overlay. */
  protected readonly legendOverlayConfig = computed<CdkConnectedOverlayConfig>(() => ({
    origin: this.legendOrigin() ?? undefined,
    positions: this.legendPositions,
  }));
  /** Grace timer so the pointer can travel from a trigger onto the panel without the
   *  legend flickering shut; cleared on destroy. */
  private legendCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
    this.destroyRef.onDestroy(() => {
      if (this.legendCloseTimer) clearTimeout(this.legendCloseTimer);
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    try {
      const res = await this.api.listPending({
        status: 'pending',
        sort: 'queue_age',
        page: 1,
        perPage: QUEUE_PAGE_SIZE,
      });
      this.reviews.set(res.data);
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

  protected setSort(key: SortKey): void {
    this.sortKey.set(key);
  }

  protected isHighToxicity(score: number | null): boolean {
    return score !== null && score >= HIGH_TOXICITY_THRESHOLD;
  }

  /** Accessible name for a toxicity badge — gives the bare number meaning ("of 100")
   *  for screen-reader users and signals the badge reveals the scale. Built in TS
   *  with `$localize` because interpolated `i18n-*` attributes don't extract. */
  protected toxicityAriaLabel(score: number | null): string {
    return score === null
      ? $localize`:@@admin.reviews.toxicity.aria.notScored:Toxicity not scored. Show the toxicity scale.`
      : $localize`:@@admin.reviews.toxicity.aria.scored:Toxicity score ${score}:score: of 100. Show the toxicity scale.`;
  }

  /** Anchor the shared legend to a trigger and show it. Cancels any pending close so
   *  moving between a badge and the panel keeps it open; re-anchoring to a different
   *  trigger just repositions the single overlay (only one legend open at a time). */
  protected openLegend(origin: HTMLElement): void {
    this.cancelLegendClose();
    this.legendOrigin.set(origin);
  }

  /** Keep the legend open while the pointer is over the panel. */
  protected keepLegendOpen(): void {
    this.cancelLegendClose();
  }

  /** Toggle the legend for a trigger (click / Enter / Space). */
  protected toggleLegend(origin: HTMLElement): void {
    if (this.legendOrigin() === origin) this.closeLegend();
    else this.openLegend(origin);
  }

  /** Close after a short grace, so the pointer can travel from the trigger onto the
   *  panel (which re-opens via its own `mouseenter`) without it flickering shut. */
  protected scheduleCloseLegend(): void {
    this.cancelLegendClose();
    this.legendCloseTimer = setTimeout(() => {
      this.legendOrigin.set(null);
      this.legendCloseTimer = null;
    }, 120);
  }

  /** Close the legend immediately (re-click, blur, or Escape). */
  protected closeLegend(): void {
    this.cancelLegendClose();
    this.legendOrigin.set(null);
  }

  private cancelLegendClose(): void {
    if (this.legendCloseTimer) {
      clearTimeout(this.legendCloseTimer);
      this.legendCloseTimer = null;
    }
  }

  /** Relative queue age (e.g. "3 d", "5 h", "12 min"). Browser-only — the list
   *  is empty during SSR, so `Date.now()` is never read server-side. */
  protected queueAge(createdAt: string): string {
    const minutes = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60_000));
    if (minutes < 60) return $localize`:@@admin.reviews.age.minutes:${minutes}:COUNT: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@admin.reviews.age.hours:${hours}:COUNT: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@admin.reviews.age.days:${days}:COUNT: d`;
  }

  protected roleLabel(role: string): string {
    switch (role) {
      case 'practitioner':
        return $localize`:@@admin.reviews.role.practitioner:Practitioner`;
      case 'manager':
        return $localize`:@@admin.reviews.role.manager:Manager`;
      case 'IT':
        return $localize`:@@admin.reviews.role.it:IT`;
      case 'exec':
        return $localize`:@@admin.reviews.role.exec:Executive`;
      case 'other':
        return $localize`:@@admin.reviews.role.other:Other`;
      default:
        return role;
    }
  }

  protected recommendLabel(recommend: 'yes' | 'no' | 'maybe'): string {
    switch (recommend) {
      case 'yes':
        return $localize`:@@admin.reviews.recommend.yes:Would recommend`;
      case 'no':
        return $localize`:@@admin.reviews.recommend.no:Would not recommend`;
      case 'maybe':
        return $localize`:@@admin.reviews.recommend.maybe:Might recommend`;
    }
  }

  // ── Moderation actions ─────────────────────────────────────────────────────

  protected async approve(id: string): Promise<void> {
    if (this.pendingActionId()) return;
    this.failedAction.set(null);
    this.pendingActionId.set(id);
    try {
      await this.api.moderate(id, { action: 'approve' });
      this.onModerated(id, $localize`:@@admin.reviews.announce.approved:Review approved.`);
    } catch (err) {
      this.onModerateError(id, err);
    } finally {
      this.pendingActionId.set(null);
    }
  }

  /** Open the inline reject form for a row (resets the shared field + its
   *  touched/invalid state, so a prior failed submit doesn't show a stale error
   *  on the freshly opened, empty form). */
  protected openReject(id: string): void {
    this.failedAction.set(null);
    this.rejectionModel.set({ rejection_reason: '' });
    this.rejectForm.rejection_reason().reset();
    this.rejectingId.set(id);
  }

  protected cancelReject(): void {
    this.rejectingId.set(null);
    this.rejectionModel.set({ rejection_reason: '' });
    this.rejectForm.rejection_reason().reset();
  }

  protected async confirmReject(id: string): Promise<void> {
    if (this.pendingActionId()) return;
    this.failedAction.set(null);
    await submit(this.rejectForm, async (f) => {
      const reason = f().value().rejection_reason.trim();
      this.pendingActionId.set(id);
      try {
        const res = await this.api.moderate(id, { action: 'reject', rejection_reason: reason });
        this.rejectingId.set(null);
        this.rejectionModel.set({ rejection_reason: '' });
        this.onModerated(id, $localize`:@@admin.reviews.announce.rejected:Review rejected.`);
        // AECI-218: surface the advisory "consider a ban" banner when this
        // rejection was the reviewer's 3rd+ (the API decides; null otherwise).
        this.repeatOffenderPrompt.set(res.repeat_offender);
      } catch (err) {
        this.onModerateError(id, err);
      } finally {
        this.pendingActionId.set(null);
      }
      return undefined;
    });
  }

  /** Drop the moderated row, decrement the badge, and announce the result. */
  private onModerated(id: string, announcement: string): void {
    this.removeRow(id);
    this.summaryStore.decrement();
    this.liveMessage.set(announcement);
  }

  /** A 422 means the row is no longer pending (raced by another admin): drop it
   *  without decrementing (the count resyncs on the next full visit). Anything
   *  else is a retryable failure surfaced inline on the row. */
  private onModerateError(id: string, err: unknown): void {
    if (err instanceof HttpErrorResponse && err.status === 422) {
      this.removeRow(id);
      this.rejectingId.set(null);
      this.failedAction.set(null);
      this.liveMessage.set(
        $localize`:@@admin.reviews.announce.alreadyModerated:That review was already moderated.`,
      );
      return;
    }
    this.failedAction.set({ id, reason: 'generic' });
  }

  private removeRow(id: string): void {
    this.reviews.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
  }

  // ── AECI-218 ban actions ───────────────────────────────────────────────────

  /** Dismiss the repeat-offender banner without banning. */
  protected dismissPrompt(): void {
    this.repeatOffenderPrompt.set(null);
  }

  /** Open the ban dialog for the prompted reviewer (resets the reason field).
   *  Driven imperatively (not via an effect): `BrnDialog.open()` creates its own
   *  effect internally, which Angular forbids from inside another effect. */
  protected openBan(): void {
    const prompt = this.repeatOffenderPrompt();
    if (!prompt) return;
    this.banFailed.set(false);
    this.banReasonModel.set({ reason: '' });
    this.banForm.reason().reset();
    this.banTarget.set(prompt);
    this.banDialog()?.open();
  }

  /** Close the ban dialog (Cancel button, backdrop click, or Escape). */
  protected closeBan(): void {
    this.banTarget.set(null);
    this.banReasonModel.set({ reason: '' });
    this.banForm.reason().reset();
    this.banDialog()?.close();
  }

  protected async confirmBan(): Promise<void> {
    if (this.banSubmitting()) return;
    const target = this.banTarget();
    if (!target) return;
    this.banFailed.set(false);
    await submit(this.banForm, async (f) => {
      const reason = f().value().reason.trim();
      this.banSubmitting.set(true);
      try {
        await this.bansApi.ban(target.reviewer_id, { action: 'ban', reason });
        this.closeBan();
        this.repeatOffenderPrompt.set(null);
        this.liveMessage.set($localize`:@@admin.reviews.ban.announce.banned:Reviewer banned.`);
      } catch {
        // Keep the dialog open so the admin can retry; surface an inline error.
        this.banFailed.set(true);
      } finally {
        this.banSubmitting.set(false);
      }
      return undefined;
    });
  }
}

/** created_at ascending (oldest first) — the queue-age order. */
function byCreatedAtAsc(a: AdminReview, b: AdminReview): number {
  return a.created_at.localeCompare(b.created_at);
}

/** toxicity_score descending, nulls last, oldest-first tiebreak. */
function byToxicityDescNullsLast(a: AdminReview, b: AdminReview): number {
  const sa = a.toxicity_score;
  const sb = b.toxicity_score;
  if (sa === null && sb === null) return byCreatedAtAsc(a, b);
  if (sa === null) return 1;
  if (sb === null) return -1;
  return sb - sa || byCreatedAtAsc(a, b);
}

/** reviewer_email locale-compare, nulls last, oldest-first tiebreak. */
function byReviewerNullsLast(a: AdminReview, b: AdminReview): number {
  const ea = a.reviewer_email;
  const eb = b.reviewer_email;
  if (ea === null && eb === null) return byCreatedAtAsc(a, b);
  if (ea === null) return 1;
  if (eb === null) return -1;
  return ea.localeCompare(eb) || byCreatedAtAsc(a, b);
}
