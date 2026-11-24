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
 * The console's inline control form (AECI-1813, mock-up 14, the vendor Billing
 * tab's "Account" panel). One editable fact on one row: its label (14rem), its
 * value, and a compact secondary "Change". Change opens a form under the row:
 * the label, the field (at most 32rem), the error, the help, then a compact
 * primary Save and a ghost Cancel.
 *
 * ```html
 * <aec-admin-inline-control
 *   [label]="billingEmailLabel" [help]="billingEmailHelp" type="email"
 *   [value]="vendor.billing_email ?? ''" [error]="saveError()" [busy]="saving()"
 *   [(open)]="editingEmail" (saved)="saveEmail($event)"
 * >{{ vendor.billing_email }}</aec-admin-inline-control>
 * ```
 *
 * The projected content is the value as the row shows it. `value` is what the
 * field starts with each time it opens. The parent owns the write: on `saved` it
 * calls the API, and on success it sets `open` to false. On a failure it sets
 * `error` and leaves the form open.
 *
 * Focus: Change moves focus into the field once the form renders. Cancel, and a
 * close by the parent, return it to Change. The help's id is in the field's
 * `aria-describedby` from first render. The error's id joins it while it shows.
 * Several rows stack into a list: the first row's top hairline comes from
 * `:first-of-type`, so put them in one wrapper with nothing else of their kind.
 */
@Component({
  selector: 'aec-admin-inline-control',
  imports: [AecButton],
  host: {
    class:
      'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 border-b border-(--border-default) py-2 first-of-type:border-t md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]',
  },
  template: `
    <span [id]="ids.label" [class]="labelClass" class="max-md:col-span-full">{{ label() }}</span>
    <span class="min-w-0 break-words text-t-16 text-(--text-primary)"><ng-content /></span>
    <button
      #change
      aecButton
      variant="secondary"
      compact
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="ids.form"
      (click)="toggle()"
    >
      <ng-container i18n="@@admin.console.inlineControl.change"
        >Change <span class="sr-only">{{ label() }}</span></ng-container
      >
    </button>

    <form
      [id]="ids.form"
      [hidden]="!open()"
      novalidate
      class="col-span-full grid max-w-[32rem] gap-2 pb-4 pt-2"
      (submit)="submit($event)"
    >
      <label [for]="ids.field" [class]="labelClass">{{ label() }}</label>
      <input
        #field
        [id]="ids.field"
        [type]="type()"
        [class]="inputClass"
        [value]="draft()"
        [attr.aria-invalid]="error() ? 'true' : null"
        [attr.aria-describedby]="describedBy()"
        (input)="draft.set(field.value)"
      />
      @if (error(); as message) {
        <p [id]="ids.error" role="alert" [class]="errorClass">{{ message }}</p>
      }
      @if (help(); as text) {
        <p [id]="ids.help" class="text-t-14 text-(--text-secondary)">{{ text }}</p>
      }
      <div class="mt-2 flex flex-wrap gap-3">
        <button aecButton type="submit" compact [disabled]="busy()" i18n="@@admin.console.save">
          Save
        </button>
        <button aecButton variant="ghost" (click)="cancel()" i18n="@@admin.console.cancel">
          Cancel
        </button>
      </div>
    </form>
  `,
})
export class AdminInlineControl {
  /** The fact's name, already localised. Labels the row and the field. */
  readonly label = input.required<string>();
  /** Persistent help under the field, already localised. */
  readonly help = input<string | null>(null);
  /** What the field holds each time it opens. */
  readonly value = input('');
  readonly type = input<'text' | 'email' | 'url' | 'tel'>('text');
  /** The parent's error for the last save, already localised. */
  readonly error = input<string | null>(null);
  /** A save is in flight: Save disables. */
  readonly busy = input(false);
  /** Whether the form is open. The parent closes it after a successful save. */
  readonly open = model(false);
  /** Save pressed: the field's value. */
  readonly saved = output<string>();
  /** Cancel pressed. */
  readonly cancelled = output<void>();

  protected readonly draft = signal('');
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;

  private readonly n = nextId++;
  protected readonly ids = {
    label: `aec-ictl-${this.n}-label`,
    form: `aec-ictl-${this.n}-form`,
    field: `aec-ictl-${this.n}-field`,
    help: `aec-ictl-${this.n}-help`,
    error: `aec-ictl-${this.n}-error`,
  };

  private readonly changeButton = viewChild.required<ElementRef<HTMLButtonElement>>('change');
  private readonly fieldEl = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    // A close from the parent (after a save) returns focus to Change when focus
    // was in the form, or was lost to the body when the form hid.
    let wasOpen = false;
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (wasOpen && !isOpen) this.restoreFocus(false);
        wasOpen = isOpen;
      });
    });
  }

  protected describedBy(): string | null {
    const ids = [this.help() ? this.ids.help : null, this.error() ? this.ids.error : null];
    return ids.filter(Boolean).join(' ') || null;
  }

  protected toggle(): void {
    if (this.open()) {
      this.open.set(false);
      return;
    }
    this.draft.set(this.value());
    this.open.set(true);
    afterNextRender(() => this.fieldEl().nativeElement.focus(), { injector: this.injector });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy()) return;
    this.saved.emit(this.draft());
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
        if (always || lost || host.contains(active)) this.changeButton().nativeElement.focus();
      },
      { injector: this.injector },
    );
  }
}
