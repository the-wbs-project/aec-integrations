import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
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
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FORM_FOOTER_CLASS,
} from '../shared/form-field/form-field-classes';

/** Display name bounds. Mirror `UpdateAccountSchema.display_name`. */
const DISPLAY_NAME_MAX = 80;

/** How `WelcomePage.leave()` went. */
type LeaveResult = 'client' | 'hard' | 'failed';

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
 * records `onboarding: 'completed'`, skip records `'skipped'`. Both then go to
 * `next`, falling back to a full page load when the client navigation fails, so
 * the user is never trapped here. A user who is not `pending` (they answered,
 * or skipped, on another tab) goes straight to `next` without seeing the form.
 *
 * Save is never disabled except while saving, so Enter in any field submits.
 * An invalid name or LinkedIn link shows its error and takes focus instead.
 *
 * One polite live region sits in the SSR shell and stays for the page's life.
 * It announces the loading state, the form appearing (focus also moves to the
 * `h1`), the fields a software company is not asked, and audience count changes.
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
    <!-- AECI-987: the 7xl canvas with the form + context rail. From lg the header
         and the form sit in columns 1 to 7 and the rail docks in 9 to 12. Below lg
         the source order (header, rail, form) is the reading order. -->
    <section
      class="mx-auto w-full max-w-7xl px-6 py-8 text-(--text-primary) md:px-8 md:py-12"
      aria-labelledby="welcome-title"
      data-testid="page-canvas"
    >
      <div class="lg:grid lg:grid-cols-12 lg:gap-x-12">
        <div class="min-w-0 lg:col-span-7 lg:col-start-1 lg:row-start-1">
          <p
            class="text-xs tracking-[0.14em] text-(--text-secondary) uppercase"
            i18n="@@welcome.eyebrow"
          >
            Welcome
          </p>
          <h1
            #title
            id="welcome-title"
            tabindex="-1"
            class="mt-3 font-display text-3xl font-semibold tracking-tight focus:outline-none md:text-4xl"
            i18n="@@welcome.title"
          >
            Tell us about yourself
          </h1>
          <p
            class="mt-4 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@welcome.lede"
          >
            A few questions about where you work. Reviewers get their review forms filled in from
            this. You can change any of it on your account page.
          </p>
        </div>

        <!-- Static copy only. Sticky on the grid child, whose area spans both rows. -->
        <aside
          class="mt-8 min-w-0 rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-5 lg:sticky lg:top-8 lg:col-span-4 lg:col-start-9 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-start lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
          aria-labelledby="welcome-rail-heading"
          data-testid="context-rail"
        >
          <h2
            id="welcome-rail-heading"
            class="aec-overline text-(--text-secondary)"
            i18n="@@welcome.rail.heading"
          >
            Where your answers go
          </h2>
          <ul
            class="mt-2 list-disc space-y-1.5 ps-5 text-sm leading-relaxed text-(--text-secondary)"
          >
            <li i18n="@@welcome.rail.prefill">
              Your role and firm fill in your review forms. You can still change them on each
              review.
            </li>
            <li i18n="@@welcome.rail.private">They stay private. No public page shows them.</li>
            <li i18n="@@welcome.rail.edit">
              You can change or clear any answer later on your account page.
            </li>
          </ul>
        </aside>

        <div class="min-w-0 max-w-2xl lg:col-span-7 lg:col-start-1 lg:row-start-2">
          <!-- The page's one polite live region. Rendered by SSR and never removed,
           so a screen reader is already watching it when the first message lands. -->
          <p class="sr-only" role="status" aria-live="polite" data-testid="welcome-status">
            {{ status() }}
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
                    #nameInput
                    id="welcome-display-name"
                    type="text"
                    autocomplete="nickname"
                    required
                    [attr.maxlength]="displayNameMax"
                    [value]="displayName()"
                    (input)="onDisplayName($event)"
                    (blur)="nameTouched.set(true)"
                    [attr.aria-invalid]="showNameError() ? 'true' : null"
                    [attr.aria-describedby]="showNameError() ? 'welcome-display-name-error' : null"
                    [class]="inputClass"
                  />
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

                <aec-profile-details-form
                  idPrefix="welcome"
                  [(draft)]="draft"
                  (announce)="status.set($event)"
                />

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
                  [class]="
                    secondaryClass + ' sm:me-auto disabled:cursor-not-allowed disabled:opacity-50'
                  "
                  i18n="@@welcome.skip"
                >
                  Skip for now
                </button>
                <button
                  type="submit"
                  [disabled]="saving()"
                  data-testid="welcome-save"
                  [class]="primaryClass"
                >
                  @if (saving()) {
                    <span i18n="@@welcome.saving">Saving…</span>
                  } @else {
                    <span i18n="@@welcome.save">Save and continue</span>
                  }
                </button>
              </div>
            </form>
          }
        </div>
      </div>
    </section>
  `,
})
export class WelcomePage {
  private readonly api = inject(AccountApi);
  private readonly injector = inject(Injector);
  private readonly analytics = inject(Analytics);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  private readonly titleEl = viewChild<ElementRef<HTMLElement>>('title');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly detailsForm = viewChild(ProfileDetailsForm);

  /** Where the user goes after saving or skipping. */
  protected readonly next = welcomeNextPath(this.route.snapshot.queryParamMap.get('next'));
  protected readonly displayNameMax = DISPLAY_NAME_MAX;

  // The claim dialog's field and button recipe (`shared/form-field/form-field-classes.ts`).
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
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
  /** The live region's text. Empty in the SSR HTML. */
  protected readonly status = signal('');

  private readonly nameValid = computed(() => {
    const name = this.displayName().trim();
    return name.length >= 1 && name.length <= DISPLAY_NAME_MAX;
  });
  protected readonly showNameError = computed(() => this.nameTouched() && !this.nameValid());

  constructor() {
    this.titleSvc.setTitle($localize`:@@welcome.metaTitle:Welcome · AEC Integrations`);
    // User-specific utility page. Never indexed.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });
    afterNextRender(() => {
      this.status.set($localize`:@@welcome.status.loading:Loading…`);
      void this.load();
    });
  }

  private async load(): Promise<void> {
    let profile;
    try {
      profile = await this.api.getProfile();
    } catch {
      // The failure line carries role="alert". Clear "Loading…" so the status
      // region does not keep stale text.
      this.status.set('');
      this.loadFailed.set(true);
      this.loading.set(false);
      return;
    }
    // Already answered or skipped (another tab, a re-used link), or an older
    // API that does not report the state: do not ask again. The loading state
    // stays up, so the form never flashes on the way out.
    if (profile.onboarding !== 'pending') {
      // Only when both navigations failed: show the Continue button rather
      // than spin. A started full load keeps the spinner, so no false alert
      // is announced while the page unloads.
      if ((await this.leave()) === 'failed') {
        this.loadFailed.set(true);
        this.loading.set(false);
      }
      return;
    }
    this.displayName.set(profile.display_name ?? profile.suggested_display_name ?? '');
    this.draft.set(draftFromDetails(profile.details));
    this.loading.set(false);
    this.status.set(
      $localize`:@@welcome.status.ready:The form is ready. Only the display name is required.`,
    );
    // The form renders on the next change detection. Focus the heading after
    // it, so a keyboard or screen reader user starts at the top of the form.
    afterNextRender(() => this.titleEl()?.nativeElement.focus(), { injector: this.injector });
  }

  protected onDisplayName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  /**
   * Save is always pressable. An invalid answer shows its error and focuses the
   * first bad field, top to bottom: the display name, then the LinkedIn link.
   */
  protected async onSave(): Promise<void> {
    if (this.saving()) return;
    this.nameTouched.set(true);
    const nameBad = !this.nameValid();
    if (nameBad) this.nameInput()?.nativeElement.focus();
    const detailsBad = this.detailsForm()?.revealErrors({ focus: !nameBad }) ?? false;
    if (nameBad || detailsBad || linkedInInvalid(this.draft())) return;
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
    if ((await this.leave()) !== 'client') this.saving.set(false);
  }

  /**
   * Record the skip, then leave. A failed write still leaves: skipping must
   * never trap the user here, and the `/account` card asks again later.
   */
  protected async onSkip(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.saveFailed.set(false);
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
    if ((await this.leave()) !== 'client') this.saving.set(false);
  }

  /**
   * Go to `next`. A client navigation that resolves `false` or throws falls back
   * to a full page load. Resolves `'client'` when the client navigation landed,
   * `'hard'` when the full load was started, and `'failed'` when both threw.
   * Save and Skip re-enable their buttons on anything but `'client'`, so a
   * fallback that never unloads the page still leaves the user a way out.
   */
  protected async leave(): Promise<LeaveResult> {
    try {
      if (await this.router.navigateByUrl(this.next)) return 'client';
    } catch {
      // Fall through to the full load.
    }
    try {
      this.hardNavigate(this.next);
      return 'hard';
    } catch {
      return 'failed';
    }
  }

  /** The full-page fallback. A method so a test can stand in for it. */
  protected hardNavigate(url: string): void {
    globalThis.location.assign(url);
  }
}
