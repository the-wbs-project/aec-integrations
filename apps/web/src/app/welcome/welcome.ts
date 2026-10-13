import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';

import { Analytics } from '../analytics/analytics';
import { AccountApi } from '../account/account-api';
import { ProfileDetailsForm } from '../account/profile-details/profile-details-form';
import {
  EMPTY_DRAFT,
  draftFromDetails,
  draftToPatch,
  linkedInInvalid,
  type ProfileDetailsDraft,
} from '../account/profile-details/profile-details-model';
import { safeReturnPath } from '../auth/return-path';
import {
  BUTTON_PRIMARY_CLASS,
  BUTTON_SECONDARY_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FORM_FOOTER_CLASS,
} from '../shared/form-field/form-field-classes';

/** Display name bounds. Mirror `UpdateAccountSchema.display_name`. */
const DISPLAY_NAME_MAX = 80;

/**
 * Where `/welcome` sends the user afterwards: the `?next=` path, narrowed to a
 * same-origin path. A `next` that points back at `/welcome` collapses to `/`,
 * so the page can never loop on itself.
 */
export function welcomeNextPath(raw: string | null): string {
  const path = safeReturnPath(raw);
  return /^\/welcome(?:[/?#]|$)/.test(path) ? '/' : path;
}

/**
 * `/welcome` (AECI-1296, `docs/ACCOUNT_ONBOARDING_SPEC.md`): the one-screen
 * "About you" form a first sign-in lands on. `/auth/callback` sends a user here
 * only when the profile-ensure just created their profile.
 *
 * Only the display name is required, and "Skip for now" is always there. Save
 * records `onboarding: 'completed'`, skip records `'skipped'`; both then go to
 * `next`. A user who is not `pending` (they answered, or skipped, on another
 * tab) goes straight to `next` without seeing the form.
 *
 * Auth and caching: the SSR Worker bounces a signed-out visitor to login
 * (`isWelcomePath`), and the route is `no-store` by the fail-closed classifier.
 * SSR paints the loading state only. The account read, and so every answer and
 * the suggested Google name, loads in the browser after hydration.
 */
@Component({
  selector: 'aec-welcome-page',
  imports: [ProfileDetailsForm],
  template: `
    <section
      class="mx-auto w-full max-w-2xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="welcome-title"
    >
      <p
        class="text-xs tracking-[0.14em] text-(--text-secondary) uppercase"
        i18n="@@welcome.eyebrow"
      >
        Welcome
      </p>
      <h1
        id="welcome-title"
        class="mt-3 font-display text-3xl font-semibold tracking-tight md:text-4xl"
        i18n="@@welcome.title"
      >
        Tell us about yourself
      </h1>
      <p
        class="mt-4 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@welcome.lede"
      >
        It takes a minute. Your answers fill in your reviews for you, and you can change them any
        time on your account page.
      </p>

      @if (loading()) {
        <p class="mt-8 text-sm text-(--text-secondary)" i18n="@@welcome.loading">Loading…</p>
      } @else if (loadFailed()) {
        <div class="mt-8 space-y-3">
          <p
            class="text-sm font-medium text-(--text-primary)"
            role="alert"
            i18n="@@welcome.loadFailed"
          >
            We couldn't load your account. You can fill this in later from your account page.
          </p>
          <button
            type="button"
            (click)="leave()"
            [class]="secondaryClass"
            i18n="@@welcome.continue"
          >
            Continue
          </button>
        </div>
      } @else {
        <form
          class="mt-10 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
          novalidate
          (submit)="$event.preventDefault(); onSave()"
        >
          <div class="space-y-6 p-6 sm:p-8">
            <div class="space-y-1.5">
              <label
                for="welcome-display-name"
                [class]="labelClass"
                i18n="@@welcome.displayName.label"
              >
                Display name
              </label>
              <input
                id="welcome-display-name"
                type="text"
                autocomplete="nickname"
                required
                [attr.maxlength]="displayNameMax"
                [value]="displayName()"
                (input)="onDisplayName($event)"
                (blur)="nameTouched.set(true)"
                [attr.aria-invalid]="showNameError() ? 'true' : null"
                [attr.aria-describedby]="
                  showNameError()
                    ? 'welcome-display-name-hint welcome-display-name-error'
                    : 'welcome-display-name-hint'
                "
                [class]="inputClass"
              />
              <p
                id="welcome-display-name-hint"
                [class]="hintClass"
                i18n="@@welcome.displayName.hint"
              >
                Shown on the reviews you publish.
              </p>
              @if (showNameError()) {
                <p
                  id="welcome-display-name-error"
                  [class]="errorClass"
                  role="alert"
                  i18n="@@welcome.displayName.error"
                >
                  Enter a display name between 1 and 80 characters.
                </p>
              }
            </div>

            <aec-profile-details-form idPrefix="welcome" [(draft)]="draft" />

            @if (saveFailed()) {
              <p
                class="text-sm font-medium text-(--text-primary)"
                role="alert"
                i18n="@@welcome.saveFailed"
              >
                Something went wrong. Please try again.
              </p>
            }
          </div>

          <div class="px-6 py-4 sm:px-8" [class]="footerClass">
            <button
              type="button"
              (click)="onSkip()"
              [disabled]="saving()"
              data-testid="welcome-skip"
              [class]="secondaryClass + ' me-auto disabled:cursor-not-allowed disabled:opacity-50'"
              i18n="@@welcome.skip"
            >
              Skip for now
            </button>
            <button type="submit" [disabled]="!canSave()" [class]="primaryClass">
              @if (saving()) {
                <span i18n="@@welcome.saving">Saving…</span>
              } @else {
                <span i18n="@@welcome.save">Save and continue</span>
              }
            </button>
          </div>
        </form>
      }
    </section>
  `,
})
export class WelcomePage {
  private readonly api = inject(AccountApi);
  private readonly analytics = inject(Analytics);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  /** Where the user goes after saving or skipping. */
  protected readonly next = welcomeNextPath(this.route.snapshot.queryParamMap.get('next'));
  protected readonly displayNameMax = DISPLAY_NAME_MAX;

  // The claim dialog's field and button recipe (`shared/form-field/form-field-classes.ts`).
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly primaryClass = BUTTON_PRIMARY_CLASS;
  protected readonly secondaryClass = BUTTON_SECONDARY_CLASS;
  protected readonly footerClass = FORM_FOOTER_CLASS;

  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveFailed = signal(false);

  protected readonly displayName = signal('');
  protected readonly nameTouched = signal(false);
  protected readonly draft = signal<ProfileDetailsDraft>(EMPTY_DRAFT);

  private readonly nameValid = computed(() => {
    const name = this.displayName().trim();
    return name.length >= 1 && name.length <= DISPLAY_NAME_MAX;
  });
  protected readonly showNameError = computed(() => this.nameTouched() && !this.nameValid());
  protected readonly canSave = computed(
    () => this.nameValid() && !linkedInInvalid(this.draft()) && !this.saving(),
  );

  constructor() {
    this.titleSvc.setTitle($localize`:@@welcome.metaTitle:Welcome · AEC Integrations`);
    // User-specific utility page. Never indexed.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    afterNextRender(() => void this.load());
  }

  private async load(): Promise<void> {
    let profile;
    try {
      profile = await this.api.getProfile();
    } catch {
      this.loadFailed.set(true);
      this.loading.set(false);
      return;
    }
    // Already answered or skipped (another tab, a re-used link), or an older
    // API that does not report the state: do not ask again. The loading state
    // stays up, so the form never flashes on the way out.
    if (profile.onboarding !== 'pending') {
      await this.leave();
      return;
    }
    this.displayName.set(profile.display_name ?? profile.suggested_display_name ?? '');
    this.draft.set(draftFromDetails(profile.details));
    this.loading.set(false);
  }

  protected onDisplayName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  protected async onSave(): Promise<void> {
    this.nameTouched.set(true);
    if (!this.canSave()) return;
    this.saving.set(true);
    this.saveFailed.set(false);
    const patch = draftToPatch(this.draft());
    try {
      await this.api.updateProfile({
        display_name: this.displayName().trim(),
        ...patch,
        onboarding: 'completed',
      });
    } catch {
      this.saving.set(false);
      this.saveFailed.set(true);
      return;
    }
    this.analytics.onboardingCompleted({
      source: 'welcome',
      company_type: patch.company_type ?? null,
      company_size: patch.company_size ?? null,
      primary_role: patch.primary_role ?? null,
      audience_count: patch.audience_ids?.length ?? 0,
    });
    await this.leave();
  }

  /**
   * Record the skip, then leave. A failed write still leaves: skipping must
   * never trap the user here, and the `/account` card asks again later.
   */
  protected async onSkip(): Promise<void> {
    this.saving.set(true);
    try {
      await this.api.updateProfile({ onboarding: 'skipped' });
      this.analytics.onboardingSkipped({
        source: 'welcome',
        company_type: null,
        company_size: null,
        primary_role: null,
        audience_count: 0,
      });
    } catch {
      // Leave anyway. See above.
    }
    await this.leave();
  }

  /** Go to `next`. A refused client navigation falls back to a full load. */
  protected async leave(): Promise<void> {
    if (await this.router.navigateByUrl(this.next)) return;
    globalThis.location.assign(this.next);
  }
}
