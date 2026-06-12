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

import { AuthService } from '../auth/auth.service';

type CtaState = 'neutral' | 'anon' | 'authed';

/**
 * AECI-201 — the auth-aware "submit a review" CTA, built to stay
 * **edge-cache neutral** (§8). The product detail page is cacheable and keyed
 * only by URL, so its SSR HTML must be identical for every visitor. This
 * component therefore renders a single **non-personalized** default during
 * SSR/pre-hydration — "Write a review", linking to `/products/:slug/review`
 * (the route the SSR Worker 303-redirects anonymous visitors to login from, so
 * it is correct for everyone and works without JS) — and only **after
 * hydration** (`afterNextRender`, browser-only) reconciles to a personalized
 * label.
 *
 * Two personalized states ship now:
 *   - `anon`   → "Sign in to review" → `/auth/login?return=/products/:slug/review`
 *   - `authed` → "Submit a review"   → `/products/:slug/review`
 *
 * The third state ("You've already reviewed this") is deferred to Phase 5.11:
 * detecting it needs a per-user review lookup that has no API yet. Duplicates
 * stay hard-blocked at submit (`REVIEW_DUPLICATE` + the DB partial-unique
 * index), so nothing is lost. When auth is unconfigured the component stays on
 * its neutral default (graceful degradation, mirroring `AuthService`).
 */
@Component({
  selector: 'aec-review-cta',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  host: { class: 'inline-flex' },
  template: `
    <a
      [routerLink]="linkCommands()"
      [queryParams]="queryParams()"
      class="inline-flex items-center justify-center rounded-(--radius-md)
        border border-(--border-strong) bg-(--accent-primary) px-4 py-2
        text-sm font-bold text-(--surface-base) no-underline transition-colors
        hover:bg-(--accent-primary-hover) focus-visible:outline-none
        focus-visible:ring-2 focus-visible:ring-(--accent-primary)
        focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
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
  `,
})
export class ReviewCta {
  private readonly auth = inject(AuthService);

  readonly slug = input.required<string>();

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
    // session read can never poison the cached HTML. The callback stays
    // synchronous (the async probe is dispatched via `void`) so it matches the
    // `() => void` signature without tripping no-misused-promises.
    afterNextRender(() => void this.reconcile());
  }

  private async reconcile(): Promise<void> {
    if (!this.auth.isConfigured()) return; // stay neutral
    try {
      this.state.set((await this.auth.isSignedIn()) ? 'authed' : 'anon');
    } catch {
      // Any probe failure → keep the neutral default; the link still works.
    }
  }
}
