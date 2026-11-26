import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  TemplateRef,
  afterNextRender,
  computed,
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
import { CONSOLE_NOTICE_CLASS } from './console-detail';

let nextId = 0;

/**
 * The second, locked step of a two-step danger form (AECI-2104). Every string is
 * already localised by the caller. `body` is a string, or a template when the
 * sentence carries a value the caller's own `i18n` element interpolates.
 */
export interface AdminDangerConfirmStep {
  /** Step one's button ("Continue to removal"). A secondary button: it destroys nothing. */
  readonly continueLabel: string;
  /** The locked step's title ("Remove this review permanently?"). */
  readonly title: string;
  /** What the final press does, under the title. */
  readonly body: string | TemplateRef<unknown>;
  /** Back to step one with the reason kept ("Edit the reason"). */
  readonly editLabel: string;
}

/**
 * USAGE NOTES (AECI-1813, extended by AECI-2104). Read these, not the code.
 *
 * `<aec-admin-danger-action>` is the console's pattern for an inline destructive
 * action. The opener is a compact secondary button. It opens a form under it, in
 * this order: an optional Bone warning box, optional read-only facts, the reason's
 * label, its help, the reason, its error, an optional internal note (its label,
 * help and field, in the same order), the confirm, and a ghost Cancel. A danger
 * button appears only as the confirm that does the damage. The piece decides
 * nothing about who may act: render it only where the action was rendered before,
 * inside the same `@if`. Every string is an input, already localised.
 *
 * Inputs
 * - `openerLabel`, `confirmLabel`, `reasonLabel`, `reasonRequired` (required inputs).
 *   `reasonRequired` is shown when the confirm is pressed with an empty reason. Pass
 *   `null` only for a form whose reason is optional today (contests Decline, "Why
 *   you are declining (recommended)"): the field is not required and an empty
 *   reason emits `''`. It is a required input, so every caller states which.
 * - `warning`: what the action does, as a full sentence. Screen readers hear it
 *   first, because it leads the reason field's description. Leave it null only when
 *   today's form has no warning (the review queues' Reject).
 * - `reasonHelp`: a hint between the label and the field.
 * - `busy` and `busyLabel`: while `busy`, the confirm is disabled and reads
 *   `busyLabel` ("Rejecting…"), and a polite status line inside the form says it
 *   once. With no `busyLabel` the confirm keeps its label, as before.
 * - `maxLength` and `lengthMessage`: with both, a trimmed reason longer than
 *   `maxLength` is refused on confirm exactly like an empty one (nothing emitted,
 *   the message shown, the field focused). A form whose one message covers both
 *   rules ("between 1 and 500 characters") passes that message to both inputs.
 *   With `maxLength` alone, the field is hard-capped by the native `maxlength`
 *   attribute and there is nothing to say.
 * - `confirmStep`: makes the form two-step (see below).
 * - `error`: the parent's message for the last attempt. `errorTemplate`: the same
 *   for a message that holds a link. The template is rendered inside the one alert
 *   element, so write inline content only (text and `<a>`).
 * - `cancelLabel`: Cancel's words, when the form keeps its own message id.
 * - `openerDescribedBy`: the id of a sentence beside the opener that describes it.
 *   `openerDisabled`: the action is blocked. The opener stays focusable with
 *   `aria-disabled="true"` and does nothing, so a keyboard user still reaches it and
 *   hears the reason. Point `openerDescribedBy` at that reason.
 * - `noteLabel`, `noteHelp`, `noteMaxLength` and `[(note)]`: an optional internal
 *   note between the reason and the confirm, natively capped, never required. Read
 *   `note` in the `(confirmed)` handler, trimmed by you, blank meaning absent.
 * - Content marked `dangerFacts` is projected between the warning and the reason.
 *   Read-only text only ("3 open product proposals will be discarded"): a control
 *   inside it would submit the form on Enter.
 * - `open`: two-way. Outputs: `confirmed` (the trimmed reason), `cancelled`.
 *
 * Opening and closing
 * - Every open starts on step one with no refusal showing, however it opened.
 * - Cancel and Escape close the form, fire `(cancelled)` and discard the draft and
 *   the note. A close by the parent (success) discards them too.
 * - The opener toggles (`aria-expanded`). A close by the opener KEEPS the draft and
 *   the note, and reopening shows them: pressing it never throws typed text away.
 * - Focus returns to the opener on every close.
 * - While `busy` the form cannot close: the opener, Cancel, Escape and "Edit the
 *   reason" do nothing (Escape is still contained), and the form carries
 *   `aria-busy="true"`. They are not disabled, so focus is never dropped
 *   (DESIGN.md: a busy state does not set `aria-disabled`).
 *
 * Parent contract
 * - In the `(confirmed)` handler: clear `error` (and `errorTemplate`) to null and
 *   set `busy`, both synchronously. Clear them as well whenever you change `open`.
 * - `confirmed` fires once per attempt. A second press before the parent answers
 *   emits nothing. An attempt ends when `busy` clears, when an error arrives, or,
 *   for a parent that never went busy, once the press has rendered.
 * - On success set `open` to false. Focus returns to the opener.
 * - On failure clear `busy` and set `error` or `errorTemplate`. The form stays open
 *   and focus moves to the alert, even when the message is the same as last time.
 *
 * Two steps (`confirmStep`)
 * - Step one's button is secondary and reads `continueLabel`. It checks the reason
 *   (required, length) and emits nothing.
 * - Step two locks the reason (read-only, in place, still described by the warning)
 *   and shows a Bone box with the step's title, its body, the danger confirm
 *   (`confirmLabel`, then `busyLabel`), the edit action and Cancel. Focus moves to
 *   that box, which is named by its title and described by its body, so the
 *   operator hears what the press does before any button. Focus does not go to the
 *   danger button: a held or repeated Enter must not fire it.
 * - A parent error set before step two opened is not shown on step two, so an old
 *   failure never sits beside a new confirmation.
 * - The edit action returns to step one with the reason kept and focused.
 * - `confirmed` fires only from step two. A press that lands before step two has
 *   rendered emits nothing.
 * - A parent `error` while on step two keeps the operator on step two, with the
 *   reason still locked. Focus moves to the alert. They can press the confirm again
 *   or edit the reason.
 *
 * ```html
 * <aec-admin-danger-action
 *   [openerLabel]="removeLabel" [confirmLabel]="removeFinal" [busyLabel]="removing"
 *   [reasonLabel]="reasonLabel" [reasonHelp]="reasonHelp" [reasonRequired]="reasonMissing"
 *   [maxLength]="500" [confirmStep]="removeStep"
 *   [error]="error()" [busy]="busy()" [(open)]="removing" (confirmed)="remove($event)"
 * />
 * ```
 */
@Component({
  selector: 'aec-admin-danger-action',
  imports: [AecButton, NgTemplateOutlet],
  host: { class: 'block' },
  template: `
    <button
      #opener
      aecButton
      variant="secondary"
      compact
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="ids.form"
      [attr.aria-describedby]="openerDescribedBy()"
      [attr.aria-disabled]="openerDisabled() ? 'true' : null"
      (click)="toggle()"
    >
      {{ openerLabel() }}
    </button>

    <form
      [id]="ids.form"
      [hidden]="!open()"
      method="dialog"
      novalidate
      [attr.aria-busy]="busy() ? 'true' : null"
      class="mt-4 grid max-w-[36rem] gap-4 border-t border-(--border-default) pt-4"
      (submit)="submit($event)"
      (keydown.escape)="onEscape($event)"
    >
      @if (warning(); as text) {
        <p [id]="ids.warning" [class]="boneClass">{{ text }}</p>
      }
      <ng-content select="[dangerFacts]" />
      <div class="grid gap-2">
        <label [for]="ids.reason" [class]="labelClass">{{ reasonLabel() }}</label>
        @if (reasonHelp(); as text) {
          <p [id]="ids.help" class="text-t-14 text-(--text-secondary)">{{ text }}</p>
        }
        <textarea
          #reason
          [id]="ids.reason"
          rows="3"
          [required]="reasonRequired() !== null"
          [class]="inputClass"
          class="min-h-24 resize-y py-3 read-only:bg-(--surface-sunken)"
          [value]="draft()"
          [readOnly]="locked()"
          [attr.maxlength]="hardCap()"
          [attr.aria-invalid]="hasError() ? 'true' : null"
          [attr.aria-describedby]="describedBy()"
          (input)="onInput(reason.value)"
        ></textarea>
        @if (shownError(); as message) {
          <p #errorEl [id]="ids.error" role="alert" tabindex="-1" [class]="errorClass">
            {{ message }}
          </p>
        } @else if (parentTemplate(); as tpl) {
          <p #errorEl [id]="ids.error" role="alert" tabindex="-1" [class]="errorClass">
            <!-- One flex item: the error row is a flex line, so bare text and a link would split. -->
            <span><ng-container [ngTemplateOutlet]="tpl" /></span>
          </p>
        }
      </div>
      @if (noteLabel(); as label) {
        <div class="grid gap-2">
          <label [for]="ids.note" [class]="labelClass">{{ label }}</label>
          @if (noteHelp(); as text) {
            <p [id]="ids.noteHelp" class="text-t-14 text-(--text-secondary)">{{ text }}</p>
          }
          <textarea
            #noteEl
            [id]="ids.note"
            rows="2"
            [class]="inputClass"
            class="min-h-16 resize-y py-3 read-only:bg-(--surface-sunken)"
            [value]="note()"
            [readOnly]="locked()"
            [attr.maxlength]="noteMaxLength()"
            [attr.aria-describedby]="noteHelp() ? ids.noteHelp : null"
            (input)="note.set(noteEl.value)"
          ></textarea>
        </div>
      }
      @if (locked() && confirmStep(); as step) {
        <div
          #stepEl
          [id]="ids.step"
          role="group"
          tabindex="-1"
          [attr.aria-labelledby]="ids.stepTitle"
          [attr.aria-describedby]="ids.stepBody"
          [class]="boneClass"
          class="focus-visible:outline-3 focus-visible:outline-offset-3"
        >
          <p [id]="ids.stepTitle" class="font-semibold">{{ step.title }}</p>
          <div [id]="ids.stepBody" class="mt-2 max-w-prose">
            @if (bodyTemplate(step); as tpl) {
              <ng-container [ngTemplateOutlet]="tpl" />
            } @else {
              <p>{{ step.body }}</p>
            }
          </div>
          <div class="mt-4 flex flex-wrap gap-3">
            <button aecButton variant="danger" compact type="submit" [disabled]="busy()">
              {{ confirmText() }}
            </button>
            <button aecButton variant="secondary" compact (click)="edit()">
              {{ step.editLabel }}
            </button>
            <ng-container [ngTemplateOutlet]="cancelButton" />
          </div>
        </div>
      } @else {
        <div class="flex flex-wrap gap-3">
          @if (confirmStep(); as step) {
            <button aecButton variant="secondary" compact type="submit" [disabled]="busy()">
              {{ step.continueLabel }}
            </button>
          } @else {
            <button aecButton variant="danger" compact type="submit" [disabled]="busy()">
              {{ confirmText() }}
            </button>
          }
          <ng-container [ngTemplateOutlet]="cancelButton" />
        </div>
      }
      <span [id]="ids.status" role="status" class="sr-only">{{ busyAnnouncement() }}</span>
    </form>

    <ng-template #cancelButton>
      @if (cancelLabel(); as words) {
        <button aecButton variant="ghost" (click)="cancel()">{{ words }}</button>
      } @else {
        <button aecButton variant="ghost" (click)="cancel()" i18n="@@admin.console.cancel">
          Cancel
        </button>
      }
    </ng-template>
  `,
})
export class AdminDangerAction {
  /** The opener's label ("Suspend"), already localised. */
  readonly openerLabel = input.required<string>();
  /** The danger confirm's label ("Suspend and send the notice"). With `confirmStep`, step two's. */
  readonly confirmLabel = input.required<string>();
  /** What the action does, in the Bone box above the reason. Null: no box. */
  readonly warning = input<string | null>(null);
  readonly reasonLabel = input.required<string>();
  /** Shown when the confirm is pressed with an empty reason. */
  readonly reasonRequired = input.required<string | null>();
  readonly reasonHelp = input<string | null>(null);
  /** The parent's error for the last attempt. */
  readonly error = input<string | null>(null);
  /** The parent's error for the last attempt, as content that can hold a link. */
  readonly errorTemplate = input<TemplateRef<unknown> | null>(null);
  readonly busy = input(false);
  /** The confirm's label while `busy` ("Rejecting…"). Null keeps `confirmLabel`. */
  readonly busyLabel = input<string | null>(null);
  /** The longest trimmed reason. With `lengthMessage` a rule; without, a hard cap. */
  readonly maxLength = input<number | null>(null);
  /** Shown when the trimmed reason is longer than `maxLength`. */
  readonly lengthMessage = input<string | null>(null);
  /** A second, locked step before the danger confirm. */
  readonly confirmStep = input<AdminDangerConfirmStep | null>(null);
  /** Cancel's words. Null keeps the console's own "Cancel". */
  readonly cancelLabel = input<string | null>(null);
  /** The id of a sentence outside the piece that describes the opener. */
  readonly openerDescribedBy = input<string | null>(null);
  /** The action is blocked: the opener stays focusable but does nothing. Say why with `openerDescribedBy`. */
  readonly openerDisabled = input(false);
  /** An optional internal note under the reason. Null: no note field. */
  readonly noteLabel = input<string | null>(null);
  readonly noteHelp = input<string | null>(null);
  /** The note's native cap. */
  readonly noteMaxLength = input<number | null>(null);
  /** The note as typed, two-way. Cleared on open after a Cancel or a close by the parent. The caller trims it. */
  readonly note = model('');
  readonly open = model(false);
  /** The confirm pressed with a valid reason: the trimmed reason. */
  readonly confirmed = output<string>();
  readonly cancelled = output<void>();

  protected readonly draft = signal('');
  /** The reason's own refusal on the last confirm, until the operator fixes it. */
  protected readonly problem = signal<'missing' | 'long' | null>(null);
  /** On step two of a two-step form. */
  protected readonly locked = signal(false);
  /** One emit per attempt: set on confirm, cleared when the parent answers. */
  private inFlight = false;
  /** Step two takes presses only once it has rendered and taken focus. */
  private armed = false;
  /** Each emit is an attempt; a check after it renders ends it if the parent did not go busy. */
  private attempts = 0;
  /** The last close came from the opener, so the next open keeps the draft and the note. */
  private keepDraft = false;
  /** The parent's error predates step two, so step two does not show it. */
  private readonly staleError = signal(false);
  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
  protected readonly boneClass = CONSOLE_NOTICE_CLASS;

  private readonly n = nextId++;
  protected readonly ids = {
    form: `aec-danger-${this.n}-form`,
    warning: `aec-danger-${this.n}-warning`,
    reason: `aec-danger-${this.n}-reason`,
    help: `aec-danger-${this.n}-help`,
    error: `aec-danger-${this.n}-error`,
    step: `aec-danger-${this.n}-step`,
    stepTitle: `aec-danger-${this.n}-step-title`,
    stepBody: `aec-danger-${this.n}-step-body`,
    status: `aec-danger-${this.n}-status`,
    note: `aec-danger-${this.n}-note`,
    noteHelp: `aec-danger-${this.n}-note-help`,
  };

  protected readonly confirmText = computed(() => {
    const busyLabel = this.busyLabel();
    return this.busy() && busyLabel ? busyLabel : this.confirmLabel();
  });
  protected readonly busyAnnouncement = computed(() =>
    this.busy() && this.open() ? (this.busyLabel() ?? '') : '',
  );
  /** The native cap applies only when there is no message to explain a refusal. */
  protected readonly hardCap = computed(() => (this.lengthMessage() ? null : this.maxLength()));

  private readonly opener = viewChild.required<ElementRef<HTMLButtonElement>>('opener');
  private readonly reasonEl = viewChild.required<ElementRef<HTMLTextAreaElement>>('reason');
  private readonly errorEl = viewChild<ElementRef<HTMLElement>>('errorEl');
  private readonly stepEl = viewChild<ElementRef<HTMLElement>>('stepEl');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  constructor() {
    let wasOpen = false;
    effect(() => {
      const isOpen = this.open();
      untracked(() => {
        if (wasOpen && !isOpen) this.restoreFocus(false);
        if (!isOpen) this.leaveStepTwo();
        // Every open starts clean, however it opened. A close by the opener keeps the
        // draft and the note, so pressing it never throws typed text away.
        if (!wasOpen && isOpen) {
          if (!this.keepDraft) {
            this.draft.set('');
            this.note.set('');
          }
          this.problem.set(null);
          this.staleError.set(false);
          this.keepDraft = false;
        }
        wasOpen = isOpen;
        this.inFlight = false;
      });
    });
    // The parent answered with a new error: it ends the attempt and is shown on either step.
    effect(() => {
      const error = this.error() || this.errorTemplate();
      untracked(() => {
        this.staleError.set(false);
        if (error && this.open()) {
          this.inFlight = false;
          this.focusError();
        }
      });
    });
    // Busy clearing ends the attempt too. An error left from it is this attempt's answer.
    let wasBusy = false;
    effect(() => {
      const busy = this.busy();
      untracked(() => {
        if (!busy) this.inFlight = false;
        if (wasBusy && !busy && this.open() && (this.error() || this.errorTemplate())) {
          this.staleError.set(false);
          this.focusError();
        }
        wasBusy = busy;
      });
    });
  }

  /** Escape inside the open form is Cancel, on either step. */
  protected onEscape(event: Event): void {
    event.stopPropagation();
    this.cancel();
  }

  /** The parent's string, unless it predates step two. */
  protected parentError(): string | null {
    return this.staleError() ? null : this.error();
  }

  /** The parent's template, when no string error is shown. */
  protected parentTemplate(): TemplateRef<unknown> | null {
    return this.staleError() || this.error() ? null : this.errorTemplate();
  }

  protected bodyTemplate(step: AdminDangerConfirmStep): TemplateRef<unknown> | null {
    return step.body instanceof TemplateRef ? step.body : null;
  }

  /** The reason's own refusal first, then the parent's string. `errorTemplate` shows when both are null. */
  protected shownError(): string | null {
    const problem = this.problem();
    if (problem === 'missing') return this.reasonRequired();
    if (problem === 'long') return this.lengthMessage();
    return this.parentError();
  }

  protected hasError(): boolean {
    return this.problem() !== null || !!this.parentError() || !!this.parentTemplate();
  }

  protected describedBy(): string | null {
    // The warning first: opening moves focus straight to this field, past the box.
    const ids = [
      this.warning() ? this.ids.warning : null,
      this.reasonHelp() ? this.ids.help : null,
      this.hasError() ? this.ids.error : null,
    ];
    return ids.filter(Boolean).join(' ') || null;
  }

  protected onInput(value: string): void {
    this.draft.set(value);
    this.inFlight = false;
    // The refusal clears once it no longer applies. A new one waits for the next confirm.
    const problem = this.problem();
    if (problem && this.check(value.trim()) !== problem) this.problem.set(null);
  }

  protected toggle(): void {
    if (this.openerDisabled()) return;
    if (this.open()) {
      // A running request keeps its form, so its answer has somewhere to show.
      if (this.busy()) return;
      this.keepDraft = true;
      this.open.set(false);
      return;
    }
    this.open.set(true);
    afterNextRender(() => this.reasonEl().nativeElement.focus(), { injector: this.injector });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || this.inFlight) return;
    const reason = this.draft().trim();
    const problem = this.check(reason);
    if (problem) {
      this.problem.set(problem);
      this.reasonEl().nativeElement.focus();
      return;
    }
    if (this.confirmStep()) {
      if (!this.locked()) {
        this.enterStepTwo();
        return;
      }
      if (!this.armed) return;
    }
    this.inFlight = true;
    const attempt = ++this.attempts;
    this.confirmed.emit(reason);
    // A parent that answers in its handler without going busy (a refusal that sets
    // the same error again) changes no input, so no effect sees it. Settle here.
    afterNextRender(
      () => {
        if (attempt !== this.attempts || this.busy()) return;
        this.inFlight = false;
        if (this.open() && (this.error() || this.errorTemplate())) {
          this.staleError.set(false);
          this.focusError();
        }
      },
      { injector: this.injector },
    );
  }

  /** Step two's edit action: back to step one, the reason kept and focused. A no-op while busy. */
  protected edit(): void {
    if (this.busy()) return;
    this.inFlight = false;
    this.leaveStepTwo();
    afterNextRender(() => this.reasonEl().nativeElement.focus(), { injector: this.injector });
  }

  /** Cancel and Escape discard the draft. A no-op while busy: the request is running. */
  protected cancel(): void {
    if (this.busy()) return;
    this.keepDraft = false;
    this.open.set(false);
    this.cancelled.emit();
    this.restoreFocus(true);
  }

  private check(reason: string): 'missing' | 'long' | null {
    if (!reason) return this.reasonRequired() === null ? null : 'missing';
    const max = this.maxLength();
    if (max !== null && this.lengthMessage() && reason.length > max) return 'long';
    return null;
  }

  private focusError(): void {
    afterNextRender(() => this.errorEl()?.nativeElement.focus(), { injector: this.injector });
  }

  private enterStepTwo(): void {
    // An old failure must not sit beside a new confirmation.
    if (this.error() || this.errorTemplate()) this.staleError.set(true);
    this.locked.set(true);
    this.armed = false;
    afterNextRender(
      () => {
        if (!this.locked()) return;
        this.stepEl()?.nativeElement.focus();
        this.armed = true;
      },
      { injector: this.injector },
    );
  }

  private leaveStepTwo(): void {
    this.locked.set(false);
    this.armed = false;
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
