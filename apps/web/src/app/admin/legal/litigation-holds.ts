import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import {
  ADMIN_REASON_MAX,
  ApiErrorCode,
  LITIGATION_HOLD_MATTER_MAX,
  type LitigationHold,
  type LitigationHoldScope,
  type LitigationHoldsResponse,
} from '@aeci/shared';

import { AdminLegalApi } from './admin-legal-api';
import { AecFormSubmit } from '../../shared/form-field/form-submit';

/** The console's button styles, as the suspension section and the publish form use them. */
const BUTTON_BASE =
  'cursor-pointer rounded-(--radius-sm) border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
export const HOLD_BUTTON = `${BUTTON_BASE} border-(--border-default) text-(--text-primary)`;
export const HOLD_CONFIRM_BUTTON = `${BUTTON_BASE} border-(--text-primary) bg-(--text-primary) text-(--surface-base)`;
export const HOLD_INPUT =
  'mt-2 w-full rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

/** The message for a failed hold write, in plain words. */
export function holdErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const code = (error.error as { error?: { code?: string } } | null)?.error?.code;
    if (error.status === 409 && code === ApiErrorCode.LITIGATION_HOLD_EXISTS) {
      return $localize`:@@admin.legal.holds.error.exists:An open hold already covers this scope. Release it first, or reload.`;
    }
    if (error.status === 409 && code === ApiErrorCode.LITIGATION_HOLD_RELEASED) {
      return $localize`:@@admin.legal.holds.error.released:This hold was already released. Reload.`;
    }
    if (error.status === 404) {
      return $localize`:@@admin.legal.holds.error.notFound:No vendor or hold has that id. Check it and try again.`;
    }
    if (error.status === 400) {
      return $localize`:@@admin.legal.holds.error.invalid:Check the fields and try again. Nothing was saved.`;
    }
    if (error.status === 429) {
      return $localize`:@@admin.legal.holds.error.rateLimited:Too many changes at once. Wait a minute, then try again.`;
    }
  }
  return $localize`:@@admin.legal.holds.error.failed:Something went wrong. Nothing was saved. Try again.`;
}

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; data: LitigationHoldsResponse };

/**
 * "Litigation holds" on `/admin/legal` (AECI-1638, `ADMIN_PANEL_SPEC.md` §5.22b, ADR 0058).
 * A hold stops the legal retention prune: a vendor hold keeps that vendor's audit,
 * acceptance and grant records and lets every other record go on schedule (ruling 55,
 * AECI-1970), and a global hold keeps everything. Its own component, apart from the publish form and "Who has accepted".
 *
 * The list loads in `afterNextRender`, a read that is never rate-limited. Place and release
 * are inline forms with a required reason, the suspension section's idiom, because each
 * can be undone by the other. A write answers with the hold, then the list is re-read.
 * Results go to the section's own polite live region.
 */
@Component({
  selector: 'aec-admin-litigation-holds',
  imports: [AecFormSubmit, DatePipe, RouterLink],
  host: { class: 'block' },
  templateUrl: './litigation-holds.html',
})
export class AdminLitigationHolds {
  private readonly api = inject(AdminLegalApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly buttonClass = HOLD_BUTTON;
  protected readonly confirmClass = HOLD_CONFIRM_BUTTON;
  protected readonly inputClass = HOLD_INPUT;
  protected readonly reasonMax = ADMIN_REASON_MAX;
  protected readonly matterMax = LITIGATION_HOLD_MATTER_MAX;

  protected readonly load = signal<Load>({ state: 'loading' });
  protected readonly liveMessage = signal('');
  protected readonly open = computed(() => {
    const l = this.load();
    return l.state === 'ready' ? l.data.open : [];
  });
  protected readonly released = computed(() => {
    const l = this.load();
    return l.state === 'ready' ? l.data.released : [];
  });
  protected readonly globalOpen = computed(() => this.open().some((h) => h.scope === 'global'));

  // ── Place form ─────────────────────────────────────────────────────────────
  protected readonly placeOpen = signal(false);
  protected readonly scope = signal<LitigationHoldScope>('vendor');
  protected readonly vendorId = signal('');
  protected readonly reason = signal('');
  protected readonly matter = signal('');
  protected readonly placeShowErrors = signal(false);
  protected readonly placing = signal(false);
  protected readonly placeError = signal('');

  // ── Release form, one hold at a time ───────────────────────────────────────
  protected readonly releasingId = signal<string | null>(null);
  protected readonly releaseReason = signal('');
  protected readonly releaseShowError = signal(false);
  protected readonly releasing = signal(false);
  protected readonly releaseError = signal('');

  constructor() {
    afterNextRender(() => void this.fetch());
  }

  private async fetch(): Promise<void> {
    try {
      const data = await this.api.litigationHolds();
      this.load.set({ state: 'ready', data });
    } catch {
      if (this.load().state !== 'ready') this.load.set({ state: 'error' });
    }
  }

  protected retry(): void {
    this.load.set({ state: 'loading' });
    void this.fetch();
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  protected textOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  // ── Place ──────────────────────────────────────────────────────────────────

  protected openPlace(): void {
    this.scope.set('vendor');
    this.vendorId.set('');
    this.reason.set('');
    this.matter.set('');
    this.placeShowErrors.set(false);
    this.placeError.set('');
    this.placeOpen.set(true);
    this.focus('#admin-hold-scope-vendor');
  }

  protected cancelPlace(): void {
    this.placeOpen.set(false);
  }

  protected vendorMissing(): boolean {
    return this.scope() === 'vendor' && !this.vendorId().trim();
  }

  protected async submitPlace(): Promise<void> {
    if (this.placing()) return;
    const reason = this.reason().trim();
    if (!reason || this.vendorMissing()) {
      this.placeShowErrors.set(true);
      this.focus('[aria-invalid="true"]');
      return;
    }
    this.placing.set(true);
    this.placeError.set('');
    try {
      const scope = this.scope();
      await this.api.placeHold({
        scope,
        vendor_id: scope === 'vendor' ? this.vendorId().trim() : null,
        reason,
        matter_reference: this.matter().trim() || null,
      });
      this.placeOpen.set(false);
      this.liveMessage.set(
        scope === 'global'
          ? $localize`:@@admin.legal.holds.announce.placedGlobal:Global hold placed. The retention prune deletes nothing until it is released.`
          : $localize`:@@admin.legal.holds.announce.placedVendor:Vendor hold placed. That vendor's records are kept. Other records are deleted on schedule.`,
      );
      await this.fetch();
    } catch (error) {
      this.placeError.set(holdErrorMessage(error));
    } finally {
      this.placing.set(false);
    }
  }

  // ── Release ────────────────────────────────────────────────────────────────

  protected openRelease(hold: LitigationHold): void {
    this.releasingId.set(hold.id);
    this.releaseReason.set('');
    this.releaseShowError.set(false);
    this.releaseError.set('');
    this.focus(`[id="admin-hold-release-${hold.id}"]`);
  }

  protected cancelRelease(): void {
    this.releasingId.set(null);
  }

  protected async submitRelease(hold: LitigationHold): Promise<void> {
    if (this.releasing()) return;
    const reason = this.releaseReason().trim();
    if (!reason) {
      this.releaseShowError.set(true);
      this.focus(`[id="admin-hold-release-${hold.id}"]`);
      return;
    }
    this.releasing.set(true);
    this.releaseError.set('');
    try {
      await this.api.releaseHold(hold.id, reason);
      this.releasingId.set(null);
      this.liveMessage.set(
        $localize`:@@admin.legal.holds.announce.released:Hold released. The retention prune resumes on its next run.`,
      );
      await this.fetch();
    } catch (error) {
      this.releaseError.set(holdErrorMessage(error));
    } finally {
      this.releasing.set(false);
    }
  }

  // ── Renderers ──────────────────────────────────────────────────────────────

  protected scopeLabel(hold: LitigationHold): string {
    if (hold.scope === 'global') {
      return $localize`:@@admin.legal.holds.scope.global:Global: everything is kept`;
    }
    const name = hold.vendor_name ?? hold.vendor_id ?? '';
    return $localize`:@@admin.legal.holds.scope.vendor:Vendor: ${name}:NAME:`;
  }
}
