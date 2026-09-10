/**
 * The account menu's identity block — who you are, above the things you can do
 * (AECI-850). Rendered at the top of the desktop dropdown (`user-menu.ts`) and
 * the top of the mobile overlay's account section (`nav-menu.ts`).
 *
 * ── Why this is one component and not two inline blocks ─────────────────────
 * The two headers had already drifted once: the desktop menu and the mobile
 * overlay each hand-rolled the Account / portal-door / Sign-out list, and the
 * only thing keeping them in step was that someone remembered to edit both. An
 * identity block is worse to duplicate than a link list, because it composes
 * three sources (`SessionStatus`, `RoleStatus`, the fallback chain between them)
 * and gets the wrong answer quietly rather than loudly. One component, injected
 * from both, so the two surfaces cannot disagree about who is signed in.
 *
 * ── The fallback chain, and why the order is what it is ─────────────────────
 * Name:  `profiles.display_name` → the provider's `full_name` → *nothing*.
 *        `display_name` wins because the user set it deliberately on `/account`;
 *        the provider name is what makes a brand-new Google account read as a
 *        person before they have set anything.
 * Photo: the provider's `avatar_url` → an initial letter. **A magic-link account
 *        has no photo at all and that is the majority case**, so the initial is
 *        the primary design and the photo is the enhancement — not the reverse.
 * Line:  when there is no name, the email is promoted to the primary line and
 *        the secondary line is dropped, so the block never prints the same
 *        string twice.
 *
 * ── What renders when, and why nothing here leaks into cached HTML ──────────
 * Every input is client-only. `SessionStatus` stays neutral through SSR and
 * pre-hydration (§8), and `RoleStatus.role()` is `null` until the shared probe
 * (or its `sessionStorage` hint) resolves. The block therefore cannot reach the
 * URL-keyed cached header HTML for any visitor — the same guarantee the portal
 * doors rely on.
 *
 * The panel only mounts on click, well after hydration, so in practice the whole
 * block paints fully-formed. `min-h` still reserves the two-line box: `role()`
 * arrives instantly from the cached hint while `email()` waits on the async
 * session snapshot, and without the reserve the menu would grow under the
 * cursor on the one open where the snapshot is still in flight.
 *
 * Not focusable, no `role`, no interactive child — it is a label for the menu
 * that follows it, and adding a link here would put a second tab stop in front
 * of "Account" for no new destination.
 */
import { Component, computed, inject } from '@angular/core';

import { RoleStatus } from '../auth/role-status';
import { SessionStatus } from '../auth/session-status';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

@Component({
  selector: 'aec-account-identity',
  imports: [LogoOrInitial],
  host: { class: 'block' },
  template: `
    <div class="flex min-h-10 items-center gap-3 px-3 py-2">
      <!-- Empty alt: the name is in the adjacent text, so a described photo
           would make a screen reader announce the same person twice. -->
      <aec-logo-or-initial
        size="sm"
        shape="circle"
        alt=""
        referrerPolicy="no-referrer"
        [src]="avatarUrl()"
        [name]="initialSource()"
      />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-(--text-primary)" [title]="primaryLine()">
          {{ primaryLine() }}
        </p>
        @if (secondaryLine(); as secondary) {
          <p class="truncate text-xs text-(--text-secondary)" [title]="secondary">
            {{ secondary }}
          </p>
        }
      </div>
    </div>

    @if (roleKey(); as key) {
      <p class="px-3 pb-2">
        <span
          class="inline-flex items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
          [class]="pillClass()"
        >
          @switch (key) {
            @case ('admin') {
              <ng-container i18n="@@app.header.account.role.admin">Site admin</ng-container>
            }
            @case ('vendor_admin') {
              <ng-container i18n="@@app.header.account.role.vendorAdmin">Vendor admin</ng-container>
            }
            @default {
              <ng-container i18n="@@app.header.account.role.reviewer">Reviewer</ng-container>
            }
          }
        </span>
      </p>
    }
  `,
})
export class AccountIdentity {
  private readonly session = inject(SessionStatus);
  private readonly roleStatus = inject(RoleStatus);

  /** The provider photo, or null — null is the normal magic-link case. */
  protected readonly avatarUrl = this.session.avatarUrl;

  /** `display_name` is only readable from a LIVE probe: `RoleStatus.profile()`
   *  stays null when `role()` came from the `sessionStorage` hint, so the
   *  provider name has to be able to carry the line on its own. */
  private readonly name = computed(
    () => this.roleStatus.profile()?.display_name ?? this.session.fullName(),
  );

  /** Name if we have one, else the email, else a neutral placeholder that is
   *  still a real word — an empty line would collapse the block's height and
   *  undo the reserve above. */
  protected readonly primaryLine = computed(
    () =>
      this.name() ?? this.session.email() ?? $localize`:@@app.header.account.signedIn:Signed in`,
  );

  /** Dropped entirely when the email is already the primary line. */
  protected readonly secondaryLine = computed(() =>
    this.name() === null ? null : this.session.email(),
  );

  /** What `LogoOrInitial` derives its letter from. Deliberately the same string
   *  the primary line shows, so the letter always matches the visible name. */
  protected readonly initialSource = computed(() => this.primaryLine());

  /**
   * `profiles.role`, or null before the probe resolves. Rendered for EVERY role
   * including the `reviewer` default: on a review platform "Reviewer" is a real
   * standing rather than an empty state, and a pill that appears only for staff
   * would make the block's height depend on who is looking.
   */
  protected readonly roleKey = this.roleStatus.role;

  /** Forest-soft for the two roles that open a portal door, neutral for the
   *  default. The distinction is informative, so it earns the accent; Forest is
   *  the only accent it may use (the Forest-Anchor Rule). Colour is never the
   *  sole signal — the label beside it says which role this is. */
  protected readonly pillClass = computed(() =>
    this.roleKey() === 'admin' || this.roleKey() === 'vendor_admin'
      ? 'bg-(--accent-primary-soft) text-(--accent-primary)'
      : 'border border-(--border-default) bg-(--surface-sunken) text-(--text-secondary)',
  );
}
