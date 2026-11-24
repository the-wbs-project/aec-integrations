import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
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
import {
  ADMIN_REASON_MAX,
  AdminReasonSchema,
  isHttpsUrl,
  UpdateLogoSchema,
  type AdminUpdateLogoResponse,
} from '@aeci/shared';
import { firstValueFrom } from 'rxjs';

import { LogoInput } from '../../../shared/logo-input/logo-input';
import { overrideReasonBody } from '../admin-vendors-api';
import { AecFormSubmit } from '../../../shared/form-field/form-submit';
import { AecButton } from '../../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_HINT_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../../shared/form-field/form-field-classes';
import { CONSOLE_CAPTION_CLASS } from '../../console/console-table';
import { QUEUE_FAILED_CLASS } from '../../reviews/queue-classes';
import {
  VENDOR_ACTIONS_CLASS,
  VENDOR_FIELD_CLASS,
  VENDOR_PANEL_FORM_CLASS,
} from '../vendor-console-classes';
import { CONSOLE_NOTICE_CLASS } from '../../console/console-detail';

@Component({
  selector: 'aec-admin-logo-editor',
  imports: [AecButton, AecFormSubmit, LogoInput],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'onEscape($event)' },
  template: `
    <!-- AECI-2112: the console's form recipe (mock-up 14). The objection removal keeps
         its two steps: a secondary opener, then the Bone warning and the danger confirm. -->
    <form method="dialog" [class]="formClass" novalidate (aecSubmit)="save()">
      <aec-logo-input
        [inputId]="'admin-logo-' + kind() + '-' + recordId()"
        [value]="draft()"
        [disabled]="saving()"
        uploadEndpoint="/api/admin/logo"
        (valueChange)="draft.set($event); saved.set(false)"
        (pendingChange)="uploading.set($event)"
        (announce)="announce.emit($event)"
      />
      <div [class]="fieldClass">
        <label
          [attr.for]="fieldId('reason')"
          [class]="labelClass"
          i18n="@@admin.logo.reason.vendorLabel"
        >
          Reason shown to the vendor (required)
        </label>
        <p [id]="fieldId('reason-help')" [class]="hintClass" i18n="@@admin.logo.reason.vendorHelp">
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
          [class]="inputClass"
          class="min-h-20 resize-y"
        ></textarea>
        @if (reasonError()) {
          <p
            [id]="fieldId('reason-error')"
            role="alert"
            [class]="errorClass"
            i18n="@@admin.logo.reason.vendorRequired"
          >
            Enter a reason for the vendor. The vendor reads it in its portal messages.
          </p>
        }
      </div>
      <!-- AECI-1628: on a record a vendor holds, the new logo is shown publicly as AEC
           Integrations' correction with this link as its source. -->
      <div [class]="fieldClass">
        <label [attr.for]="fieldId('source')" [class]="labelClass" i18n="@@admin.logo.source.label">
          Source link (required for a new logo when a vendor holds this record)
        </label>
        <p [id]="fieldId('source-help')" [class]="hintClass" i18n="@@admin.logo.source.help">
          Where you found the logo. On a record a vendor holds, the listing shows the change as
          corrected by AEC Integrations, with this link as its source. Optional when you remove a
          logo.
        </p>
        <input
          #sourceInput
          [id]="fieldId('source')"
          type="url"
          inputmode="url"
          autocomplete="off"
          maxlength="2048"
          placeholder="https://"
          [disabled]="saving()"
          [attr.aria-describedby]="
            sourceError()
              ? fieldId('source-help') + ' ' + fieldId('source-error')
              : fieldId('source-help')
          "
          [attr.aria-invalid]="sourceError() ? 'true' : null"
          [value]="sourceUrl()"
          (input)="onSourceInput($event)"
          [class]="inputClass"
        />
        @if (sourceError() === 'missing') {
          <p
            [id]="fieldId('source-error')"
            role="alert"
            [class]="errorClass"
            i18n="@@admin.logo.source.required"
          >
            A vendor holds this record. Add the link where you found the logo.
          </p>
        } @else if (sourceError() === 'invalid') {
          <p
            [id]="fieldId('source-error')"
            role="alert"
            [class]="errorClass"
            i18n="@@admin.logo.source.invalid"
          >
            Use an https:// link with no username or password.
          </p>
        }
      </div>
      <div [class]="fieldClass">
        <label [attr.for]="fieldId('note')" [class]="labelClass" i18n="@@admin.logo.note.label">
          Internal note (optional, never shown to the vendor)
        </label>
        <textarea
          [id]="fieldId('note')"
          rows="2"
          [attr.maxlength]="reasonMax"
          [disabled]="saving()"
          [value]="internalNote()"
          (input)="onNoteInput($event)"
          [class]="inputClass"
          class="min-h-20 resize-y"
        ></textarea>
      </div>
      <div>
        <button aecButton compact type="submit" [disabled]="saveDisabled()">
          @if (saving()) {
            <span i18n="@@admin.logo.saving">Saving…</span>
          } @else {
            <span i18n="@@admin.logo.save">Save logo</span>
          }
        </button>
      </div>
      @if (saved()) {
        <p [class]="captionClass" i18n="@@admin.logo.saved">
          Logo saved. Future catalog updates will keep this choice.
        </p>
      }
      @if (failed()) {
        <p
          [id]="fieldId('failed')"
          tabindex="-1"
          role="alert"
          [class]="failedClass"
          i18n="@@admin.logo.failed"
        >
          We couldn't save this logo. Please try again.
        </p>
      }
      <div class="grid gap-4 border-t border-(--border-default) pt-4" data-testid="logo-objection">
        @if (objectionDone(); as done) {
          <p [class]="captionClass">{{ done }}</p>
        } @else if (confirmingObjection()) {
          <p
            [id]="fieldId('objection-warning')"
            tabindex="-1"
            [class]="noticeClass"
            role="note"
            i18n="@@admin.logo.objection.warning"
          >
            This removes the logo and the copy AECi kept, so it also stops the logo returning. The
            stored file goes too, unless another record uses it. The reason above is required, and
            this cannot be undone.
          </p>
          @if (objectionFailed()) {
            <p
              [id]="fieldId('objection-failed')"
              tabindex="-1"
              role="alert"
              [class]="failedClass"
              i18n="@@admin.logo.objection.failed"
            >
              We couldn't remove this logo. Please try again.
            </p>
          }
          <div [class]="actionsClass">
            <button
              aecButton
              variant="danger"
              compact
              type="button"
              [disabled]="saving()"
              data-testid="logo-objection-confirm"
              (click)="confirmObjection()"
              i18n="@@admin.logo.objection.confirm"
            >
              Remove the logo
            </button>
            <button
              aecButton
              variant="ghost"
              type="button"
              [disabled]="saving()"
              (click)="cancelObjection()"
              i18n="@@admin.logo.objection.cancel"
            >
              Cancel
            </button>
          </div>
        } @else {
          <div>
            <button
              aecButton
              variant="secondary"
              compact
              type="button"
              [id]="fieldId('objection-open')"
              [disabled]="saving() || uploading()"
              data-testid="logo-objection-open"
              (click)="startObjection()"
              i18n="@@admin.logo.objection.open"
            >
              Remove on objection
            </button>
          </div>
        }
      </div>
    </form>
  `,
})
export class AdminLogoEditor {
  readonly recordId = input.required<string>();
  readonly kind = input.required<'vendor' | 'product'>();
  readonly logoUrl = input<string | null>(null);
  readonly logoSaved = output<string | null>();
  readonly announce = output<string>();
  /**
   * Escape outside the objection step, while nothing is saving: the host closes the
   * editor (the product row does; the vendor dialog closes on its own Escape).
   */
  readonly closeRequested = output<void>();
  /** A save or an objection removal started or ended, so the host can hold its own
   *  close paths while one is in flight (AECI-2112). */
  readonly savingChange = output<boolean>();
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
  /** AECI-1628: where AECi found the logo. Required by the API on a held replacement. */
  protected readonly sourceUrl = signal('');
  protected readonly sourceError = signal<'missing' | 'invalid' | null>(null);
  /** AECI-1618: remove on objection. The reason field above is its required reason. */
  protected readonly confirmingObjection = signal(false);
  protected readonly objectionFailed = signal(false);
  protected readonly objectionDone = signal('');
  // AECI-2112: the console's form recipe and the shared field classes.
  protected readonly formClass = VENDOR_PANEL_FORM_CLASS;
  protected readonly fieldClass = VENDOR_FIELD_CLASS;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly noticeClass = CONSOLE_NOTICE_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  protected readonly actionsClass = VENDOR_ACTIONS_CLASS;
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly reasonInput = viewChild<ElementRef<HTMLTextAreaElement>>('reasonInput');
  private readonly sourceInput = viewChild<ElementRef<HTMLInputElement>>('sourceInput');
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
    // Skip the first, idle value: hosts start from "not saving".
    let first = true;
    effect(() => {
      const saving = this.saving();
      if (first) {
        first = false;
        return;
      }
      this.savingChange.emit(saving);
    });
    effect(() => {
      const id = this.recordId();
      const value = this.logoUrl() ?? '';
      if (id !== this.seededId || value !== untracked(this.baseline)) {
        this.seededId = id;
        this.confirmingObjection.set(false);
        this.objectionFailed.set(false);
        this.objectionDone.set('');
        this.baseline.set(value);
        this.draft.set(value);
        this.saved.set(false);
        this.reason.set('');
        this.internalNote.set('');
        this.reasonError.set(false);
        this.sourceUrl.set('');
        this.sourceError.set(null);
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

  protected onSourceInput(event: Event): void {
    this.sourceUrl.set((event.target as HTMLInputElement).value);
    if (this.sourceError()) this.sourceError.set(null);
  }

  /** The `sourceUrl` body key, or `undefined` after flagging a link that is not https. */
  private sourceBody(): { sourceUrl?: string } | undefined {
    const source = this.sourceUrl().trim();
    if (!source) return {};
    if (!isHttpsUrl(source)) {
      this.flagSource('invalid');
      return undefined;
    }
    return { sourceUrl: source };
  }

  private flagSource(problem: 'missing' | 'invalid'): void {
    this.sourceError.set(problem);
    this.sourceInput()?.nativeElement.focus();
  }

  /** The API's `400` naming `sourceUrl`: the record is vendor-held and needs a source. */
  private isSourceRefusal(err: unknown): boolean {
    if (!(err instanceof HttpErrorResponse) || err.status !== 400) return false;
    const inner = (err.error as { error?: { field?: unknown } } | null | undefined)?.error;
    return inner?.field === 'sourceUrl';
  }

  protected async save(): Promise<void> {
    if (this.saveDisabled()) return;
    const parsedReason = AdminReasonSchema.safeParse(this.reason());
    if (!parsedReason.success) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return;
    }
    const source = this.sourceBody();
    if (!source) return;
    const recordId = this.recordId();
    const logoUrl = this.draft().trim() || null;
    this.saving.set(true);
    this.failed.set(false);
    this.saved.set(false);
    this.objectionDone.set('');
    try {
      await firstValueFrom(
        this.http.patch(
          `/api/admin/${this.kind() === 'vendor' ? 'vendors' : 'products'}/${recordId}/logo`,
          {
            logo_url: logoUrl,
            ...source,
            ...overrideReasonBody(parsedReason.data, this.internalNote()),
          },
        ),
      );
      if (recordId !== this.recordId()) return;
      this.baseline.set(logoUrl ?? '');
      this.reason.set('');
      this.internalNote.set('');
      this.sourceUrl.set('');
      this.saved.set(true);
      this.logoSaved.emit(logoUrl);
      this.announce.emit($localize`:@@admin.logo.confirmation:Logo saved.`);
    } catch (err) {
      if (recordId !== this.recordId()) return;
      if (this.isSourceRefusal(err)) this.flagSource('missing');
      else {
        this.failed.set(true);
        // The disabled save drops focus: move it to the refusal (AECI-1994).
        this.focusAfterRender(this.fieldId('failed'));
      }
    } finally {
      this.saving.set(false);
    }
  }

  /** Opening the confirm focuses its warning, so it is heard before the buttons. */
  protected startObjection(): void {
    this.objectionFailed.set(false);
    this.confirmingObjection.set(true);
    this.focusAfterRender(this.fieldId('objection-warning'));
  }

  /**
   * Escape, from anywhere in the editor (AECI-2112).
   * - While a save or a removal is in flight: nothing closes. The request still
   *   commits and its `logoSaved` and announcement must reach the host, so the event
   *   stops here and a host dialog never sees it either.
   * - On the objection step: closes that step only, as its Cancel does.
   * - Otherwise: asks the host to close the editor.
   */
  protected onEscape(event: Event): void {
    if (this.saving()) {
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (this.confirmingObjection()) {
      event.stopPropagation();
      this.cancelObjection();
      return;
    }
    this.closeRequested.emit();
  }

  /** Cancel closes the confirm and gives focus back to "Remove on objection". */
  protected cancelObjection(): void {
    this.confirmingObjection.set(false);
    this.focusAfterRender(this.fieldId('objection-open'));
  }

  private focusAfterRender(id: string): void {
    afterNextRender(() => this.document.getElementById(id)?.focus(), { injector: this.injector });
  }

  /** `PATCH …/logo` with `objection: true`. It is its own write, so an unsaved draft in
   *  the field above is dropped, not saved. */
  protected async confirmObjection(): Promise<void> {
    if (this.saving()) return;
    const parsedReason = AdminReasonSchema.safeParse(this.reason());
    if (!parsedReason.success) {
      this.reasonError.set(true);
      this.reasonInput()?.nativeElement.focus();
      return;
    }
    const source = this.sourceBody();
    if (!source) return;
    const recordId = this.recordId();
    this.saving.set(true);
    this.objectionFailed.set(false);
    this.saved.set(false);
    try {
      const result = await firstValueFrom(
        this.http.patch<AdminUpdateLogoResponse>(
          `/api/admin/${this.kind() === 'vendor' ? 'vendors' : 'products'}/${recordId}/logo`,
          {
            logo_url: null,
            objection: true,
            ...source,
            ...overrideReasonBody(parsedReason.data, this.internalNote()),
          },
        ),
      );
      if (recordId !== this.recordId()) return;
      const message =
        result.object_removed === false
          ? $localize`:@@admin.logo.objection.doneKept:Logo removed. It will not return. The stored file stays, because another record uses it or the delete failed.`
          : $localize`:@@admin.logo.objection.done:Logo removed. It will not return, and the stored file is gone.`;
      this.baseline.set('');
      this.draft.set('');
      this.reason.set('');
      this.internalNote.set('');
      this.sourceUrl.set('');
      this.confirmingObjection.set(false);
      this.objectionDone.set(message);
      this.logoSaved.emit(null);
      this.announce.emit(message);
    } catch {
      if (recordId === this.recordId()) {
        this.objectionFailed.set(true);
        // The disabled confirm drops focus: move it to the refusal (AECI-1994).
        this.focusAfterRender(this.fieldId('objection-failed'));
      }
    } finally {
      this.saving.set(false);
    }
  }
}
