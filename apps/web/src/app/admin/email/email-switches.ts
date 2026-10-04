import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  BrnDialog,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import type { AdminEmailSwitch, AdminEmailSwitchesResponse } from '@aeci/shared';

import { AdminEmailApi } from './admin-email-api';

/** The change the open dialog would make. */
interface PendingChange {
  target: AdminEmailSwitch;
  /** The state the switch moves TO. False is a pause. */
  enabled: boolean;
}

/**
 * The sending switches on `/admin/email` (AECI-1224). Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.14 "Sending switches" and §13 D24.
 *
 * ─── Why it confirms ─────────────────────────────────────────────────────────
 * A pause stops mail to real people on this tier, and a resume restarts it. Both are
 * consequential, so both go through a dialog that says what stops or starts and that it
 * applies to this tier only. The dialog opens from the click handler, never from an
 * `effect()`: `BrnDialog.open()` creates an effect of its own, which Angular forbids inside
 * another (`review-queue.ts` documents the same rule).
 *
 * ─── What it shows ───────────────────────────────────────────────────────────
 * Only pausable templates get a control. The always-on ones sit under a closed disclosure
 * so an operator looking for one learns it cannot be paused, rather than wondering where
 * it went. The server refuses a pause of those anyway (`NOTIFICATION_NOT_PAUSABLE`).
 *
 * ─── Host-owned chrome ───────────────────────────────────────────────────────
 * No live region of its own: the host page owns its single `role="status"` region, and
 * announcements go out through {@link announce}, as `ManagedByControl` does.
 */
@Component({
  selector: 'aec-email-switches',
  imports: [
    BrnDialog,
    BrnDialogContent,
    BrnDialogDescription,
    BrnDialogTitle,
    DatePipe,
    RouterLink,
  ],
  templateUrl: './email-switches.html',
})
export class EmailSwitches {
  private readonly api = inject(AdminEmailApi);

  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly data = signal<AdminEmailSwitchesResponse | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);

  protected readonly pending = signal<PendingChange | null>(null);
  protected readonly reason = signal('');
  protected readonly submitting = signal(false);
  protected readonly failedMessage = signal('');

  private readonly dialog = viewChild(BrnDialog);

  protected readonly environment = computed(() => this.data()?.environment ?? '');
  protected readonly supportCopy = computed(
    () => this.data()?.switches.find((s) => s.kind === 'support_copy') ?? null,
  );
  protected readonly supportCopyConfigured = computed(
    () => this.data()?.support_copy_configured ?? false,
  );
  protected readonly pausable = computed(
    () => this.data()?.switches.filter((s) => s.kind === 'notification' && s.pausable) ?? [],
  );
  protected readonly alwaysOn = computed(
    () => this.data()?.switches.filter((s) => s.kind === 'notification' && !s.pausable) ?? [],
  );
  protected readonly pausedCount = computed(
    () => (this.data()?.switches ?? []).filter((s) => !s.enabled).length,
  );

  constructor() {
    afterNextRender(() => {
      void this.load();
    });
  }

  /** Re-read the switches. The host's Refresh button calls it. */
  reload(): void {
    void this.load();
  }

  protected retry(): void {
    void this.load();
  }

  // ── The dialog ─────────────────────────────────────────────────────────────

  /** Open the confirmation for one switch. Called from a click handler only. */
  protected openChange(target: AdminEmailSwitch): void {
    this.failedMessage.set('');
    this.reason.set('');
    this.pending.set({ target, enabled: !target.enabled });
    this.dialog()?.open();
  }

  /** Cancel, Escape, or a backdrop click. */
  protected closeChange(): void {
    this.pending.set(null);
    this.reason.set('');
    this.failedMessage.set('');
    this.dialog()?.close();
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected async confirmChange(): Promise<void> {
    const change = this.pending();
    if (!change || this.submitting()) return;
    this.submitting.set(true);
    this.failedMessage.set('');
    const reason = this.reason().trim();
    try {
      const res = await this.api.setSwitch(change.target.key, {
        enabled: change.enabled,
        ...(reason ? { reason } : {}),
      });
      this.replace(res.switch);
      this.submitting.set(false);
      this.closeChange();
      this.announce.emit(announcement(res.switch));
    } catch (err) {
      this.failedMessage.set(messageForError(err));
      if (err instanceof HttpErrorResponse && err.status === 409) void this.load();
    } finally {
      this.submitting.set(false);
    }
  }

  // ── View helpers ───────────────────────────────────────────────────────────

  protected audienceLabel(audience: AdminEmailSwitch['audience']): string {
    return audience === 'operator'
      ? $localize`:@@admin.email.switches.audience.operator:AECi team`
      : $localize`:@@admin.email.switches.audience.external:People outside AECi`;
  }

  /** The first 8 characters of an admin's profile id, for the "changed by" link text. */
  protected shortId(id: string): string {
    return id.slice(0, 8);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async load(): Promise<void> {
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      this.data.set(await this.api.switches());
    } catch {
      this.loadFailed.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private replace(next: AdminEmailSwitch): void {
    const current = this.data();
    if (!current) return;
    this.data.set({
      ...current,
      switches: current.switches.map((s) => (s.key === next.key ? next : s)),
    });
  }
}

function announcement(s: AdminEmailSwitch): string {
  if (s.kind === 'support_copy') {
    return s.enabled
      ? $localize`:@@admin.email.switches.announce.copyResumed:The support copy is on again.`
      : $localize`:@@admin.email.switches.announce.copyPaused:The support copy is paused.`;
  }
  const key = s.key;
  return s.enabled
    ? $localize`:@@admin.email.switches.announce.resumed:${key}:KEY: is sending again.`
    : $localize`:@@admin.email.switches.announce.paused:${key}:KEY: is paused.`;
}

/** Each failure the operator can act on gets its own sentence. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    if (err.status === 409) {
      return $localize`:@@admin.email.switches.error.changed:Someone changed this switch since the page loaded. The list is up to date now. Check it and try again.`;
    }
    if (err.status === 400) {
      return $localize`:@@admin.email.switches.error.notPausable:This template cannot be paused. It stays on.`;
    }
    if (err.status === 429) {
      return $localize`:@@admin.email.switches.error.rateLimited:Too many changes in a minute. Wait a moment and try again.`;
    }
    if (err.status === 401 || err.status === 403) {
      return $localize`:@@admin.email.switches.error.session:Your session may have expired. Sign in again and retry.`;
    }
  }
  return $localize`:@@admin.email.switches.error.failed:Something went wrong. Please try again.`;
}
