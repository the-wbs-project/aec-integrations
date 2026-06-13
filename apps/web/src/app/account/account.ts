import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
  BrnDialogTrigger,
} from '@spartan-ng/brain/dialog';

import { UpdateAccountSchema, type AccountProfileResponse, type AccountReview } from '@aeci/shared';

import { AuthService } from '../auth/auth.service';
import { AccountApi } from './account-api';
import { ReviewStatusBadge } from './review-status-badge';

/** Page size for the own-reviews list — matches the API default `perPage`. */
const REVIEWS_PER_PAGE = 24;

/**
 * `/account` (AECI-202 / Phase 5.11) — the signed-in user's account surface:
 * identity (email read-only from the session, editable display name), the
 * user's own reviews list (all statuses, AECI-225), sign-out, and the GDPR
 * **delete account** flow (a confirmation dialog).
 *
 * Auth + cacheability: the SSR Worker 303s an unauthenticated visitor to
 * `/auth/login?return=/account` before this ever renders, and `/account` is
 * non-cacheable by the fail-closed default (`server-runtime.ts`). So SSR paints
 * the shell and the browser fetches identity in `afterNextRender` (mirroring
 * `LoginPage`) — the same-origin `/api/account` reads carry the session cookie,
 * which the API Worker's `requireAuth()` verifies. The own-reviews list
 * (`GET /api/account/reviews`, all statuses, AECI-225) loads the same
 * browser-only way, in parallel with identity.
 *
 * i18n / a11y: all copy is `i18n`/`$localize`; the delete confirmation uses
 * Spartan `BrnDialog` (focus trap + Escape + focus return).
 */
@Component({
  selector: 'aec-account-page',
  imports: [
    DatePipe,
    FormField,
    RouterLink,
    ReviewStatusBadge,
    BrnDialog,
    BrnDialogClose,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    BrnDialogTrigger,
  ],
  templateUrl: './account.html',
})
export class AccountPage {
  private readonly api = inject(AccountApi);
  private readonly auth = inject(AuthService);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  /** The fetched identity; null until the browser load resolves. */
  protected readonly profile = signal<AccountProfileResponse | null>(null);

  /** True while the initial identity fetch is in flight (browser only). */
  protected readonly loading = signal(true);

  /** True when the identity fetch failed (e.g. an expired session → 401). */
  protected readonly loadFailed = signal(false);

  /** Display-name save feedback. */
  protected readonly saved = signal(false);
  protected readonly saveFailed = signal(false);

  /** Delete-account flow state. */
  protected readonly deleting = signal(false);
  protected readonly deleteFailed = signal(false);

  /** Sign-out failure (rare; surfaced as a retryable notice). */
  protected readonly signOutFailed = signal(false);

  /** The caller's own reviews (all statuses), accumulated across pages. */
  protected readonly reviews = signal<readonly AccountReview[]>([]);
  /** Total matching reviews server-side — drives the "Load more" gate. */
  private readonly reviewsTotal = signal(0);
  /** The highest page number loaded so far (0 = none yet). */
  private readonly reviewsPage = signal(0);

  /** True while the initial reviews fetch is in flight (browser only). */
  protected readonly reviewsLoading = signal(true);
  /** True when the initial reviews fetch failed. */
  protected readonly reviewsFailed = signal(false);
  /** "Load more" in-flight / failed state (distinct from the initial load). */
  protected readonly loadingMoreReviews = signal(false);
  protected readonly loadMoreFailed = signal(false);

  /** No reviews to show once the initial load has settled successfully. */
  protected readonly reviewsEmpty = computed(
    () => !this.reviewsLoading() && !this.reviewsFailed() && this.reviews().length === 0,
  );
  /** More pages remain beyond what's currently displayed. */
  protected readonly hasMoreReviews = computed(() => this.reviews().length < this.reviewsTotal());

  private readonly model = signal<{ display_name: string }>({ display_name: '' });

  protected readonly form = form(this.model, (p) => {
    validateStandardSchema(p, UpdateAccountSchema);
  });

  constructor() {
    this.titleSvc.setTitle($localize`:@@account.metaTitle:Your account · AEC Integrations`);
    // User-specific utility page — never indexed.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });

    // Browser-only: load identity + own reviews after hydration. During SSR the
    // shell paints the loading state; the page is auth-gated so a cookie is
    // always present. The two fetches are independent and run in parallel.
    afterNextRender(() => {
      void this.load();
      void this.loadReviews();
    });
  }

  private async load(): Promise<void> {
    this.loadFailed.set(false);
    try {
      const profile = await this.api.getProfile();
      this.profile.set(profile);
      this.model.set({ display_name: profile.display_name ?? '' });
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private async loadReviews(): Promise<void> {
    this.reviewsFailed.set(false);
    try {
      const res = await this.api.listReviews({ page: 1, perPage: REVIEWS_PER_PAGE });
      this.reviews.set(res.data);
      this.reviewsTotal.set(res.total);
      this.reviewsPage.set(1);
    } catch {
      this.reviewsFailed.set(true);
    } finally {
      this.reviewsLoading.set(false);
    }
  }

  /** Append the next page of reviews. Imperative browser fetch on click. */
  protected async loadMoreReviews(): Promise<void> {
    if (this.loadingMoreReviews()) return;
    this.loadingMoreReviews.set(true);
    this.loadMoreFailed.set(false);
    const page = this.reviewsPage() + 1;
    try {
      const res = await this.api.listReviews({ page, perPage: REVIEWS_PER_PAGE });
      this.reviews.update((cur) => [...cur, ...res.data]);
      this.reviewsTotal.set(res.total);
      this.reviewsPage.set(page);
    } catch {
      this.loadMoreFailed.set(true);
    } finally {
      this.loadingMoreReviews.set(false);
    }
  }

  protected async onSaveName(): Promise<void> {
    this.saved.set(false);
    this.saveFailed.set(false);
    await submit(this.form, async (f) => {
      const displayName = f().value().display_name.trim();
      try {
        const updated = await this.api.updateProfile({ display_name: displayName });
        this.profile.set(updated);
        this.model.set({ display_name: updated.display_name ?? '' });
        this.saved.set(true);
      } catch {
        // Notice, not a form error — keep the button enabled so the user can retry.
        this.saveFailed.set(true);
      }
      return undefined;
    });
  }

  protected async onSignOut(): Promise<void> {
    this.signOutFailed.set(false);
    try {
      await this.auth.signOut();
    } catch {
      this.signOutFailed.set(true);
      return;
    }
    this.redirectHome();
  }

  /** Confirmed from the dialog. Deletes the account, signs out, redirects home. */
  protected async onConfirmDelete(): Promise<void> {
    this.deleting.set(true);
    this.deleteFailed.set(false);
    try {
      await this.api.deleteAccount();
    } catch {
      this.deleting.set(false);
      this.deleteFailed.set(true);
      return;
    }
    // Best-effort: clear the now-stale session, then leave for home. A signOut
    // failure here must NOT block the redirect — the account is already gone and
    // the API 401s the orphaned JWT.
    try {
      await this.auth.signOut();
    } catch {
      /* ignore — the account is deleted; redirect regardless */
    }
    this.redirectHome();
  }

  private redirectHome(): void {
    globalThis.location.assign('/');
  }
}
