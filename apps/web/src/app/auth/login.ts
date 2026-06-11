import { Component, afterNextRender, inject, signal } from '@angular/core';
import { FormField, form, submit, validateStandardSchema } from '@angular/forms/signals';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute } from '@angular/router';

import { z } from 'zod';

import { AuthService } from './auth.service';
import { safeReturnPath } from './return-path';

/**
 * Magic-link model schema, local to the auth folder: there is no API endpoint
 * behind this form (the browser talks to Supabase directly), so no
 * `@aeci/shared` round-trip is required. Messages are never rendered — the
 * template owns user-facing copy via `i18n`/`$localize` (ADR 0009: Zod =
 * logic, `$localize` = presentation).
 */
const MagicLinkSchema = z.object({
  email: z.string().trim().min(1, 'Your email is required.').email('Enter a valid email address.'),
});

/**
 * `/auth/login` (AECI-194 / Phase 5.3) — the first user-facing auth surface:
 * magic-link email (Signal Forms, per ADR 0009) + Google OAuth, both
 * redirecting through `/auth/callback?return=<path>` (the AECI-195 exchange).
 *
 * The `?return=` query param carries the visitor's pre-login location; it is
 * narrowed by `safeReturnPath` at this route boundary (and again inside
 * `AuthService`) so a hostile link can never bounce the user off-site after
 * sign-in — the "no open redirect" acceptance criterion.
 *
 * SSR renders the full form shell (cache-safe: `/auth/*` is non-cacheable via
 * the fail-closed route classifier in `server-runtime.ts`, no classifier
 * change needed). Browser-only concerns — probing the SSR-injected public
 * Supabase config and the Supabase calls themselves — run in
 * `afterNextRender` / user events, mirroring `SearchPage`. When the env has
 * no Supabase config the page degrades to a "temporarily unavailable" notice
 * with disabled actions, mirroring the Algolia-absent search path.
 */
@Component({
  selector: 'aec-login-page',
  imports: [FormField],
  templateUrl: './login.html',
})
export class LoginPage {
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthService);
  private readonly titleSvc = inject(Title);
  private readonly metaSvc = inject(Meta);

  /** Validated same-origin return path threaded into both auth flows. */
  protected readonly returnPath = safeReturnPath(this.route.snapshot.queryParamMap.get('return'));

  /** Set to the submitted address on success; flips to "Check your email". */
  protected readonly emailSent = signal<string | null>(null);

  /** True when the last attempt (either flow) failed. Surfaced as a
   *  non-blocking notice so the user can retry (same pattern as
   *  `RequestForm.submitFailed`). */
  protected readonly submitFailed = signal(false);

  /** True once the browser knows the public Supabase config is absent. */
  protected readonly unavailable = signal(false);

  /** Guards double-fires of the Google flow while the redirect is in flight. */
  protected readonly googlePending = signal(false);

  private readonly model = signal({ email: '' });

  protected readonly form = form(this.model, (p) => {
    validateStandardSchema(p, MagicLinkSchema);
  });

  constructor() {
    this.titleSvc.setTitle($localize`:@@auth.login.metaTitle:Sign in · AEC Integrations`);
    // Utility page — stays out of the index, like the request forms.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });

    // Browser-only: probe the SSR-injected public config. During SSR the
    // signal stays false, so the cacheless SSR shell always paints the form.
    afterNextRender(() => {
      this.unavailable.set(!this.auth.isConfigured());
    });
  }

  protected async onSubmit(): Promise<void> {
    if (this.unavailable()) return;
    this.submitFailed.set(false);
    await submit(this.form, async (f) => {
      const email = f().value().email.trim();
      try {
        await this.auth.sendMagicLink(email, this.returnPath);
        this.emailSent.set(email);
      } catch {
        // Notice, not a form error — a `ValidationError` would mark the form
        // invalid and disable the button, blocking the retry the copy invites.
        this.submitFailed.set(true);
      }
      return undefined;
    });
  }

  protected async onGoogle(): Promise<void> {
    if (this.unavailable() || this.googlePending()) return;
    this.submitFailed.set(false);
    this.googlePending.set(true);
    try {
      await this.auth.signInWithGoogle(this.returnPath);
      // Success = the browser is navigating away; keep the button disabled.
    } catch {
      this.googlePending.set(false);
      this.submitFailed.set(true);
    }
  }

  /** Resets from the "Check your email" panel back to the form. */
  protected useDifferentEmail(): void {
    this.submitFailed.set(false);
    this.emailSent.set(null);
  }
}
