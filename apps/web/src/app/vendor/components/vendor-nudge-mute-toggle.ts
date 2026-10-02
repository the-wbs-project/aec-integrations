import { DatePipe } from '@angular/common';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';

let nextId = 0;

/**
 * The per-seat switch for the daily reminder email (AECI-1204,
 * `STAGE_2_ATTESTATIONS_SPEC.md` §7.2), on the Messages page.
 *
 * ── WHAT IT CONTROLS ───────────────────────────────────────────────────────
 * One seat's daily attestation digest. ON means "email me", which is the default.
 * It is per SEAT: a colleague muting does not silence anyone else, and the copy
 * says so. It covers nudges only. Seat invites, claim decisions and plan notices
 * still arrive, and every reminder still lands in the notification list below,
 * which is why that list's framing no longer claims every reminder was emailed.
 *
 * ── WHY A HAND-ROLLED SWITCH ───────────────────────────────────────────────
 * Angular Aria (ADR 0010) ships no switch, and this is a command that writes on
 * activation, not a value picked and submitted later. So it is a native
 * `<button role="switch">` with `aria-checked`, the WAI-ARIA switch pattern, the
 * same call the integration page made for its `aria-pressed` Yes / No. Space and
 * Enter come from the native button.
 *
 * ── OPTIMISTIC, WITH A VISIBLE ROLLBACK ────────────────────────────────────
 * DESIGN.md's toggle rule: the switch flips at once, the PUT runs, and a failure
 * puts it back with an error the reader can see. Success is announced through the
 * portal's one live region rather than a second region here.
 *
 * Anchor site: Shopify admin settings (the portal's anchor). A bordered settings
 * card, title and one-line description on the start edge, the switch on the end.
 *
 * Loads in `afterNextRender`, never during SSR: the portal renders per session.
 */
@Component({
  selector: 'aec-vendor-nudge-mute-toggle',
  imports: [DatePipe],
  styles: [':host { display: block; }'],
  template: `
    <section
      class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) px-4 py-4"
      [attr.aria-busy]="state() === 'loading' ? 'true' : null"
      data-testid="nudge-mute"
    >
      <div class="flex items-start justify-between gap-6">
        <div class="min-w-0">
          <h3
            [id]="titleId"
            class="font-label text-sm text-(--text-primary)"
            i18n="@@vendor.nudgeMute.title"
          >
            Daily reminder email
          </h3>
          <p
            [id]="descriptionId"
            class="mt-1 max-w-prose text-sm leading-relaxed text-(--text-secondary)"
            i18n="@@vendor.nudgeMute.description"
          >
            One email a day listing the integration records that need an answer. It affects your
            seat only. Seat invites, claim decisions and plan notices still arrive.
          </p>
          @if (state() === 'ready') {
            <p class="mt-2 text-xs text-(--text-secondary)" data-testid="nudge-mute-status">
              @if (mutedAt(); as at) {
                <span i18n="@@vendor.nudgeMute.status.off">Off since</span>
                {{ at | date: 'mediumDate' }}
              } @else {
                <span i18n="@@vendor.nudgeMute.status.on">On</span>
              }
            </p>
          }
        </div>

        @if (state() === 'loading') {
          <!-- Same footprint as the switch, so nothing moves when it arrives. No
               switch is shown until the saved state is known. -->
          <span
            aria-hidden="true"
            class="mt-0.5 inline-block h-6 w-11 shrink-0 rounded-full bg-(--surface-sunken)"
            data-testid="nudge-mute-placeholder"
          ></span>
        } @else if (state() === 'ready') {
          <button
            type="button"
            role="switch"
            [attr.aria-checked]="emailOn() ? 'true' : 'false'"
            [attr.aria-labelledby]="titleId"
            [attr.aria-describedby]="descriptionId"
            [attr.aria-busy]="saving() ? 'true' : null"
            (click)="toggle()"
            class="aec-switch relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full bg-(--text-tertiary) transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) aria-checked:bg-(--accent-primary) motion-reduce:transition-none"
            data-testid="nudge-mute-switch"
          >
            <span
              aria-hidden="true"
              class="inline-block h-5 w-5 rounded-full bg-(--surface-base) transition-transform motion-reduce:transition-none"
              [class]="emailOn() ? 'translate-x-5' : 'translate-x-0.5'"
            ></span>
          </button>
        }
      </div>

      @if (state() === 'failed') {
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.nudgeMute.loadFailed">
            Could not load this setting.
          </p>
          <button
            type="button"
            [class]="retryClass"
            (click)="load()"
            i18n="@@vendor.nudgeMute.retry"
          >
            Try again
          </button>
        </div>
      }
      @if (saveError()) {
        <p
          class="mt-3 text-sm font-medium text-(--status-error)"
          role="alert"
          data-testid="nudge-mute-error"
          i18n="@@vendor.nudgeMute.saveFailed"
        >
          Could not save. Your setting has not changed. Try again.
        </p>
      }
    </section>
  `,
})
export class VendorNudgeMuteToggle {
  private readonly api = inject(VendorApi);
  private readonly announcer = inject(VendorPortalAnnouncer);

  protected readonly titleId = `aec-nudge-mute-title-${nextId}`;
  protected readonly descriptionId = `aec-nudge-mute-desc-${nextId++}`;

  /** `loading` until the first read lands; `failed` when it did not. */
  protected readonly state = signal<'loading' | 'ready' | 'failed'>('loading');
  private readonly muted = signal(false);
  protected readonly mutedAt = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal(false);

  /** The switch reads "email me": ON when NOT muted. */
  protected readonly emailOn = computed(() => !this.muted());

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      const prefs = await this.api.getNotificationPreferences();
      this.muted.set(prefs.nudges_muted);
      this.mutedAt.set(prefs.nudges_muted_at);
      this.state.set('ready');
    } catch {
      this.state.set('failed');
    }
  }

  protected async toggle(): Promise<void> {
    if (this.state() !== 'ready' || this.saving()) return;
    const previous = { muted: this.muted(), at: this.mutedAt() };
    const next = !previous.muted;
    // Optimistic: flip now, roll back visibly on failure.
    this.muted.set(next);
    this.saveError.set(false);
    this.saving.set(true);
    try {
      const prefs = await this.api.updateNotificationPreferences(next);
      this.muted.set(prefs.nudges_muted);
      this.mutedAt.set(prefs.nudges_muted_at);
      this.announcer.announce(
        prefs.nudges_muted
          ? $localize`:@@vendor.nudgeMute.announce.muted:Daily reminder email muted for your seat.`
          : $localize`:@@vendor.nudgeMute.announce.on:Daily reminder email turned on for your seat.`,
      );
    } catch {
      this.muted.set(previous.muted);
      this.mutedAt.set(previous.at);
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
