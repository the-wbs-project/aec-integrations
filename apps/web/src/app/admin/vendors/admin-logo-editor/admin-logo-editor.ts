import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { UpdateLogoSchema } from '@aeci/shared';
import { firstValueFrom } from 'rxjs';

import { LogoInput } from '../../../shared/logo-input/logo-input';

@Component({
  selector: 'aec-admin-logo-editor',
  imports: [LogoInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="max-w-xl space-y-4" (submit)="$event.preventDefault(); save()">
      <aec-logo-input
        [inputId]="'admin-logo-' + kind() + '-' + recordId()"
        [value]="draft()"
        [disabled]="saving()"
        uploadEndpoint="/api/admin/logo"
        (valueChange)="draft.set($event); saved.set(false)"
        (pendingChange)="uploading.set($event)"
        (announce)="announce.emit($event)"
      />
      <button
        type="submit"
        [disabled]="saveDisabled()"
        class="rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-2 text-sm font-bold text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
      >
        @if (saving()) {
          <span i18n="@@admin.logo.saving">Saving…</span>
        } @else {
          <span i18n="@@admin.logo.save">Save logo</span>
        }
      </button>
      @if (saved()) {
        <p class="text-sm text-(--text-secondary)" i18n="@@admin.logo.saved">
          Logo saved. Future catalog updates will keep this choice.
        </p>
      }
      @if (failed()) {
        <p role="alert" class="text-sm text-(--text-primary)" i18n="@@admin.logo.failed">
          We couldn't save this logo. Please try again.
        </p>
      }
    </form>
  `,
})
export class AdminLogoEditor {
  readonly recordId = input.required<string>();
  readonly kind = input.required<'vendor' | 'product'>();
  readonly logoUrl = input<string | null>(null);
  readonly logoSaved = output<string | null>();
  readonly announce = output<string>();
  protected readonly draft = signal('');
  protected readonly saving = signal(false);
  protected readonly uploading = signal(false);
  protected readonly saved = signal(false);
  protected readonly failed = signal(false);
  private readonly baseline = signal('');
  private seededId = '';
  private readonly http = inject(HttpClient);
  protected readonly saveDisabled = computed(
    () =>
      this.saving() ||
      this.uploading() ||
      this.draft().trim() === this.baseline() ||
      !UpdateLogoSchema.safeParse({ logo_url: this.draft().trim() || null }).success,
  );

  constructor() {
    effect(() => {
      const id = this.recordId();
      const value = this.logoUrl() ?? '';
      if (id !== this.seededId || value !== untracked(this.baseline)) {
        this.seededId = id;
        this.baseline.set(value);
        this.draft.set(value);
        this.saved.set(false);
      }
    });
  }
  protected async save(): Promise<void> {
    if (this.saveDisabled()) return;
    const recordId = this.recordId();
    const logoUrl = this.draft().trim() || null;
    this.saving.set(true);
    this.failed.set(false);
    this.saved.set(false);
    try {
      await firstValueFrom(
        this.http.patch(
          `/api/admin/${this.kind() === 'vendor' ? 'vendors' : 'products'}/${recordId}/logo`,
          { logo_url: logoUrl },
        ),
      );
      if (recordId !== this.recordId()) return;
      this.baseline.set(logoUrl ?? '');
      this.saved.set(true);
      this.logoSaved.emit(logoUrl);
      this.announce.emit($localize`:@@admin.logo.confirmation:Logo saved.`);
    } catch {
      if (recordId === this.recordId()) this.failed.set(true);
    } finally {
      this.saving.set(false);
    }
  }
}
