import { Component, computed, inject, signal } from '@angular/core';
import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';

import {
  SubmitReviewSchema,
  type ProductDetail,
  type SubmitReviewInput,
  type SubmitReviewResponse,
} from '@aeci/shared';

import { NotFound } from '../not-found/not-found';

import { ReviewsApi } from './reviews-api';

type RoleValue = NonNullable<SubmitReviewInput['role_at_company']>;
type RecommendValue = NonNullable<SubmitReviewInput['would_recommend']>;

/** A discrete option for the Aria listbox / combobox controls. */
interface Choice<V> {
  readonly value: V;
  readonly label: string;
}

/**
 * The Signal Forms model holds only the REQUIRED review fields. The two ratings
 * seed `0` — an out-of-range value (schema min is 1) that keeps the form invalid
 * (submit disabled) until a star is picked. The optional fields (role, years,
 * recommend) are NOT in this model: Signal Forms doesn't materialise a field
 * node for a property seeded `undefined`, and seeding a sentinel can't be told
 * apart from a real choice — so they're held as standalone signals and merged
 * into the payload at submit (see `buildInput`). Server-set columns
 * (`reviewer_id`, `status`, `locale`) are absent by design
 * (`packages/shared/src/api/reviews.ts`).
 */
interface ReviewModel {
  product_id: string;
  rating_overall: number;
  rating_onboarding: number;
  title: string;
  body: string;
}

/**
 * AECI-200 — the authenticated review-submission form at
 * `/products/:slug/review` (Phase 5.9). The dual-review model: an overall
 * rating + an onboarding rating, a title/body, and optional role-at-company,
 * years-using, and would-recommend. The route is gated SSR-side
 * (`server-runtime.ts` redirects unauthenticated visitors to `/auth/login`);
 * the API (`POST /api/reviews`, AECI-197) is the real enforcement point.
 *
 * This is also the app's **first Angular Aria form** (ADR 0010 / satisfies
 * AECI-133). `@angular/aria@22` GA ships no `radio` and no `select` primitive,
 * so — as recorded on AECI-200 — the discrete-choice controls are built on the
 * primitives that DID ship:
 *   - star ratings (overall + onboarding) and would-recommend → single-select
 *     horizontal `ngListbox` (`role=listbox`/`option`), roving tabindex +
 *     arrow-key keyboard, axe-clean;
 *   - role-at-company → non-editable `ngCombobox` + `ngListbox` popup, mirroring
 *     `search/search-autocomplete.ts` (the first Aria combobox adoption).
 *
 * Bridging: Aria `Listbox`/`Combobox` expose `value` as a `ModelSignal<V[]>`
 * (always an array, even single-select). The two required ratings are bridged
 * into the Signal Form: a local `signal<number[]>` two-way-bound via `[(value)]`
 * (drives the `aria-selected` highlight + roving state) plus a `(valueChange)`
 * handler that writes `values[0]` into the form field and marks it touched. The
 * native `title`/`body` fields bind with `[formField]` directly, exactly like
 * `requests/request-form`. The optional controls just read their own signals.
 *
 * Validation is the shared `SubmitReviewSchema` via `validateStandardSchema`
 * (ADR 0009) — the single source of truth (client + server). The Zod messages
 * are never rendered; the template owns user-facing copy via `$localize`, keyed
 * off field validity (Zod = logic, `$localize` = presentation).
 */
@Component({
  selector: 'aec-review-form',
  imports: [
    FormField,
    Listbox,
    Option,
    Combobox,
    ComboboxPopup,
    ComboboxWidget,
    OverlayModule,
    RouterLink,
    NotFound,
  ],
  templateUrl: './review-form.html',
})
export class ReviewForm {
  private readonly route = inject(ActivatedRoute);
  private readonly api = inject(ReviewsApi);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  /** The resolved product (or `null` → render the shared 404 shell). The
   *  resolver ran before this component, so the snapshot is populated. */
  protected readonly product = this.route.snapshot.data['product'] as ProductDetail | null;

  protected readonly backRouterLink = computed(() => ['/products', this.product?.slug ?? '']);

  /** Set to the API response on a successful submit; flips to the confirmation. */
  protected readonly submitted = signal<SubmitReviewResponse | null>(null);

  /** True when the last submit attempt failed (network / 401 expired-session /
   *  server error). Surfaced as a non-blocking notice so the user can retry. */
  protected readonly submitFailed = signal(false);

  // ── Aria control bridge / state signals (value is always an array) ────────
  /** Selected overall-rating star (bridged into the form). */
  protected readonly overallSel = signal<number[]>([]);
  /** Selected onboarding-rating star (bridged into the form). */
  protected readonly onboardingSel = signal<number[]>([]);
  /** Selected role option (optional; read at submit). */
  protected readonly roleSel = signal<Choice<RoleValue>[]>([]);
  /** Selected would-recommend option (optional; read at submit). */
  protected readonly recommendSel = signal<Choice<RecommendValue>[]>([]);
  /** Role combobox open state (two-way with `ngCombobox`). */
  protected readonly roleExpanded = signal(false);

  /** Raw years-using input (optional). Held as a string and parsed at submit. */
  protected readonly yearsUsing = signal('');
  /** Whether the years field has been blurred (gates its error display). */
  protected readonly yearsTouched = signal(false);

  protected readonly stars: readonly number[] = [1, 2, 3, 4, 5];

  protected readonly roleOptions: ReadonlyArray<Choice<RoleValue>> = [
    { value: 'practitioner', label: $localize`:@@reviews.role.practitioner:Practitioner` },
    { value: 'manager', label: $localize`:@@reviews.role.manager:Manager` },
    { value: 'IT', label: $localize`:@@reviews.role.IT:IT` },
    { value: 'exec', label: $localize`:@@reviews.role.exec:Executive` },
    { value: 'other', label: $localize`:@@reviews.role.other:Other` },
  ];

  protected readonly recommendOptions: ReadonlyArray<Choice<RecommendValue>> = [
    { value: 'yes', label: $localize`:@@reviews.recommend.yes:Yes` },
    { value: 'no', label: $localize`:@@reviews.recommend.no:No` },
    { value: 'maybe', label: $localize`:@@reviews.recommend.maybe:Maybe` },
  ];

  private readonly rolePlaceholder = $localize`:@@reviews.role.placeholder:Select a role`;
  /** Label shown in the combobox trigger — the chosen role or the placeholder. */
  protected readonly roleTriggerLabel = computed(
    () => this.roleSel()[0]?.label ?? this.rolePlaceholder,
  );

  /** True when a years value is present but not a whole number in [0, 50]. An
   *  empty field is valid (the field is optional). Gates the submit button. */
  protected readonly yearsInvalid = computed(() => this.parseYears() === 'invalid');

  private readonly model = signal<ReviewModel>({
    product_id: this.product?.id ?? '',
    rating_overall: 0,
    rating_onboarding: 0,
    title: '',
    body: '',
  });

  protected readonly form = form(this.model, (p) => validateStandardSchema(p, SubmitReviewSchema));

  /** Submit is blocked while the form is invalid/pending/submitting OR the
   *  optional years field holds an invalid value. */
  protected readonly submitDisabled = computed(
    () =>
      this.form().invalid() ||
      this.form().pending() ||
      this.form().submitting() ||
      this.yearsInvalid(),
  );

  constructor() {
    this.titleSvc.setTitle(this.metaTitle());
    // Utility write surface — keep it out of the index (mirrors request-form).
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
  }

  // ── Bridge handlers: write the chosen rating into the Signal Forms field ───
  protected onOverallChange(values: number[]): void {
    const v = values[0];
    if (v === undefined) return;
    this.form.rating_overall().value.set(v);
    this.form.rating_overall().markAsTouched();
  }

  protected onOnboardingChange(values: number[]): void {
    const v = values[0];
    if (v === undefined) return;
    this.form.rating_onboarding().value.set(v);
    this.form.rating_onboarding().markAsTouched();
  }

  /** Committing a role closes the popup (custom-select semantics). The value
   *  lives in `roleSel`; nothing to write into the form (optional field). */
  protected onRoleChange(): void {
    this.roleExpanded.set(false);
  }

  protected onYearsInput(event: Event): void {
    this.yearsUsing.set((event.target as HTMLInputElement).value);
  }

  /** Parse the years field: `undefined` (empty), a number, or `'invalid'`. */
  private parseYears(): number | undefined | 'invalid' {
    const raw = this.yearsUsing().trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 50) return 'invalid';
    return n;
  }

  protected async onSubmit(): Promise<void> {
    this.submitFailed.set(false);
    await submit(this.form, async (f) => {
      try {
        this.submitted.set(await this.api.submitReview(this.buildInput(f().value())));
      } catch {
        // Surface as a retryable notice, not a form error — a `ValidationError`
        // here would mark the form invalid and disable submit (mirrors
        // request-form). Covers a 401 from an expired session cookie too.
        this.submitFailed.set(true);
      }
      return undefined;
    });
  }

  /** Merge the required form value with the optional control signals. */
  private buildInput(v: ReviewModel): SubmitReviewInput {
    const role = this.roleSel()[0]?.value;
    const recommend = this.recommendSel()[0]?.value;
    const years = this.parseYears();
    return {
      product_id: v.product_id,
      rating_overall: v.rating_overall,
      rating_onboarding: v.rating_onboarding,
      title: v.title,
      body: v.body,
      ...(role ? { role_at_company: role } : {}),
      ...(typeof years === 'number' ? { years_using: years } : {}),
      ...(recommend ? { would_recommend: recommend } : {}),
    };
  }

  /** Accessible name for a star option (e.g. "1 star" / "4 stars"). Built in TS
   *  because the value is dynamic — template `i18n` attrs must be static. */
  protected starLabel(n: number): string {
    return n === 1
      ? $localize`:@@reviews.rating.star.one:1 star`
      : $localize`:@@reviews.rating.star.other:${n}:count: stars`;
  }

  private metaTitle(): string {
    const name = this.product?.name;
    return name
      ? $localize`:@@reviews.metaTitle:Review ${name}:productName: · AEC Integrations`
      : $localize`:@@reviews.metaTitle.fallback:Write a review · AEC Integrations`;
  }
}
