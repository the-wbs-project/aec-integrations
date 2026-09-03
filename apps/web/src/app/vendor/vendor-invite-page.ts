import { HttpClient } from '@angular/common/http';
import { Component, afterNextRender, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { AcceptSeatInviteResponse, SeatInvitePreview } from '@aeci/shared';

import { MetaService } from '../core/meta.service';
import { canonicalUrl } from '../core/canonical';

/**
 * `/vendor/invite/:token` — where a seat invite is redeemed (AECI-664 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a).
 *
 * ── WHY IT IS NOT INSIDE THE PORTAL SHELL ───────────────────────────────────
 * Everything under `/vendor/:vendorSlug` is behind `vendorMeResolver`, which
 * renders a 404 for anyone `requireVendor()` rejects. The person redeeming an
 * invite is BY DEFINITION not a vendor admin yet, so mounting this there would
 * 404 exactly the audience it exists for. It is a sibling route registered
 * BEFORE `:vendorSlug` in `vendor.routes.ts`, so the literal `invite` segment
 * can never be captured as a vendor slug.
 *
 * It stays under `/vendor/` rather than at the top level so the worker-level
 * anon gate (`server-runtime.ts` `isVendorPath`) still bounces a signed-out
 * visitor to `/auth/login?return=<this path>` — which is the flow, not a
 * side-effect: they arrive from an email, sign in as themselves, and come back
 * here with the token intact (`safeReturnPath` preserves the whole path).
 *
 * ── CONFIRM, THEN POST ──────────────────────────────────────────────────────
 * The GET only previews. Mail scanners, link-preview bots and corporate URL
 * rewriters all fetch what they are sent, so a link that redeemed on GET would
 * be spent by the invitee's own security appliance before they ever clicked.
 * The redeem is a POST behind a real button — the `/unsubscribe` discipline
 * (AECI-537).
 *
 * Browser-only work: the preview fetch runs in `afterNextRender`, so SSR paints
 * the loading state and no invite data is ever baked into a cached response
 * (the portal paths are `private, no-store` anyway, but the rule holds).
 */
@Component({
  selector: 'aec-vendor-invite-page',
  template: `
    <div class="mx-auto w-full max-w-xl px-4 py-16">
      <section
        class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-6"
      >
        @switch (state()) {
          @case ('loading') {
            <p class="text-sm text-(--text-secondary)" i18n="@@vendor.invite.loading">
              Checking your invite…
            </p>
          }
          @case ('ready') {
            <h1
              class="font-display text-2xl font-semibold tracking-tight text-(--text-primary)"
              i18n="@@vendor.invite.title"
            >
              Join your team on AEC Integrations
            </h1>
            <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">
              <ng-container i18n="@@vendor.invite.body.lead"
                >You've been invited to help manage</ng-container
              >
              <strong class="text-(--text-primary)">{{ preview()?.vendor_name }}</strong>
              <ng-container i18n="@@vendor.invite.body.tail"
                >. Accepting adds your account to the vendor's team.</ng-container
              >
            </p>
            <button type="button" class="mt-6" [disabled]="busy()" (click)="accept()" [class]="btn">
              @if (busy()) {
                <span i18n="@@vendor.invite.accepting">Joining…</span>
              } @else {
                <span i18n="@@vendor.invite.accept">Accept invite</span>
              }
            </button>
          }
          @case ('blocked') {
            <h1
              class="font-display text-2xl font-semibold tracking-tight text-(--text-primary)"
              i18n="@@vendor.invite.blocked.title"
            >
              This invite can't be used
            </h1>
            <p class="mt-3 text-sm leading-relaxed text-(--text-secondary)">{{ blockedCopy() }}</p>
          }
          @case ('error') {
            <h1
              class="font-display text-2xl font-semibold tracking-tight text-(--text-primary)"
              i18n="@@vendor.invite.error.title"
            >
              We couldn't load this invite
            </h1>
            <p
              class="mt-3 text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@vendor.invite.error.body"
            >
              The link may be wrong or expired. Ask whoever invited you to send a new one.
            </p>
          }
        }
      </section>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorInvitePage {
  private readonly http = inject(HttpClient);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly meta = inject(MetaService);

  private readonly token = this.route.snapshot.paramMap.get('token');

  protected readonly preview = signal<SeatInvitePreview | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'blocked' | 'error'>('loading');
  protected readonly busy = signal(false);

  protected readonly btn =
    'inline-flex items-center rounded-(--radius-sm) border border-(--accent-primary) bg-(--accent-primary) px-4 py-2 text-sm font-label font-semibold text-(--surface-base) transition-opacity disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    this.meta.setStaticPageMeta({
      title: $localize`:@@meta.vendorInviteTitle:Accept your invite · AEC Integrations`,
      description: $localize`:@@meta.vendorInviteDescription:Accept an invitation to manage a vendor listing on AEC Integrations.`,
      canonical: canonicalUrl('/vendor'),
      noindex: true,
    });

    afterNextRender(() => void this.load());
  }

  /**
   * Copy per refusal reason. `email_mismatch` is the one that has to be
   * actionable rather than merely accurate: it is the likeliest failure (someone
   * already signed in as a personal account), and the fix — sign out, sign in as
   * the invited address — is not something a generic message would tell them.
   */
  protected blockedCopy(): string {
    switch (this.preview()?.reason) {
      case 'email_mismatch':
        return $localize`:@@vendor.invite.blocked.mismatch:This invite was sent to ${this.preview()?.email}:email:. Sign out and sign back in with that address to accept it.`;
      case 'expired':
        return $localize`:@@vendor.invite.blocked.expired:This invite has expired. Ask whoever invited you to send a new one.`;
      case 'revoked':
        return $localize`:@@vendor.invite.blocked.revoked:This invite was withdrawn.`;
      case 'accepted':
        return $localize`:@@vendor.invite.blocked.accepted:This invite has already been used.`;
      default:
        return $localize`:@@vendor.invite.blocked.generic:This invite is no longer valid.`;
    }
  }

  private async load(): Promise<void> {
    if (!this.token) {
      this.state.set('error');
      return;
    }
    try {
      const body = await firstValueFrom(
        this.http.get<SeatInvitePreview>(`/api/seat-invites/${encodeURIComponent(this.token)}`),
      );
      this.preview.set(body);
      this.state.set(body.redeemable ? 'ready' : 'blocked');
    } catch {
      this.state.set('error');
    }
  }

  protected async accept(): Promise<void> {
    if (!this.token || this.busy()) return;
    this.busy.set(true);
    try {
      const body = await firstValueFrom(
        this.http.post<AcceptSeatInviteResponse>(
          `/api/seat-invites/${encodeURIComponent(this.token)}/accept`,
          {},
        ),
      );
      // Land them where the seat actually is. A full navigation rather than a
      // router hop: the session's role has just changed server-side, and the
      // portal's own resolver has to re-run against the new one.
      await this.router.navigateByUrl(`/vendor/${body.vendor_slug}/overview`);
    } catch {
      // Re-read rather than guessing: the server knows WHICH refusal this was,
      // and the reason drives the copy.
      await this.load();
      if (this.state() === 'ready') this.state.set('error');
    } finally {
      this.busy.set(false);
    }
  }
}
