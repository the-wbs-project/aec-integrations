import {
  OverlayModule,
  type CdkConnectedOverlayConfig,
  type ConnectedPosition,
} from '@angular/cdk/overlay';
import { DOCUMENT, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';
import { RouterLink } from '@angular/router';

import { QueueAccountFilter, injectQueueAccount } from './queue-account-filter';

import { lastSeatRefusalVendorId } from '../last-seat-refusal';
import {
  BrnDialog,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { z } from 'zod';

import {
  REVIEW_REASON_MAX,
  reviewDecisionsFor,
  type AdminReview,
  type RepeatOffenderPrompt,
  type ReviewDecision,
  type ReviewStatus,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AdminPaginator } from '../admin-paginator';
import { AdminSummaryStore } from '../admin-summary.store';
import { CONSOLE_FILTER } from '../console/console-filter';
import { CONSOLE_LABEL_CLASS, CONSOLE_TABLE } from '../console/console-table';
import { AdminDangerAction, type AdminDangerConfirmStep } from '../console/danger-action';
import { AdminDisclosureButton } from '../console/disclosure-button';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import {
  BanPendingChoice,
  banPendingCounts,
  banPendingTotal,
  isBanPendingChanged,
  isBanRejectTooMany,
  type BanPendingCounts,
} from '../reviewers/ban-pending-choice';
import { ReviewerBansApi } from '../reviewers/reviewer-bans-api';
import { AdminUsersApi } from '../users/admin-users-api';
import { AdminReviewsApi } from './admin-reviews-api';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import { AecEarlyInput } from '../../shared/form-field/early-input';
import { AecButton } from '../../shared/button/button';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';
import { FIELD_ERROR_CLASS, FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import {
  QUEUE_BODY_CLASS,
  QUEUE_DETAIL_GRID_CLASS,
  QUEUE_FACTS_CLASS,
  QUEUE_FAILED_CLASS,
  QUEUE_HELP_CLASS,
} from './queue-classes';
import { queueFocusAfterRemoval } from './queue-focus';
import { CONSOLE_NOTICE_CLASS } from '../console/console-detail';

/** Score at/above which a review is flagged "high toxicity" and styled with a
 *  warning. 70 is our cutoff on the 0–100 toxicity score; the default sort
 *  already floats the worst content to the top (§22.2), this just labels it. */
const HIGH_TOXICITY_THRESHOLD = 70;

/** One request covers a launch-scale moderation backlog. The API caps `perPage`
 *  at 100; client-side sorting (toxicity/product/reviewer) only reorders what's
 *  loaded, so we load the max and surface a note if the server reports more. */
const QUEUE_PAGE_SIZE = 100;

/** Rows per screen. The loaded set (at most `QUEUE_PAGE_SIZE`) is cut into pages
 *  of this size in the browser, because the sorts run over the loaded set. */
const SCREEN_PAGE_SIZE = 25;

type SortKey = 'toxicity' | 'queue_age' | 'product' | 'reviewer';

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
 * requires a trimmed reason of 1 to 500 characters, the rule the API enforces.
 *
 * ── STATUS TABS AND REMOVE (AECI-1643, `ADMIN_PANEL_SPEC.md` §5.21) ──────────
 * Pending (the default), Approved, Rejected and Removed, as on
 * `/admin/review-updates` (the Same-Behavior Rule). The buttons a card carries come
 * from `reviewDecisionsFor(status)`, the table the API enforces: Approve and Reject
 * on a pending review, Remove on an approved one, nothing on rejected or removed.
 * Remove needs a reason and a second, deliberate confirm, the same inline two-step
 * the review-updates queue uses. A remove does not touch the pending badge.
 *
 * ── THE TABLE (AECI-2102, mock-up 14, ruled 2026-11-24) ──────────────────────
 * One row per review on the console table recipe. The review text, its facts and
 * the decision forms sit in the row's detail, opened by its leading disclosure.
 * Previous and Next page the loaded set (`SCREEN_PAGE_SIZE` a page); the capped-set
 * note is unchanged. Focus: after a decision removes a row it moves to the
 * disclosure of the row that took its place, or to the queue heading when none
 * is left. A failed decision moves it to the row's alert, because the disabled
 * button would otherwise drop it to the body.
 *
 * ── THE DANGER FORM (AECI-2104 part 2) ───────────────────────────────────────
 * Reject and Remove are `<aec-admin-danger-action>` (`admin/console/danger-action.ts`):
 * the opener, the reason, its refusals, Remove's locked second step, Cancel and
 * Escape live there. This component keeps which row's form is open, the in-flight
 * id it passes as `busy`, and the row-level failure alert, which Approve shares.
 */
@Component({
  selector: 'aec-review-queue',
  imports: [
    AdminDangerAction,
    AdminDisclosureButton,
    AdminPaginator,
    AecButton,
    AecFormSubmit,
    AecIcon,
    BanPendingChoice,
    Chip,
    DatePipe,
    QueueAccountFilter,
    OverlayModule,
    RouterLink,
    FormField,
    AecEarlyInput,
    BrnDialog,
    BrnDialogContent,
    BrnDialogTitle,
    BrnDialogDescription,
  ],
  templateUrl: './review-queue.html',
})
export class ReviewQueue {
  /** A field's inline error: the shared recipe (AECI-1984). */
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly t = CONSOLE_TABLE;
  protected readonly f = CONSOLE_FILTER;
  protected readonly labelClass = CONSOLE_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly noticeClass = CONSOLE_NOTICE_CLASS;
  protected readonly detailGridClass = QUEUE_DETAIL_GRID_CLASS;
  protected readonly bodyClass = QUEUE_BODY_CLASS;
  protected readonly factsClass = QUEUE_FACTS_CLASS;
  protected readonly helpClass = QUEUE_HELP_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  /** The table's columns, for the detail cell's `colspan`. */
  protected readonly columnCount = 9;
  protected readonly pageSize = SCREEN_PAGE_SIZE;
  private readonly document = inject(DOCUMENT);
  private readonly api = inject(AdminReviewsApi);
  private readonly bansApi = inject(ReviewerBansApi);
  private readonly usersApi = inject(AdminUsersApi);
  private readonly summaryStore = inject(AdminSummaryStore);

  /** The loaded pending reviews (server order; the view applies the sort). */
  private readonly reviews = signal<readonly AdminReview[]>([]);
  /** Total pending reported by the server (may exceed what we loaded). */
  protected readonly total = signal(0);

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  /** Id of the review whose action is in flight (disables its buttons). */
  protected readonly pendingActionId = signal<string | null>(null);
  /** Which decision is in flight on `pendingActionId` (AECI-2104). A form's busy
   *  label and its hidden status speak only for its own decision, so an Approve
   *  pressed while a reason form is open never reads as that form's action. */
  private readonly pendingDecision = signal<ReviewDecision | null>(null);

  /** The decision `action` is the one in flight on row `id`. */
  protected busyWith(id: string, action: ReviewDecision): boolean {
    return this.pendingActionId() === id && this.pendingDecision() === action;
  }
  /** Id of the review whose reject form is open (one at a time). */
  protected readonly rejectingId = signal<string | null>(null);
  // ── AECI-1643 status tabs + remove ─────────────────────────────────────────
  protected readonly statusFilter = signal<ReviewStatus>('pending');
  protected readonly statusOptions: ReadonlyArray<{ key: ReviewStatus; label: string }> = [
    { key: 'pending', label: $localize`:@@admin.reviews.filter.pending:Pending` },
    { key: 'approved', label: $localize`:@@admin.reviews.filter.approved:Approved` },
    { key: 'rejected', label: $localize`:@@admin.reviews.filter.rejected:Rejected` },
    { key: 'removed', label: $localize`:@@admin.reviews.filter.removed:Removed` },
  ];
  protected readonly reasonMax = REVIEW_REASON_MAX;
  /** Id of the review whose remove form is open (one at a time). */
  protected readonly removingId = signal<string | null>(null);

  /** Reject's words. One message covers both of its rules (empty, over 500). */
  protected readonly rejectCopy = {
    opener: $localize`:@@admin.reviews.reject:Reject`,
    label: $localize`:@@admin.reviews.reject.label:Reason for rejection`,
    error: $localize`:@@admin.reviews.reject.error:Enter a reason between 1 and 500 characters so the reviewer understands the decision.`,
    confirm: $localize`:@@admin.reviews.reject.confirm:Confirm rejection`,
    busy: $localize`:@@admin.reviews.rejecting:Rejecting…`,
    cancel: $localize`:@@admin.reviews.reject.cancel:Cancel`,
  } as const;

  /** Remove's words. The reason is natively capped at `reasonMax`. */
  protected readonly removeCopy = {
    opener: $localize`:@@admin.reviews.remove:Remove from the page`,
    label: $localize`:@@admin.reviews.remove.label:Why you are removing it (required)`,
    help: $localize`:@@admin.reviews.remove.reasonHelp:Shown to the reviewer on their account page. Name the guideline the review breaks.`,
    missing: $localize`:@@admin.reviews.remove.missing:Write a reason before you confirm.`,
    confirm: $localize`:@@admin.reviews.removeConfirm.confirm:Remove permanently`,
    busy: $localize`:@@admin.reviews.removing:Removing…`,
    cancel: $localize`:@@admin.reviews.remove.cancel:Cancel`,
  } as const;

  /** Removal is final, so it takes a second, deliberate step. */
  protected readonly removeStep: AdminDangerConfirmStep = {
    continueLabel: $localize`:@@admin.reviews.remove.continue:Continue to removal`,
    title: $localize`:@@admin.reviews.removeConfirm.title:Remove this review permanently?`,
    body: $localize`:@@admin.reviews.removeConfirm.body:Removal is final. The review comes off the product page with its vendor replies and updates, and its ratings stop counting in the product's averages. The reviewer cannot post a new review of this product. Nobody can undo it from this screen.`,
    editLabel: $localize`:@@admin.reviews.removeConfirm.edit:Edit the reason`,
  };

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
          (a, b) => compareText(a.product.name, b.product.name) || byCreatedAtAsc(a, b),
        );
      case 'reviewer':
        return list.sort(byReviewerNullsLast);
    }
  });

  protected readonly loadedCount = computed(() => this.reviews().length);

  // ── AECI-2102 the table: open rows and the screen page ─────────────────────
  /** Ids of the rows whose detail is open. The parent owns it, per the recipe. */
  private readonly openIds = signal<ReadonlySet<string>>(new Set());
  /** The page asked for. `currentPage` clamps it when decisions shrink the set. */
  private readonly page = signal(1);
  protected readonly currentPage = computed(() => {
    const pages = Math.max(1, Math.ceil(this.reviews().length / SCREEN_PAGE_SIZE));
    return Math.min(this.page(), pages);
  });
  /** The rows on screen: one page of the sorted, loaded set. */
  protected readonly pagedReviews = computed(() => {
    const start = (this.currentPage() - 1) * SCREEN_PAGE_SIZE;
    return this.sortedReviews().slice(start, start + SCREEN_PAGE_SIZE);
  });
  /** True when the server has more pending than we loaded (note shown). */
  protected readonly truncated = computed(() => this.total() > this.reviews().length);

  // ── AECI-218 repeat-offender prompt + ban dialog ───────────────────────────
  /** Set by a reject whose response carried a repeat-offender prompt (reviewer's
   *  3rd+ rejection). Drives the dismissible banner atop the queue. */
  protected readonly repeatOffenderPrompt = signal<RepeatOffenderPrompt | null>(null);
  /** The reviewer being banned in the dialog (non-null → the dialog is open). */
  protected readonly banTarget = signal<RepeatOffenderPrompt | null>(null);
  protected readonly banSubmitting = signal(false);
  protected readonly banFailed = signal(false);
  /** `409 VENDOR_LAST_SEAT_USE_SUSPEND` (AECI-1623): a retry can never work, so the dialog
   *  points at Suspend on the vendor page instead of asking for one. */
  protected readonly banLastSeatVendorId = signal<string | null>(null);
  /** AECI-1949: the reviewer's pending items, read from `GET /api/admin/users/:id`
   *  when the dialog opens. `null` until it lands, or when the read failed: the
   *  dialog then bans without rejecting, as before. */
  protected readonly banCounts = signal<BanPendingCounts | null>(null);
  protected readonly banRejectPending = signal(true);
  /** `409 BAN_PENDING_CHANGED` or `422 BAN_REJECT_TOO_MANY`: the message to show. */
  protected readonly banPendingProblem = signal<'changed' | 'too_many' | null>(null);

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
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** AECI-1949: `?account=` narrows the queue to one person, as on `/admin/dmca`. */
  protected readonly account = injectQueueAccount();
  /** The filtered person's address, off a loaded row. */
  protected readonly accountEmail = computed(() => {
    const id = this.account();
    return id ? (this.reviews().find((r) => r.reviewer_id === id)?.reviewer_email ?? null) : null;
  });
  /** The account the last load asked for, so the effect reloads only on a change. */
  private loadedAccount: string | null | undefined = undefined;

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
    // A changed `?account=` (the filter bar's Clear, Back) reloads the list.
    effect(() => {
      const account = this.account();
      untracked(() => {
        if (this.loadedAccount !== undefined && account !== this.loadedAccount) {
          this.page.set(1);
          void this.load();
        }
      });
    });
    this.destroyRef.onDestroy(() => {
      if (this.legendCloseTimer) clearTimeout(this.legendCloseTimer);
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    this.loading.set(true);
    const account = this.account();
    this.loadedAccount = account;
    try {
      const res = await this.api.listPending({
        status: this.statusFilter(),
        ...(account ? { account_id: account } : {}),
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

  protected isOpen(id: string): boolean {
    return this.openIds().has(id);
  }

  protected toggleRow(id: string): void {
    this.openIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The row's name, true open or closed: `aria-expanded` carries the state. */
  protected rowLabel(r: AdminReview): string {
    const product = r.product.name;
    const reviewer = r.reviewer_email ?? $localize`:@@admin.reviews.meta.anonymized:Anonymized`;
    return $localize`:@@admin.reviews.row.label:Review of ${product}:product: by ${reviewer}:reviewer:`;
  }

  protected setPage(page: number): void {
    this.page.set(page);
  }

  /** Switch the status tab: close any open form and reload that status. */
  protected setStatus(status: ReviewStatus): void {
    if (this.statusFilter() === status) return;
    this.statusFilter.set(status);
    this.page.set(1);
    this.rejectingId.set(null);
    this.removingId.set(null);
    this.failedAction.set(null);
    this.liveMessage.set('');
    void this.load();
  }

  protected statusLabel(status: ReviewStatus): string {
    return this.statusOptions.find((o) => o.key === status)?.label ?? status;
  }

  protected decisionsFor(r: AdminReview): readonly ReviewDecision[] {
    return reviewDecisionsFor(r.status);
  }

  protected canApprove(r: AdminReview): boolean {
    return this.decisionsFor(r).includes('approve');
  }

  protected canReject(r: AdminReview): boolean {
    return this.decisionsFor(r).includes('reject');
  }

  protected canRemove(r: AdminReview): boolean {
    return this.decisionsFor(r).includes('remove');
  }

  protected setSort(key: SortKey): void {
    this.sortKey.set(key);
    this.page.set(1);
  }

  /** A console chip tone, by the console's word for the status. */
  protected tone(key: AdminStatusKey): ConsoleChipTone {
    return adminStatusTone(key);
  }

  /** The chip tone for a review status. Exhaustive: a new status fails to compile. */
  protected statusTone(status: ReviewStatus): ConsoleChipTone {
    switch (status) {
      case 'pending':
        return adminStatusTone('pending');
      case 'approved':
        return adminStatusTone('approved');
      case 'rejected':
        return adminStatusTone('rejected');
      case 'removed':
        return adminStatusTone('removed');
    }
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
    this.pendingDecision.set('approve');
    try {
      await this.api.moderate(id, { action: 'approve' });
      this.onModerated(id, $localize`:@@admin.reviews.announce.approved:Review approved.`);
    } catch (err) {
      this.onModerateError(id, err);
    } finally {
      this.pendingActionId.set(null);
      this.pendingDecision.set(null);
    }
  }

  /** The reject form opened or closed (its opener, Cancel or Escape). One row's
   *  form is open at a time. The danger form starts each open clean and focuses
   *  its own field, and it ignores a close while the row's request runs. */
  protected onRejectOpen(id: string, open: boolean): void {
    if (open) {
      this.failedAction.set(null);
      this.rejectingId.set(id);
    } else if (this.rejectingId() === id) {
      this.rejectingId.set(null);
    }
  }

  /** The danger form checked the reason (trimmed, 1 to 500 characters). */
  protected async confirmReject(id: string, reason: string): Promise<void> {
    if (this.pendingActionId()) return;
    this.failedAction.set(null);
    this.pendingActionId.set(id);
    this.pendingDecision.set('reject');
    try {
      const res = await this.api.moderate(id, { action: 'reject', rejection_reason: reason });
      this.rejectingId.set(null);
      this.onModerated(id, $localize`:@@admin.reviews.announce.rejected:Review rejected.`);
      // AECI-218: surface the advisory "consider a ban" banner when this
      // rejection was the reviewer's 3rd+ (the API decides; null otherwise).
      this.repeatOffenderPrompt.set(res.repeat_offender);
    } catch (err) {
      this.onModerateError(id, err);
    } finally {
      this.pendingActionId.set(null);
      this.pendingDecision.set(null);
    }
  }

  // ── AECI-1643 remove a published review ────────────────────────────────────

  /** The remove form opened or closed. As for Reject. */
  protected onRemoveOpen(id: string, open: boolean): void {
    if (open) {
      this.failedAction.set(null);
      this.removingId.set(id);
    } else if (this.removingId() === id) {
      this.removingId.set(null);
    }
  }

  /** Step two's "Remove permanently". The danger form checked the reason and
   *  showed the locked confirm first. Only this press sends. */
  protected async confirmRemove(id: string, reason: string): Promise<void> {
    if (this.pendingActionId()) return;
    this.failedAction.set(null);
    this.pendingActionId.set(id);
    this.pendingDecision.set('remove');
    try {
      await this.api.moderate(id, { action: 'remove', rejection_reason: reason });
      this.removingId.set(null);
      // Not in the pending count, so the badge does not move.
      this.removeRow(id);
      this.liveMessage.set(
        $localize`:@@admin.reviews.announce.removed:Review removed from the product page. The reviewer can see your reason on their account page.`,
      );
    } catch (err) {
      if (isAlreadyModerated(err)) this.removingId.set(null);
      this.onModerateError(id, err);
    } finally {
      this.pendingActionId.set(null);
      this.pendingDecision.set(null);
    }
  }

  /** Focus an element of this queue once the next render lands: by id, or by a
   *  selector when the id is not known. */
  private focusAfterRender(elementId: string | undefined, selector?: string): void {
    const query = selector ?? `[id="${elementId}"]`;
    afterNextRender(
      { write: () => this.host.nativeElement.querySelector<HTMLElement>(query)?.focus() },
      { injector: this.injector },
    );
  }

  /** Drop the moderated row, decrement the badge, and announce the result. */
  private onModerated(id: string, announcement: string): void {
    this.removeRow(id);
    this.summaryStore.decrement('reviews');
    this.liveMessage.set(announcement);
  }

  /** The row is no longer in this tab's state, so drop it without decrementing
   *  (the count resyncs on the next full visit). A 422 means it was already decided
   *  when we read it. A `409 REVIEW_ALREADY_MODERATED` means another admin's
   *  decision landed first while ours was in flight, and ours wrote nothing
   *  (AECI-1203). Anything else is a retryable failure surfaced inline on the row. */
  private onModerateError(id: string, err: unknown): void {
    if (isAlreadyModerated(err)) {
      this.removeRow(id);
      this.rejectingId.set(null);
      this.failedAction.set(null);
      this.liveMessage.set(
        $localize`:@@admin.reviews.announce.alreadyModerated:That review was already moderated.`,
      );
      return;
    }
    this.failedAction.set({ id, reason: 'generic' });
    this.focusAfterRender(`review-${id}-failed`);
  }

  /** Drop a decided row, then move focus by the queues' one rule
   *  (`queueFocusAfterRemoval`): the row that took its place, the last row of the
   *  new last page, the heading, or nowhere when the row was not on screen. */
  private removeRow(id: string): void {
    const index = this.pagedReviews().findIndex((r) => r.id === id);
    const pageBefore = this.currentPage();
    this.reviews.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
    this.openIds.update((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    const target = queueFocusAfterRemoval(
      index,
      pageBefore,
      this.currentPage(),
      this.pagedReviews(),
    );
    if (target.kind === 'none') return;
    this.focusAfterRender(
      target.kind === 'heading' ? 'admin-reviews-heading' : undefined,
      target.kind === 'row' ? `[aria-controls="review-${target.row.id}-detail"]` : undefined,
    );
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
    this.banLastSeatVendorId.set(null);
    this.banReasonModel.set({ reason: '' });
    this.banForm.reason().reset();
    this.banCounts.set(null);
    this.banRejectPending.set(true);
    this.banPendingProblem.set(null);
    this.banTarget.set(prompt);
    this.banDialog()?.open();
    void this.loadBanCounts(prompt.reviewer_id);
  }

  /** AECI-1949: the same counts `/admin/users/:id` shows. A failed read leaves them
   *  `null`, so the dialog offers no reject. */
  private async loadBanCounts(reviewerId: string): Promise<void> {
    try {
      const detail = await this.usersApi.getUser(reviewerId);
      if (this.banTarget()?.reviewer_id === reviewerId)
        this.banCounts.set(banPendingCounts(detail));
    } catch {
      if (this.banTarget()?.reviewer_id === reviewerId) this.banCounts.set(null);
    }
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
    this.banLastSeatVendorId.set(null);
    this.banPendingProblem.set(null);
    await submit(this.banForm, async (f) => {
      const reason = f().value().reason.trim();
      const rejectPending = banPendingTotal(this.banCounts()) > 0 && this.banRejectPending();
      this.banSubmitting.set(true);
      try {
        const result = await this.bansApi.ban(target.reviewer_id, {
          action: 'ban',
          reason,
          ...(rejectPending ? { reject_pending: true } : {}),
        });
        this.closeBan();
        this.repeatOffenderPrompt.set(null);
        const rejected = banPendingTotal(result.rejected ?? null);
        this.liveMessage.set(
          rejected > 0
            ? $localize`:@@admin.reviews.ban.announce.bannedRejected:Reviewer banned. ${rejected}:COUNT: pending items rejected.`
            : $localize`:@@admin.reviews.ban.announce.banned:Reviewer banned.`,
        );
        // The rejected reviews leave the pending tab.
        if (rejected > 0) void this.load();
        // The notice and its "Ban reviewer" button are gone, so focus the heading.
        this.focusAfterRender('admin-reviews-heading');
      } catch (err) {
        // Keep the dialog open so the admin can retry; surface an inline error.
        const lastSeatVendorId = lastSeatRefusalVendorId(err);
        let alertId = 'ban-failed';
        if (lastSeatVendorId) {
          this.banLastSeatVendorId.set(lastSeatVendorId);
          alertId = 'ban-last-seat';
        } else if (isBanPendingChanged(err) || isBanRejectTooMany(err)) {
          // AECI-1949: nothing was saved. Show the new counts and ask again.
          const changed = isBanPendingChanged(err);
          this.banPendingProblem.set(changed ? 'changed' : 'too_many');
          if (changed) {
            this.banRejectPending.set(true);
            await this.loadBanCounts(target.reviewer_id);
          }
          alertId = 'ban-pending-problem';
        } else {
          this.banFailed.set(true);
        }
        // The dialog is in the CDK overlay, outside this host, so look it up on the document.
        afterNextRender(
          { write: () => this.document.getElementById(alertId)?.focus() },
          { injector: this.injector },
        );
      } finally {
        this.banSubmitting.set(false);
      }
      return undefined;
    });
  }
}

/** created_at ascending (oldest first) — the queue-age order. ISO timestamps
 *  compare in binary, never with an unpinned `localeCompare` (AECI-1243); `id`
 *  breaks a same-millisecond tie. */
function byCreatedAtAsc(a: AdminReview, b: AdminReview): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
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
  return compareText(ea, eb) || byCreatedAtAsc(a, b);
}

/** A 422, or the `409 REVIEW_ALREADY_MODERATED` a lost moderation race answers. */
function isAlreadyModerated(err: unknown): boolean {
  if (!(err instanceof HttpErrorResponse)) return false;
  if (err.status === 422) return true;
  const inner = (err.error as { error?: { code?: unknown } } | null | undefined)?.error;
  return err.status === 409 && inner?.code === 'REVIEW_ALREADY_MODERATED';
}
