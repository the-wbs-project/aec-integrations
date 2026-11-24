import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  model,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';

let nextId = 0;

/**
 * The console's danger pattern (AECI-1813, ruled 2026-11-24: "The opener is a
 * secondary button. The danger button is the confirm inside the form"). A
 * destructive action never fires from one press. The opener is a compact
 * secondary button. It opens a form under it: a Bone warning box, a required
 * reason, the danger confirm and a ghost Cancel.
 *
 * ```html
 * <aec-admin-danger-action
 *   [openerLabel]="suspendLabel" [confirmLabel]="suspendConfirm" [warning]="suspendWarning"
 *   [reasonLabel]="reasonLabel" [reasonHelp]="reasonHelp" [reasonRequired]="reasonRequired"
 *   [error]="error()" [busy]="busy()" [(open)]="suspending" (confirmed)="suspend($event)"
 * />
 * ```
 *
 * Every string comes from the caller, already localised, except Cancel. A press
 * of the confirm with an empty reason shows `reasonRequired`, focuses the field
 * and emits nothing. Otherwise it emits the trimmed reason, once per attempt: a
 * second press before the parent answers emits nothing. The parent owns the write:
 * it sets `busy` in its handler and clears `error` to null at the start of each
 * attempt; on success it sets `open` to false, on failure it sets `error` and
 * leaves the form open. The pattern decides nothing about who may act.
 *
 * Focus: opening focuses the reason field, whose `aria-describedby` names the
 * warning first, then the help, then the error, so a screen reader hears the
 * warning before typing. Cancel, Escape inside the form, and a close by the parent
 * return focus to the opener. An `error` from the parent takes focus, because a
 * disabled confirm drops it to the page body.
 */
@Component({
  selector: 'aec-admin-danger-action',
  imports: [AecButton],
  host: { class: 'block' },
  template: `
    <button
      #opener
      aecButton
      variant="secondary"
      compact
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="ids.form"
      (click)="toggle()"
    >
      {{ openerLabel() }}
    </button>

    <form
      [id]="ids.form"
      [hidden]="!open()"
      method="dialog"
      novalidate
      class="mt-4 grid max-w-[36rem] gap-4 border-t border-(--border-default) pt-4"
      (submit)="submit($event)"
      (keydown.escape)="onEscape($event)"
    >
      <p
        [id]="ids.warning"
        class="rounded-control border border-(--border-strong) bg-(--accent-warm) p-4 text-t-14 text-(--text-primary)"
      >
        {{ warning() }}
      </p>
      <div class="grid gap-2">
        <label [for]="ids.reason" [class]="labelClass">{{ reasonLabel() }}</label>
        <textarea
          #reason
          [id]="ids.reason"
          rows="3"
          required
          [class]="inputClass"
          class="min-h-24 resize-y py-3"
          [value]="draft()"
          [attr.aria-invalid]="shownError() ? 'true' : null"
          [attr.aria-describedby]="describedBy()"
          (input)="onInput(reason.value)"
        ></textarea>
        @if (shownError(); as message) {
          <p #errorEl [id]="ids.error" role="alert" tabindex="-1" [class]="errorClass">
            {{ message }}
          </p>
        }
        @if (reasonHelp(); as text) {
          <p [id]="ids.help" class="text-t-14 text-(--text-secondary)">{{ text }}</p>
        }
      </div>
      <div class="flex flex-wrap gap-3">
        <button aecButton variant="danger" compact type="submit" [disabled]="busy()">
          {{ confirmLabel() }}
        </button>
        <button aecButton variant="ghost" (click)="cancel()" i18n="@@admin.console.cancel">
          Cancel
        </button>
      </div>
    </form>
  `,
})
export class AdminDangerAction {
  /** The opener's label ("Suspend"), already localised. */
  readonly openerLabel = input.required<string>();
  /** The danger confirm's label ("Suspend and send the notice"). */
  readonly confirmLabel = input.required<string>();
  /** What the action does, in the Bone box above the reason. */
  readonly warning = input.required<string>();
  readonly reasonLabel = input.required<string>();
  /** Shown when the confirm is pressed with an empty reason. */
  readonly reasonRequired = input.required<string>();
  readonly reasonHelp = input<string | null>(null);
  /** The parent's error for the last attempt. */
  readonly error = input<string | null>(null);
  readonly busy = input(false);
  readonly open = model(false);
  /** The confirm pressed with a reason: the trimmed reason. */
  readonly confirmed = output<string>();
  readonly cancelled = output<void>();

  protected readonly draft = signal('');
  private readonly missing = signal(false);
  /** One emit per attempt: set on confirm, cleared when the parent answers. */
  private inFlight = false;
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;

  private readonly n = nextId++;
  protected readonly ids = {
    form: `aec-danger-${this.n}-form`,
    warning: `aec-danger-${this.n}-warning`,
    reason: `aec-danger-${this.n}-reason`,
    help: `aec-danger-${this.n}-help`,
    error: `aec-danger-${this.n}-error`,
  };

  private readonly opener = viewChild.required<ElementRef<HTMLButtonElement>>('opener');
  private readonly reasonEl = viewChild.required<ElementRef<HTMLTextAreaElement>>('reason');
  private readonly errorEl = viewChild<ElementRef<HTMLElement>>('errorEl');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    let wasOpen = false;
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (wasOpen && !isOpen) this.restoreFocus(false);
        wasOpen = isOpen;
        this.inFlight = false;
      });
    });
    // The parent answered: a new error, or busy clearing. Either ends the attempt.
    effect(() => {
      const error = this.error();
      const busy = this.busy();
      untracked(() => {
        if (!busy) this.inFlight = false;
        if (error && this.open()) {
          this.inFlight = false;
          afterNextRender(() => this.errorEl()?.nativeElement.focus(), {
            injector: this.injector,
          });
        }
      });
    });
  }

  /** Escape inside the open form is Cancel. */
  protected onEscape(event: Event): void {
    event.stopPropagation();
    this.cancel();
  }

  protected shownError(): string | null {
    return this.missing() ? this.reasonRequired() : this.error();
  }

  protected describedBy(): string | null {
    // The warning first: opening moves focus straight to this field, past the box.
    const ids = [
      this.ids.warning,
      this.reasonHelp() ? this.ids.help : null,
      this.shownError() ? this.ids.error : null,
    ];
    return ids.filter(Boolean).join(' ') || null;
  }

  protected onInput(value: string): void {
    this.draft.set(value);
    this.inFlight = false;
    if (value.trim()) this.missing.set(false);
  }

  protected toggle(): void {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.draft.set('');
    this.missing.set(false);
    this.open.set(true);
    afterNextRender(() => this.reasonEl().nativeElement.focus(), { injector: this.injector });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || this.inFlight) return;
    const reason = this.draft().trim();
    if (!reason) {
      this.missing.set(true);
      this.reasonEl().nativeElement.focus();
      return;
    }
    this.inFlight = true;
    this.confirmed.emit(reason);
  }

  protected cancel(): void {
    this.open.set(false);
    this.cancelled.emit();
    this.restoreFocus(true);
  }

  private restoreFocus(always: boolean): void {
    afterNextRender(
      () => {
        const host = this.host.nativeElement;
        const active = host.ownerDocument.activeElement;
        const lost = active === null || active === host.ownerDocument.body;
        if (always || lost || host.contains(active)) this.opener().nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
}
