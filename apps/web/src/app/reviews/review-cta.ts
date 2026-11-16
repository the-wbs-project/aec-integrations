import {
  Component,
  ChangeDetectionStrategy,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { AccountApi } from '../account/account-api';
import { AuthService } from '../auth/auth.service';
import { AecButton } from '../shared/button/button';

type CtaState = 'neutral' | 'anon' | 'authed' | 'reviewed';

/**
 * AECI-201 / AECI-260 — the auth-aware "submit a review" CTA, built to stay
 * **edge-cache neutral** (§8). The product detail page is cacheable and keyed
 * only by URL, so its SSR HTML must be identical for every visitor. This
 * component therefore renders a single **non-personalized** default during
 * SSR/pre-hydration — "Write a review", linking to `/products/:slug/review`
 * (the route the SSR Worker 303-redirects anonymous visitors to login from, so
 * it is correct for everyone and works without JS) — and only **after
 * hydration** (`afterNextRender`, browser-only) reconciles to a personalized
 * label.
 *
 * Three personalized states resolve client-side:
 *   - `anon`     → "Sign in to review"            → `/auth/login?return=…/review`
 *   - `authed`   → "Submit a review"              → `/products/:slug/review`
 *   - `reviewed` → "You've already reviewed this" → link to `/account`
 *
 * `reviewed` (AECI-260, §5.5) is detected with a per-product lookup
 * (`AccountApi.findMyReviewForProduct`) — the data source AECI-225 unblocked.
 * It runs ONLY inside `afterNextRender` (browser-only), so the cached SSR HTML
 * never reflects a visitor's review state. A rejected review still counts as
 * "already reviewed" (it blocks re-submission; the reason lives on `/account`).
 * When auth is unconfigured or the probe fails the component degrades to its
 * neutral/`authed` default — the link still works and the residual
 * `REVIEW_DUPLICATE` 409 stays the backstop.
 */
@Component({
  selector: 'aec-review-cta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton, RouterLink],
  host: { class: 'inline-flex' },
  template: `
    @if (state() === 'reviewed') {
      <span
        class="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        [class]="onBrand() ? 'text-(--text-on-brand-secondary)' : 'text-(--text-secondary)'"
      >
        <span i18n="@@products.detail.reviews.cta.reviewed">You've already reviewed this</span>
        <a
          routerLink="/account"
          class="font-semibold underline-offset-2"
          [class]="reviewedLinkClass()"
          i18n="@@products.detail.reviews.cta.viewYourReview"
          >View your review</a
        >
      </span>
    } @else {
      <a
        aecButton
        [variant]="variant()"
        [routerLink]="linkCommands()"
        [queryParams]="queryParams()"
      >
        @switch (state()) {
          @case ('anon') {
            <span i18n="@@products.detail.reviews.cta.signIn">Sign in to review</span>
          }
          @case ('authed') {
            <span i18n="@@products.detail.reviews.cta.submit">Submit a review</span>
          }
          @default {
            <span i18n="@@products.detail.reviews.cta.neutral">Write a review</span>
          }
        }
      </a>
    }
  `,
})
export class ReviewCta {
  private readonly auth = inject(AuthService);
  private readonly account = inject(AccountApi);

  readonly slug = input.required<string>();
  /** The product's UUID — used only for the browser-side "already reviewed"
   *  lookup after hydration (never read during SSR). */
  readonly productId = input.required<string>();
  /**
   * Visual weight of the CTA button. `secondary` (default) is the raised, bordered
   * button: the product page already has "Visit website" as its one filled button
   * (DESIGN.md §5, one filled button per surface), so neither "Write a review"
   * placement is filled. `primary` stays available to a caller with no other
   * filled button. `on-brand-secondary` is the second action on a Forest ground, the
   * product hero (AECI-1778). There the `reviewed` text state also takes on-brand
   * colours: Bone-secondary text, a Bone link with a permanent underline and the Bone
   * ring, so it stays readable after hydration.
   */
  readonly variant = input<'primary' | 'secondary' | 'on-brand-secondary'>('secondary');

  protected readonly onBrand = computed(() => this.variant() === 'on-brand-secondary');

  protected readonly reviewedLinkClass = computed(() =>
    this.onBrand()
      ? 'text-(--text-on-brand) underline hover:text-(--text-on-brand) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--focus-ring-on-brand)'
      : 'text-(--accent-primary) hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)',
  );

  protected readonly state = signal<CtaState>('neutral');

  /** Absolute path to the (auth-gated) review form for this product. */
  protected readonly reviewPath = computed(() => `/products/${this.slug()}/review`);

  protected readonly linkCommands = computed(() =>
    this.state() === 'anon' ? ['/auth/login'] : ['/products', this.slug(), 'review'],
  );

  protected readonly queryParams = computed(() =>
    this.state() === 'anon' ? { return: this.reviewPath() } : {},
  );

  constructor() {
    // `afterNextRender` runs only in the browser, never during SSR — so the
    // session read + per-product lookup can never poison the cached HTML. The
    // callback stays synchronous (the async probe is dispatched via `void`) so
    // it matches the `() => void` signature without tripping no-misused-promises.
    afterNextRender(() => void this.reconcile());
  }

  private async reconcile(): Promise<void> {
    if (!this.auth.isConfigured()) return; // stay neutral
    try {
      if (!(await this.auth.isSignedIn())) {
        this.state.set('anon');
        return;
      }
      // Signed in: a per-product lookup decides between "submit" and "already
      // reviewed". Resolving the state in a single `set` (rather than authed →
      // reviewed) avoids a "Submit a review" flicker while the lookup is in
      // flight. A lookup throw falls through to the neutral default below — a
      // still-working "Write a review" link, with the 409 as the backstop.
      const existing = await this.account.findMyReviewForProduct(this.productId());
      this.state.set(existing ? 'reviewed' : 'authed');
    } catch {
      // Any probe failure → keep the neutral default; the link still works.
    }
  }
}
