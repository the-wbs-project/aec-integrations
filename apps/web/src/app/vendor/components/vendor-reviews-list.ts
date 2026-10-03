import { DatePipe, DOCUMENT, formatDate } from '@angular/common';
import {
  Component,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  REVIEW_RESPONSE_BODY_MAX,
  ReviewResponseBodySchema,
  type ListVendorReviewsResponse,
  type PublicVendorResponse,
  type ReviewReplyStatusFilter,
  type VendorProduct,
  type VendorReviewItem,
  type VendorReviewResponse,
} from '@aeci/shared';

import { ReviewStars } from '../../reviews/review-stars';
import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { productCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  REVIEW_FILTER_ORDER,
  reviewFilterLabel,
  reviewReplyStateHint,
  reviewReplyStateLabel,
  reviewWriteErrorMessage,
  reviewWriteErrorReloads,
  type ReviewComposeMode,
  type ReviewReplyState,
} from './vendor-review-labels';

/** Reviews per page. Small: each row can open a form. */
export const VENDOR_REVIEWS_PAGE_SIZE = 10;

type Busy = { readonly reviewId: string; readonly action: 'save' | 'withdraw' };
type Compose = { readonly reviewId: string; readonly mode: ReviewComposeMode };

/**
 * The portal Reviews tab for one product (AECI-1179, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11c.16).
 *
 * One page of `GET /api/vendor/reviews?product_id=…`: approved reviews of this
 * product, newest first. Each row shows the review read-only, any co-owner's
 * published reply read-only, and the caller's own reply in its state: no reply,
 * pending, published, rejected (with the reason), withdrawn, or removed (with the
 * reason, and no action, because removal is final).
 *
 * ── ACTIONS (§11c.16) ───────────────────────────────────────────────────────
 * Reply on no reply. Edit on pending and published. Resubmit on rejected and
 * withdrawn. Withdraw on pending and published, behind an inline confirm (the
 * contests list pattern, never `confirm()`). Editing a published reply warns,
 * before save, that it leaves the page until AECi approves it again (ruling 5).
 *
 * ── THE GATE (§11c.9) ───────────────────────────────────────────────────────
 * Read as `productCan(product, 'review.reply')`, never off `me().entitlement`. A
 * product without it keeps the list and the states. Reply, Edit and Resubmit are
 * replaced by a visible reason tied to the reply block by `aria-describedby`
 * (§6.18's locked-field treatment). Withdraw stays: taking your own words down is
 * never paid. The server refuses regardless (`403 ENTITLEMENT_REQUIRED`).
 *
 * ── WRITES ──────────────────────────────────────────────────────────────────
 * Pessimistic. The echo is the committed row, so it is spliced in, and the page is
 * then re-read quietly so a filter that no longer matches drops the row. A `409`
 * (or a `404`: the review left the page) re-reads at once and says why.
 *
 * ── LIVE ────────────────────────────────────────────────────────────────────
 * The `reviews` cursor scope bumps `store.reviewsRevision()`. With no form open the
 * tab re-reads its open page without blanking it. With a form open it says the
 * list changed and offers a reload, because replacing half-typed text is worse
 * than a stale row (`STAGE_2_REALTIME_SPEC.md` §6).
 */
@Component({
  selector: 'aec-vendor-reviews-list',
  imports: [AecSelect, DatePipe, ReviewStars, RouterLink],
  host: { class: 'block' },
  template: `
    <section aria-labelledby="vendor-reviews-heading" data-vendor-reviews>
      <div class="max-w-[60ch] space-y-2">
        <h2 id="vendor-reviews-heading" class="m-0">
          <!-- The size lives on the span: styles.css sizes h2 outside any cascade layer. -->
          <span
            class="block font-display text-xl font-semibold text-(--text-primary)"
            i18n="@@vendor.reviews.heading"
            >Reviews</span
          >
        </h2>
        <p class="text-sm leading-relaxed text-(--text-secondary)" i18n="@@vendor.reviews.intro">
          Approved reviews of this product, newest first. You can answer each one once, in public.
          AEC Integrations checks every reply against the
          <a
            routerLink="/legal/review-guidelines"
            class="font-medium text-(--accent-primary) underline underline-offset-2"
            >review guidelines</a
          >
          before it shows. A reply never changes a review or where the product ranks.
        </p>
      </div>

      @if (!canReply()) {
        <!--
          The locked-field treatment of AECI-1218 (STAGE_2_VENDOR_PORTAL_SPEC.md
          section 6.18): the lock glyph and a visible reason that names Managed
          for this product. Every reply section points at it with aria-describedby.
        -->
        <p
          id="vendor-reviews-locked"
          class="mt-4 flex max-w-[60ch] items-start gap-2 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-primary)"
          data-reviews-locked
          data-testid="locked-reason"
        >
          <svg
            aria-hidden="true"
            class="mt-0.5 h-4 w-4 shrink-0 text-(--text-secondary)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span i18n="@@vendor.reviews.locked"
            >Replying to reviews is part of Managed for this product. You can still read every
            review, see where your past replies stand, and withdraw a reply you posted.</span
          >
        </p>
      }

      @if (listAlert()) {
        <p
          id="vendor-reviews-alert"
          tabindex="-1"
          role="alert"
          class="mt-4 max-w-[60ch] rounded-(--radius-md) border border-(--border-strong) bg-(--surface-raised) px-4 py-3 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
          data-reviews-alert
        >
          {{ listAlert() }}
        </p>
      }

      @if (stale()) {
        <div
          class="mt-4 flex max-w-[60ch] flex-wrap items-center gap-3 rounded-(--radius-md) bg-(--surface-sunken) px-4 py-3 text-sm text-(--text-primary)"
          data-reviews-stale
        >
          <span i18n="@@vendor.reviews.stale">These reviews changed elsewhere.</span>
          <button
            type="button"
            [class]="secondaryClass"
            (click)="discardAndReload()"
            i18n="@@vendor.reviews.stale.reload"
          >
            Reload the list
          </button>
        </div>
      }

      <div class="mt-6 max-w-xs">
        <aec-select
          i18n-label="@@vendor.reviews.filter"
          label="Show"
          layout="stacked"
          idPrefix="vendor-reviews-filter"
          [options]="filterOptions"
          [value]="filter()"
          [disabled]="compose() !== null"
          (changed)="applyFilter($event)"
        />
      </div>

      @if (state() === 'failed' && !response()) {
        <div class="mt-6 space-y-2" data-reviews-failed>
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.reviews.failed">
            Could not load the reviews.
          </p>
          <button
            type="button"
            [class]="secondaryClass"
            (click)="reload()"
            i18n="@@vendor.reviews.retry"
          >
            Try again
          </button>
        </div>
      } @else if (!response()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@vendor.reviews.loading">
          Loading reviews…
        </p>
      } @else {
        @if (state() === 'failed') {
          <div
            class="mt-4 flex max-w-[60ch] flex-wrap items-center gap-3 text-sm text-(--text-primary)"
            data-reviews-refresh-failed
          >
            <span i18n="@@vendor.reviews.refreshFailed"
              >Could not refresh the list. It shows what was loaded last.</span
            >
            <button
              type="button"
              [class]="secondaryClass"
              (click)="reload()"
              i18n="@@vendor.reviews.retry"
            >
              Try again
            </button>
          </div>
        }

        @if (items().length === 0) {
          <p class="mt-6 max-w-[60ch] text-sm text-(--text-secondary)" data-reviews-empty>
            {{ emptyMessage() }}
          </p>
        } @else {
          <ul class="mt-6 space-y-8" [attr.aria-busy]="refreshing() ? 'true' : null">
            @for (item of items(); track item.review.id) {
              <li [attr.data-review]="item.review.id" [attr.data-reply-state]="stateOf(item)">
                <article class="space-y-3" [attr.aria-labelledby]="titleId(item)">
                  <div
                    class="space-y-3 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-5"
                  >
                    <div class="flex flex-wrap items-start justify-between gap-3">
                      <h3
                        [id]="titleId(item)"
                        class="min-w-0 break-words font-semibold text-(--text-primary)"
                      >
                        {{ item.review.title }}
                      </h3>
                      <span class="shrink-0 text-xs text-(--text-secondary)">{{
                        item.review.created_at | date: 'mediumDate'
                      }}</span>
                    </div>
                    <div
                      class="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-(--text-secondary)"
                    >
                      <span class="flex items-center gap-1.5">
                        <span i18n="@@vendor.reviews.item.overall">Overall</span>
                        <aec-review-stars [rating]="item.review.rating_overall" kind="overall" />
                      </span>
                      <span class="flex items-center gap-1.5">
                        <span i18n="@@vendor.reviews.item.onboarding">Onboarding</span>
                        <aec-review-stars
                          [rating]="item.review.rating_onboarding"
                          kind="onboarding"
                        />
                      </span>
                    </div>
                    <p
                      class="whitespace-pre-line break-words text-sm leading-relaxed text-(--text-secondary)"
                    >
                      {{ item.review.body }}
                    </p>
                  </div>

                  @for (other of item.other_responses; track other.vendor_slug) {
                    <section
                      [class]="replyBlockClass"
                      [attr.aria-labelledby]="otherId(item, other)"
                      data-other-response
                    >
                      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <h4
                          [id]="otherId(item, other)"
                          class="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-(--text-primary)"
                        >
                          <!-- Hand-inlined Lucide corner-down-right. Decorative. -->
                          <svg
                            class="size-4 shrink-0 text-(--text-secondary) rtl:-scale-x-100"
                            aria-hidden="true"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <polyline points="15 10 20 15 15 20" />
                            <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                          </svg>
                          <span class="break-words">{{ otherLabel(other) }}</span>
                          <span class="sr-only">{{ replyContext(item) }}</span>
                        </h4>
                        <time
                          class="shrink-0 text-xs text-(--text-secondary)"
                          [attr.datetime]="other.published_at"
                          >{{ other.published_at | date: 'mediumDate' }}</time
                        >
                      </div>
                      <p
                        class="whitespace-pre-line break-words text-sm leading-relaxed text-(--text-secondary)"
                      >
                        {{ other.body }}
                      </p>
                      <p class="text-xs text-(--text-secondary)" i18n="@@vendor.reviews.other.note">
                        Another company that owns this product posted this reply. Only they can
                        change it.
                      </p>
                    </section>
                  }

                  <section
                    [id]="replyId(item)"
                    tabindex="-1"
                    [class]="
                      replyBlockClass +
                      ' focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)'
                    "
                    [attr.aria-labelledby]="replyHeadingId(item)"
                    [attr.aria-describedby]="canReply() ? null : 'vendor-reviews-locked'"
                    data-own-reply
                  >
                    <div class="flex flex-wrap items-center justify-between gap-2">
                      <h4
                        [id]="replyHeadingId(item)"
                        class="text-sm font-semibold text-(--text-primary)"
                      >
                        <span i18n="@@vendor.reviews.own.heading">Your reply</span>
                        <span class="sr-only">{{ replyContext(item) }}</span>
                      </h4>
                      <span [class]="pillClass(stateOf(item))" data-reply-pill>{{
                        stateLabel(stateOf(item))
                      }}</span>
                    </div>

                    <p class="text-xs text-(--text-secondary)">{{ stateHint(stateOf(item)) }}</p>

                    @if (item.response; as own) {
                      @if (!isComposing(item)) {
                        <p
                          class="whitespace-pre-line break-words text-sm leading-relaxed text-(--text-primary)"
                          data-own-body
                        >
                          {{ own.body }}
                        </p>
                      }
                      <p class="text-xs text-(--text-secondary)">{{ ownMeta(own) }}</p>
                      @if (
                        (own.status === 'rejected' || own.status === 'removed') &&
                        own.rejection_reason
                      ) {
                        <div
                          class="rounded-(--radius-md) border border-(--border-strong) bg-(--surface-raised) px-3 py-2 text-sm"
                          data-reply-reason
                        >
                          <p
                            class="text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase"
                            i18n="@@vendor.reviews.reason.label"
                          >
                            Reason from AEC Integrations
                          </p>
                          <p class="mt-1 whitespace-pre-line break-words text-(--text-primary)">
                            {{ own.rejection_reason }}
                          </p>
                        </div>
                      }
                    }

                    @if (isComposing(item)) {
                      <form
                        class="space-y-2"
                        novalidate
                        (submit)="$event.preventDefault(); save(item)"
                        data-reply-form
                      >
                        <label [for]="fieldId(item)" [class]="labelClass">{{
                          composeLabel()
                        }}</label>
                        <p [id]="fieldId(item) + '-hint'" class="text-xs text-(--text-secondary)">
                          {{ composeHint() }}
                        </p>
                        @if (editingPublished(item)) {
                          <p
                            [id]="fieldId(item) + '-warn'"
                            class="rounded-(--radius-md) border border-(--border-strong) bg-(--surface-raised) px-3 py-2 text-sm font-medium text-(--text-primary)"
                            data-reply-warning
                            i18n="@@vendor.reviews.compose.publishedWarning"
                          >
                            Saving takes your published reply off the product page. It shows again
                            only after AEC Integrations approves the change.
                          </p>
                        }
                        <textarea
                          [id]="fieldId(item)"
                          rows="6"
                          [value]="draft()"
                          (input)="setDraft($event)"
                          [attr.aria-describedby]="describedBy(item)"
                          [attr.aria-invalid]="formError() ? 'true' : null"
                          [class]="inputClass"
                        ></textarea>
                        <p
                          [id]="fieldId(item) + '-count'"
                          [class]="
                            overLimit()
                              ? 'text-xs font-semibold text-(--status-error)'
                              : 'text-xs text-(--text-secondary)'
                          "
                          data-reply-count
                        >
                          {{ countLabel() }}
                        </p>
                        @if (formError()) {
                          <p
                            [id]="fieldId(item) + '-error'"
                            role="alert"
                            class="text-sm font-medium text-(--status-error)"
                            data-reply-error
                          >
                            {{ formError() }}
                          </p>
                        }
                        <div class="flex flex-wrap items-center gap-2 pt-1">
                          <button type="submit" [class]="primaryClass" [disabled]="busy() !== null">
                            {{ isBusy(item, 'save') ? savingLabel() : saveLabel() }}
                          </button>
                          <button
                            type="button"
                            [class]="secondaryClass"
                            [disabled]="busy() !== null"
                            (click)="cancelCompose(item)"
                            i18n="@@vendor.reviews.compose.cancel"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    } @else {
                      <div class="flex flex-wrap items-center gap-2 pt-1">
                        @if (canReply() && composeModeFor(item); as mode) {
                          <button
                            type="button"
                            [id]="actionId(item)"
                            [class]="mode === 'create' ? primaryClass : secondaryClass"
                            [disabled]="busy() !== null || compose() !== null"
                            (click)="openCompose(item, mode)"
                            [attr.data-action]="mode"
                          >
                            <span>{{ actionLabel(mode) }}</span>
                            <span class="sr-only">{{ replyContext(item) }}</span>
                          </button>
                        }

                        @if (canWithdraw(item)) {
                          @if (confirming() === item.review.id) {
                            <div
                              class="flex basis-full flex-wrap items-center gap-2"
                              data-withdraw-confirm
                            >
                              <p class="text-sm text-(--text-primary)">
                                {{ withdrawQuestion(item) }}
                              </p>
                              <button
                                type="button"
                                [id]="withdrawConfirmId(item)"
                                [class]="secondaryClass"
                                [disabled]="busy() !== null"
                                (click)="withdraw(item)"
                              >
                                @if (isBusy(item, 'withdraw')) {
                                  <span i18n="@@vendor.reviews.withdrawing">Withdrawing…</span>
                                } @else {
                                  <span i18n="@@vendor.reviews.withdraw.yes">Withdraw</span>
                                }
                                <span class="sr-only">{{ replyContext(item) }}</span>
                              </button>
                              <button
                                type="button"
                                [class]="secondaryClass"
                                [disabled]="busy() !== null"
                                (click)="cancelWithdraw(item)"
                                i18n="@@vendor.reviews.withdraw.keep"
                              >
                                Keep it
                              </button>
                            </div>
                          } @else {
                            <button
                              type="button"
                              [id]="withdrawStartId(item)"
                              [class]="secondaryClass"
                              [disabled]="busy() !== null || compose() !== null"
                              (click)="startWithdraw(item)"
                            >
                              <span i18n="@@vendor.reviews.action.withdraw">Withdraw</span>
                              <span class="sr-only">{{ replyContext(item) }}</span>
                            </button>
                          }
                        }
                      </div>
                    }

                    @if (rowError()?.id === item.review.id) {
                      <p role="alert" class="text-sm font-medium text-(--text-primary)">
                        {{ rowError()?.message }}
                      </p>
                    }
                  </section>
                </article>
              </li>
            }
          </ul>

          @if (pageCount() > 1) {
            <nav class="mt-6 flex items-center gap-3" [attr.aria-label]="pagingLabel">
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="page() <= 1 || compose() !== null"
                (click)="goToPage(page() - 1)"
                i18n="@@vendor.reviews.page.prev"
              >
                Previous
              </button>
              <span class="text-sm text-(--text-secondary)">{{ pageLabel() }}</span>
              <button
                type="button"
                [class]="secondaryClass"
                [disabled]="page() >= pageCount() || compose() !== null"
                (click)="goToPage(page() + 1)"
                i18n="@@vendor.reviews.page.next"
              >
                Next
              </button>
            </nav>
          }
        }
      }
    </section>
  `,
})
export class VendorReviewsList {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly locale = inject(LOCALE_ID);

  readonly product = input.required<VendorProduct>();

  /** §11c.9: the portal reads the gate off THIS product's plan. */
  protected readonly canReply = computed(() => productCan(this.product(), 'review.reply'));

  protected readonly page = signal(1);
  protected readonly filter = signal<ReviewReplyStatusFilter | null>(null);
  protected readonly response = signal<ListVendorReviewsResponse | null>(null);
  protected readonly state = signal<'loading' | 'loaded' | 'failed'>('loading');
  protected readonly refreshing = signal(false);
  protected readonly stale = signal(false);
  protected readonly listAlert = signal('');

  protected readonly compose = signal<Compose | null>(null);
  protected readonly draft = signal('');
  protected readonly formError = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  protected readonly busy = signal<Busy | null>(null);
  protected readonly rowError = signal<{ id: string; message: string } | null>(null);

  private readonly rendered = signal(false);
  private ticket = 0;

  protected readonly items = computed(() => this.response()?.data ?? []);
  protected readonly pageCount = computed(() => {
    const r = this.response();
    return r ? Math.max(1, Math.ceil(r.total / r.perPage)) : 1;
  });
  protected readonly pageLabel = computed(
    () =>
      $localize`:@@vendor.reviews.page.label:Page ${this.page()}:PAGE: of ${this.pageCount()}:COUNT:`,
  );
  protected readonly pagingLabel = $localize`:@@vendor.reviews.page.aria:Review pages`;

  protected readonly emptyMessage = computed(() =>
    this.filter()
      ? $localize`:@@vendor.reviews.empty.filtered:No review matches that filter.`
      : $localize`:@@vendor.reviews.empty:This product has no approved reviews yet. When AEC Integrations approves one, it shows here.`,
  );

  protected readonly filterOptions: readonly AecSelectOption[] = [
    { value: null, label: $localize`:@@vendor.reviews.filter.all:All reviews` },
    ...REVIEW_FILTER_ORDER.map((value) => ({ value, label: reviewFilterLabel(value) })),
  ];

  protected readonly overLimit = computed(
    () => this.draft().trim().length > REVIEW_RESPONSE_BODY_MAX,
  );
  protected readonly countLabel = computed(() => {
    const n = this.draft().trim().length;
    const max = REVIEW_RESPONSE_BODY_MAX;
    return $localize`:@@vendor.reviews.compose.count:${n}:COUNT: of ${max}:MAX: characters`;
  });

  protected readonly composeLabel = computed(() => {
    switch (this.compose()?.mode) {
      case 'edit':
        return $localize`:@@vendor.reviews.compose.label.edit:Edit your reply`;
      case 'resubmit':
        return $localize`:@@vendor.reviews.compose.label.resubmit:Change and resubmit your reply`;
      default:
        return $localize`:@@vendor.reviews.compose.label.create:Your reply`;
    }
  });

  protected readonly composeHint = computed(
    () =>
      $localize`:@@vendor.reviews.compose.hint:Plain text. Line breaks are kept and links show as text. AEC Integrations checks it before it shows on the product page. Do not name the reviewer, offer them anything, or ask them to change the review.`,
  );

  protected readonly saveLabel = computed(() => {
    switch (this.compose()?.mode) {
      case 'edit':
        return $localize`:@@vendor.reviews.compose.save.edit:Save and send for approval`;
      case 'resubmit':
        return $localize`:@@vendor.reviews.compose.save.resubmit:Resubmit for approval`;
      default:
        return $localize`:@@vendor.reviews.compose.save.create:Send for approval`;
    }
  });
  protected readonly savingLabel = computed(
    () => $localize`:@@vendor.reviews.compose.saving:Sending…`,
  );

  constructor() {
    afterNextRender(() => this.rendered.set(true));

    // Load on first render, and again when the product, the filter or the page moves.
    effect(() => {
      if (!this.rendered()) return;
      const id = this.product().id;
      this.page();
      this.filter();
      if (!id) return;
      untracked(() => void this.load({ quiet: this.response() !== null }));
    });

    // A different product is a different list: drop any open form.
    let lastProduct: string | null = null;
    effect(() => {
      const id = this.product().id;
      if (lastProduct !== null && lastProduct !== id) {
        untracked(() => this.resetRowState());
      }
      lastProduct = id;
    });

    // The live cursor. The first value is the baseline, not a change.
    let seen: number | null = null;
    effect(() => {
      const revision = this.store.reviewsRevision();
      if (seen === null) {
        seen = revision;
        return;
      }
      if (revision === seen) return;
      seen = revision;
      untracked(() => {
        if (this.compose() !== null) this.stale.set(true);
        else if (this.response()) void this.load({ quiet: true });
      });
    });
  }

  // ─── Row derivations ────────────────────────────────────────────────────

  protected stateOf(item: VendorReviewItem): ReviewReplyState {
    return item.response?.status ?? 'none';
  }

  protected stateLabel(state: ReviewReplyState): string {
    return reviewReplyStateLabel(state);
  }

  protected stateHint(state: ReviewReplyState): string {
    return reviewReplyStateHint(state);
  }

  /** The one write a row offers besides Withdraw (§11c.16), or `null` on removed. */
  protected composeModeFor(item: VendorReviewItem): ReviewComposeMode | null {
    switch (this.stateOf(item)) {
      case 'none':
        return 'create';
      case 'pending':
      case 'published':
        return 'edit';
      case 'rejected':
      case 'withdrawn':
        return 'resubmit';
      default:
        return null;
    }
  }

  protected actionLabel(mode: ReviewComposeMode): string {
    switch (mode) {
      case 'create':
        return $localize`:@@vendor.reviews.action.reply:Reply`;
      case 'edit':
        return $localize`:@@vendor.reviews.action.edit:Edit`;
      case 'resubmit':
        return $localize`:@@vendor.reviews.action.resubmit:Resubmit`;
    }
  }

  protected canWithdraw(item: VendorReviewItem): boolean {
    const s = item.response?.status;
    return s === 'pending' || s === 'published';
  }

  protected isComposing(item: VendorReviewItem): boolean {
    return this.compose()?.reviewId === item.review.id;
  }

  protected editingPublished(item: VendorReviewItem): boolean {
    return this.compose()?.mode === 'edit' && item.response?.status === 'published';
  }

  protected isBusy(item: VendorReviewItem, action: Busy['action']): boolean {
    const b = this.busy();
    return b?.reviewId === item.review.id && b.action === action;
  }

  protected ownMeta(own: VendorReviewResponse): string {
    const fmt = (iso: string) => formatDate(iso, 'mediumDate', this.locale);
    if (own.status === 'published' && own.published_at) {
      const date = fmt(own.published_at);
      return $localize`:@@vendor.reviews.meta.published:Published ${date}:DATE:`;
    }
    if ((own.status === 'rejected' || own.status === 'removed') && own.moderated_at) {
      const date = fmt(own.moderated_at);
      return $localize`:@@vendor.reviews.meta.decided:Decided ${date}:DATE:`;
    }
    const date = fmt(own.updated_at);
    return $localize`:@@vendor.reviews.meta.updated:Last changed ${date}:DATE:`;
  }

  protected otherLabel(other: PublicVendorResponse): string {
    const name = other.vendor_name;
    return $localize`:@@vendor.reviews.other.label:Response from ${name}:VENDOR:`;
  }

  /** Screen-reader tail that ties a reply or an action to its review. */
  protected replyContext(item: VendorReviewItem): string {
    const title = item.review.title;
    return $localize`:@@vendor.reviews.replyContext: to the review “${title}:TITLE:”`;
  }

  protected withdrawQuestion(item: VendorReviewItem): string {
    return item.response?.status === 'published'
      ? $localize`:@@vendor.reviews.withdraw.confirm.published:Withdraw this reply? It comes off the product page now. You can resubmit it later, and AEC Integrations checks it again.`
      : $localize`:@@vendor.reviews.withdraw.confirm.pending:Withdraw this reply? AEC Integrations will not review it. You can resubmit it later.`;
  }

  protected describedBy(item: VendorReviewItem): string {
    const id = this.fieldId(item);
    return [
      `${id}-hint`,
      this.editingPublished(item) ? `${id}-warn` : null,
      `${id}-count`,
      this.formError() ? `${id}-error` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }

  // Element ids. A review id is a uuid, which is a valid id fragment.
  protected titleId(item: VendorReviewItem): string {
    return `vendor-review-title-${item.review.id}`;
  }
  protected replyId(item: VendorReviewItem): string {
    return `vendor-review-reply-${item.review.id}`;
  }
  protected replyHeadingId(item: VendorReviewItem): string {
    return `vendor-review-reply-heading-${item.review.id}`;
  }
  protected otherId(item: VendorReviewItem, other: PublicVendorResponse): string {
    return `vendor-review-other-${item.review.id}-${other.vendor_slug}`;
  }
  protected fieldId(item: VendorReviewItem): string {
    return `vendor-review-body-${item.review.id}`;
  }
  protected actionId(item: VendorReviewItem): string {
    return `vendor-review-action-${item.review.id}`;
  }
  protected withdrawStartId(item: VendorReviewItem): string {
    return `vendor-review-withdraw-start-${item.review.id}`;
  }
  protected withdrawConfirmId(item: VendorReviewItem): string {
    return `vendor-review-withdraw-${item.review.id}`;
  }

  // ─── List controls ──────────────────────────────────────────────────────

  protected applyFilter(value: string | null): void {
    if (this.compose() !== null) return;
    this.page.set(1);
    this.filter.set((value as ReviewReplyStatusFilter | null) ?? null);
  }

  protected goToPage(page: number): void {
    this.page.set(Math.min(Math.max(1, page), this.pageCount()));
  }

  protected reload(): void {
    void this.load({ quiet: this.response() !== null });
  }

  protected discardAndReload(): void {
    this.compose.set(null);
    this.stale.set(false);
    void this.load({ quiet: true });
  }

  // ─── Compose ────────────────────────────────────────────────────────────

  protected openCompose(item: VendorReviewItem, mode: ReviewComposeMode): void {
    if (!this.canReply()) return;
    this.rowError.set(null);
    this.formError.set(null);
    this.confirming.set(null);
    this.draft.set(mode === 'create' ? '' : (item.response?.body ?? ''));
    this.compose.set({ reviewId: item.review.id, mode });
    this.focusAfterRender(this.fieldId(item));
  }

  protected cancelCompose(item: VendorReviewItem): void {
    this.compose.set(null);
    this.formError.set(null);
    this.focusAfterRender(this.actionId(item));
    this.catchUp();
  }

  protected setDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    // Clear a stale validation message as soon as the text could be valid again.
    if (this.formError() && ReviewResponseBodySchema.safeParse({ body: this.draft() }).success) {
      this.formError.set(null);
    }
  }

  protected async save(item: VendorReviewItem): Promise<void> {
    const open = this.compose();
    if (!open || open.reviewId !== item.review.id || this.busy()) return;

    // Mirror the server's schema first: trimmed, 1 to 2,000 characters (§11c.5).
    const parsed = ReviewResponseBodySchema.safeParse({ body: this.draft() });
    if (!parsed.success) {
      const n = this.draft().trim().length;
      const max = REVIEW_RESPONSE_BODY_MAX;
      this.formError.set(
        n === 0
          ? $localize`:@@vendor.reviews.compose.error.empty:Write your reply before you send it.`
          : $localize`:@@vendor.reviews.compose.error.long:Your reply is ${n}:COUNT: characters. The limit is ${max}:MAX:.`,
      );
      this.focusAfterRender(this.fieldId(item));
      return;
    }
    const body = parsed.data.body;
    if (open.mode === 'edit' && body === item.response?.body) {
      this.formError.set(
        $localize`:@@vendor.reviews.error.noChange:The reply is the same as before, so nothing was saved. Change the text, or cancel.`,
      );
      return;
    }

    this.busy.set({ reviewId: item.review.id, action: 'save' });
    this.formError.set(null);
    this.rowError.set(null);
    try {
      const res =
        open.mode === 'edit'
          ? await this.api.editReviewResponse(item.review.id, body)
          : await this.api.submitReviewResponse(item.review.id, body);
      this.splice(item.review.id, res.response);
      this.compose.set(null);
      this.announcer.announce(
        $localize`:@@vendor.reviews.live.sent:Your reply was sent to AEC Integrations for approval. It shows on the product page once approved.`,
      );
      this.focusAfterRender(this.replyId(item));
      this.stale.set(false);
      void this.load({ quiet: true });
    } catch (err) {
      await this.failCompose(item, err);
    } finally {
      this.busy.set(null);
    }
  }

  private async failCompose(item: VendorReviewItem, err: unknown): Promise<void> {
    const message = reviewWriteErrorMessage(err);
    if (reviewWriteErrorReloads(err)) {
      // The row on screen is not the server's any more. Close the form, say why,
      // and show the state that won.
      this.compose.set(null);
      this.rowError.set({ id: item.review.id, message });
      await this.load({ quiet: true });
      this.focusAfterRender(this.replyId(item));
      return;
    }
    if (readVendorApiError(err)?.code === 'ENTITLEMENT_REQUIRED') {
      // The plan changed under the page. Refresh `me`, which moves the gate.
      this.compose.set(null);
      this.rowError.set({ id: item.review.id, message });
      void this.store.revalidate(['entitlement']);
      this.focusAfterRender(this.replyId(item));
      return;
    }
    this.formError.set(message);
  }

  // ─── Withdraw ───────────────────────────────────────────────────────────

  protected startWithdraw(item: VendorReviewItem): void {
    this.rowError.set(null);
    this.confirming.set(item.review.id);
    this.focusAfterRender(this.withdrawConfirmId(item));
  }

  protected cancelWithdraw(item: VendorReviewItem): void {
    this.confirming.set(null);
    this.focusAfterRender(this.withdrawStartId(item));
  }

  protected async withdraw(item: VendorReviewItem): Promise<void> {
    if (this.busy()) return;
    this.busy.set({ reviewId: item.review.id, action: 'withdraw' });
    this.rowError.set(null);
    try {
      const res = await this.api.withdrawReviewResponse(item.review.id);
      this.confirming.set(null);
      this.splice(item.review.id, res.response);
      this.announcer.announce(
        $localize`:@@vendor.reviews.live.withdrawn:Your reply was withdrawn. It is not on the product page.`,
      );
      this.focusAfterRender(this.replyId(item));
      void this.load({ quiet: true });
    } catch (err) {
      this.confirming.set(null);
      this.rowError.set({ id: item.review.id, message: reviewWriteErrorMessage(err) });
      if (reviewWriteErrorReloads(err)) await this.load({ quiet: true });
      this.focusAfterRender(this.replyId(item));
    } finally {
      this.busy.set(null);
    }
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  /** Put the write's echo, the committed row, in place. */
  private splice(reviewId: string, next: VendorReviewResponse): void {
    this.response.update((r) =>
      r
        ? {
            ...r,
            data: r.data.map((i) => (i.review.id === reviewId ? { ...i, response: next } : i)),
          }
        : r,
    );
  }

  private resetRowState(): void {
    this.compose.set(null);
    this.confirming.set(null);
    this.rowError.set(null);
    this.formError.set(null);
    this.stale.set(false);
    this.listAlert.set('');
    this.page.set(1);
  }

  private catchUp(): void {
    if (!this.stale()) return;
    this.stale.set(false);
    void this.load({ quiet: true });
  }

  private focusAfterRender(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }

  /**
   * Read the open page. `quiet` keeps the list on screen while it refreshes; a
   * first load shows the loading line instead. A newer read always wins.
   */
  private async load({ quiet }: { quiet: boolean }): Promise<void> {
    const productId = this.product().id;
    const ticket = ++this.ticket;
    if (quiet) this.refreshing.set(true);
    else {
      this.state.set('loading');
      this.response.set(null);
    }
    try {
      const res = await this.api.listReviews({
        page: this.page(),
        perPage: VENDOR_REVIEWS_PAGE_SIZE,
        productId,
        replyStatus: this.filter(),
      });
      if (ticket !== this.ticket) return;
      this.response.set(res);
      this.state.set('loaded');
      const last = Math.max(1, Math.ceil(res.total / res.perPage));
      if (this.page() > last) this.page.set(last);
    } catch {
      if (ticket !== this.ticket) return;
      this.state.set('failed');
    } finally {
      if (ticket === this.ticket) this.refreshing.set(false);
    }
  }

  protected pillClass(state: ReviewReplyState): string {
    const base =
      'inline-flex shrink-0 items-center rounded-(--radius-sm) border px-2 py-0.5 text-xs font-semibold tracking-[0.01em]';
    switch (state) {
      case 'published':
        return `${base} border-(--accent-primary) bg-(--surface-raised) text-(--accent-primary)`;
      case 'pending':
        return `${base} aec-pill-attention bg-(--surface-raised) text-(--text-primary)`;
      case 'rejected':
      case 'removed':
        return `${base} border-(--border-strong) bg-(--surface-raised) text-(--text-primary)`;
      default:
        return `${base} border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)`;
    }
  }

  protected readonly replyBlockClass =
    'ms-6 block space-y-2 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-sunken) p-4 sm:ms-10';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** Disabled is a surface swap, never opacity (DESIGN.md, AECI-982). */
  protected readonly primaryClass =
    'inline-flex min-h-10 items-center justify-center gap-1 rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
  protected readonly secondaryClass =
    'inline-flex min-h-10 items-center justify-center gap-1 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:bg-(--surface-sunken) disabled:text-(--text-secondary)';
}
