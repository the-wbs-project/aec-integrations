import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ADMIN_REASON_MAX, AdminReasonSchema, UpdateLogoSchema } from '@aeci/shared';
import { firstValueFrom } from 'rxjs';

import { LogoInput } from '../../../shared/logo-input/logo-input';
import { overrideReasonBody } from '../admin-vendors-api';

@Component({
  selector: 'aec-admin-logo-editor',
  imports: [LogoInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <form class="max-w-xl space-y-4" novalidate (submit)="$event.preventDefault(); save()">
      <aec-logo-input
        [inputId]="'admin-logo-' + kind() + '-' + recordId()"
        [value]="draft()"
        [disabled]="saving()"
        uploadEndpoint="/api/admin/logo"
        (valueChange)="draft.set($event); saved.set(false)"
        (pendingChange)="uploading.set($event)"
        (announce)="announce.emit($event)"
      />
      <div>
        <label
          [attr.for]="fieldId('reason')"
          class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
          i18n="@@admin.logo.reason.vendorLabel"
        >
          Reason shown to the vendor (required)
        </label>
        <p
          [id]="fieldId('reason-help')"
          class="mt-1 text-xs text-(--text-secondary)"
          i18n="@@admin.logo.reason.vendorHelp"
        >
          The vendor reads this in its portal messages. It is recorded in the audit trail with your
          name.
        </p>
        <textarea
          #reasonInput
          [id]="fieldId('reason')"
          rows="2"
          [attr.maxlength]="reasonMax"
          required
          [disabled]="saving()"
          [attr.aria-describedby]="
            reasonError()
              ? fieldId('reason-help') + ' ' + fieldId('reason-error')
              : fieldId('reason-help')
          "
          [attr.aria-invalid]="reasonError() ? 'true' : null"
          [value]="reason()"
          (input)="onReasonInput($event)"
          class="mt-2 w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        ></textarea>
        @if (reasonError()) {
          <p
            [id]="fieldId('reason-error')"
            role="alert"
            class="mt-2 text-sm font-medium text-(--text-primary)"
            i18n="@@admin.logo.reason.vendorRequired"
          >
            Enter a reason for the vendor. The vendor reads it in its portal messages.
          </p>
        }
      </div>
      <div>
        <label
          [attr.for]="fieldId('note')"
          class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
          i18n="@@admin.logo.note.label"
        >
          Internal note (optional, never shown to the vendor)
        </label>
        <textarea
          [id]="fieldId('note')"
          rows="2"
          [attr.maxlength]="reasonMax"
          [disabled]="saving()"
          [value]="internalNote()"
          (input)="onNoteInput($event)"
          class="mt-2 w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        ></textarea>
      </div>
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
  /** AECI-1191: the overwrite's reason, required by the API and kept in the audit row. */
  protected readonly reason = signal('');
  protected readonly reasonError = signal(false);
  /** AECI-1159: AECi's own note, kept in the audit row and never shown to a vendor. */
  protected readonly internalNote = signal('');
  protected readonly reasonMax = ADMIN_REASON_MAX;
  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
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
        this.reason.set('');
        this.internalNote.set('');
        this.reasonError.set(false);
      }
    });
  }
  protected fieldId(part: string): string {
    return `admin-logo-${this.kind()}-${this.recordId()}-${part}`;
  }

  protected onReasonInput(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    if (this.reasonError()) this.reasonError.set(false);
  }

  protected onNoteInput(event: Event): void {
    this.internalNote.set((event.target as HTMLTextAreaElement).value);
  }

  protected async save(): Promise<void> {
    if (this.saveDisabled()) return;
    const parsedReason = AdminReasonSchema.safeParse(this.reason());
    if (!parsedReason.success) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return;
    }
    const recordId = this.recordId();
    const logoUrl = this.draft().trim() || null;
    this.saving.set(true);
    this.failed.set(false);
    this.saved.set(false);
    try {
      await firstValueFrom(
        this.http.patch(
          `/api/admin/${this.kind() === 'vendor' ? 'vendors' : 'products'}/${recordId}/logo`,
          { logo_url: logoUrl, ...overrideReasonBody(parsedReason.data, this.internalNote()) },
        ),
      );
      if (recordId !== this.recordId()) return;
      this.baseline.set(logoUrl ?? '');
      this.reason.set('');
      this.internalNote.set('');
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
