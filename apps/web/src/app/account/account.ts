import { Component, afterNextRender, inject, signal } from '@angular/core';
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

import { UpdateAccountSchema, type AccountProfileResponse } from '@aeci/shared';

import { AuthService } from '../auth/auth.service';
import { AccountApi } from './account-api';

/**
 * `/account` (AECI-202 / Phase 5.11) — the signed-in user's account surface:
 * identity (email read-only from the session, editable display name), a
 * deferred reviews section, sign-out, and the GDPR **delete account** flow (a
 * confirmation dialog).
 *
 * Auth + cacheability: the SSR Worker 303s an unauthenticated visitor to
 * `/auth/login?return=/account` before this ever renders, and `/account` is
 * non-cacheable by the fail-closed default (`server-runtime.ts`). So SSR paints
 * the shell and the browser fetches identity in `afterNextRender` (mirroring
 * `LoginPage`) — the same-origin `/api/account` reads carry the session cookie,
 * which the API Worker's `requireAuth()` verifies.
 *
 * The user's submitted-reviews list is DEFERRED (no `GET /api/account/reviews`
 * endpoint yet) — the reviews section renders a placeholder; see AECI-225.
 *
 * i18n / a11y: all copy is `i18n`/`$localize`; the delete confirmation uses
 * Spartan `BrnDialog` (focus trap + Escape + focus return).
 */
@Component({
  selector: 'aec-account-page',
  imports: [
    FormField,
    RouterLink,
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

  private readonly model = signal<{ display_name: string }>({ display_name: '' });

  protected readonly form = form(this.model, (p) => {
    validateStandardSchema(p, UpdateAccountSchema);
  });

  constructor() {
    this.titleSvc.setTitle($localize`:@@account.metaTitle:Your account · AEC Integrations`);
    // User-specific utility page — never indexed.
    this.metaSvc.updateTag({ name: 'robots', content: 'noindex' });

    // Browser-only: load identity after hydration. During SSR the shell paints
    // the loading state; the page is auth-gated so a cookie is always present.
    afterNextRender(() => {
      void this.load();
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
