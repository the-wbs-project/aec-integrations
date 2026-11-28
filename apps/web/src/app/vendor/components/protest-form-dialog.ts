import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
} from '@spartan-ng/brain/dialog';

import { isHttpUrl } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import {
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
} from '../../shared/form-field/form-field-classes';
import { AecFormSubmit } from '../../shared/form-field/form-submit';
import { AecIcon } from '../../shared/icon/icon';

/** What the dialog sends: the trimmed text and the non-empty links. */
export interface ProtestFormValue {
  readonly text: string;
  readonly evidence_urls: string[];
}

/**
 * The one form behind a review request to AEC Integrations and the owner's one reply
 * to it (AECI-2110, `DESIGN.md` "The Detached-Form Rule"), for field contests
 * (`vendor-contest-protest.ts`) and Sync Service data flow reports
 * (`vendor-pair-protest.ts`). A required text and up to three links, in a modal.
 *
 * The model is the logo dialog (`vendor-logo-field.ts`): a Spartan `BrnDialog` that
 * opens on its title, cannot be dismissed while it sends, and closes on success. The
 * host does the write. It calls {@link succeed} with the sentence to announce, or
 * {@link fail} with the refusal to show inside the dialog. The announcement is emitted
 * from `closed`, after the CDK lifts `aria-hidden` from the app root, so the portal's
 * live region can read it (AECI-2126). Escape, the backdrop, Cancel and the close
 * button discard the draft. `open()` runs from a click only (NG0602).
 */
@Component({
  selector: 'aec-protest-form-dialog',
  imports: [
    BrnDialog,
    BrnDialogContent,
    BrnDialogClose,
    BrnDialogTitle,
    BrnDialogDescription,
    AecButton,
    AecFormSubmit,
    AecIcon,
  ],
  template: `
    <brn-dialog
      [role]="'alertdialog'"
      [autoFocus]="'first-heading'"
      [disableClose]="busy()"
      (closed)="onClosed()"
    >
      <ng-template brnDialogContent>
        <div class="aec-dialog max-h-[85vh] w-[min(92vw,34rem)] overflow-y-auto p-6 md:p-8">
          <div class="flex items-start justify-between gap-4">
            <h2
              brnDialogTitle
              tabindex="-1"
              class="rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
            >
              {{ heading() }}
            </h2>
            <button
              aecButton
              variant="ghost"
              iconOnly
              brnDialogClose
              type="button"
              [disabled]="busy()"
              class="-me-3 -mt-2 shrink-0"
              i18n-aria-label="@@vendor.protestDialog.close"
              aria-label="Close"
            >
              <aec-icon name="x" decorative />
            </button>
          </div>
          <div
            brnDialogDescription
            class="mt-2 space-y-2 text-sm leading-relaxed text-(--text-secondary)"
          >
            @for (line of description(); track $index) {
              <p>{{ line }}</p>
            }
          </div>

          <form method="dialog" class="mt-6 space-y-4" (aecSubmit)="submit()" novalidate>
            <div class="space-y-1">
              <label [for]="ids.text" [class]="labelClass">{{ label() }}</label>
              <textarea
                [id]="ids.text"
                rows="4"
                maxlength="2000"
                required
                [value]="text()"
                (input)="setText($event)"
                [attr.aria-invalid]="textError() ? 'true' : null"
                [class]="inputClass"
              ></textarea>
            </div>
            <fieldset class="space-y-2">
              <legend [class]="labelClass" i18n="@@vendor.protestDialog.links.legend">
                Supporting links
              </legend>
              <p class="text-xs text-(--text-secondary)" i18n="@@vendor.protestDialog.links.hint">
                Optional. Up to three.
              </p>
              @for (url of links(); track $index) {
                <div class="flex flex-wrap items-center gap-2">
                  <label
                    [for]="ids.link + $index"
                    class="sr-only"
                    i18n="@@vendor.protestDialog.links.label"
                    >Link {{ $index + 1 }}</label
                  >
                  <input
                    [id]="ids.link + $index"
                    type="url"
                    inputmode="url"
                    [value]="url"
                    (input)="setLink($index, $event)"
                    placeholder="https://"
                    [attr.aria-invalid]="linkInvalid(url) ? 'true' : null"
                    [class]="inputClass"
                    class="flex-1"
                  />
                  <button
                    aecButton
                    variant="secondary"
                    compact
                    type="button"
                    (click)="removeLink($index)"
                    i18n="@@vendor.protestDialog.links.remove"
                  >
                    Remove <span class="sr-only">link {{ $index + 1 }}</span>
                  </button>
                </div>
              }
              @if (links().length < maxLinks()) {
                <button
                  aecButton
                  variant="secondary"
                  compact
                  type="button"
                  (click)="addLink()"
                  i18n="@@vendor.protestDialog.links.add"
                >
                  Add a link
                </button>
              }
            </fieldset>

            @if (error(); as message) {
              <p role="alert" [class]="errorClass">{{ message }}</p>
            }

            <div class="flex flex-wrap justify-end gap-3 pt-2">
              <button
                aecButton
                variant="secondary"
                brnDialogClose
                type="button"
                [disabled]="busy()"
                i18n="@@vendor.protestDialog.cancel"
              >
                Cancel
              </button>
              <button aecButton type="submit" [disabled]="busy()">
                @if (busy()) {
                  <span i18n="@@vendor.protestDialog.sending">Sending…</span>
                } @else {
                  {{ sendLabel() }}
                }
              </button>
            </div>
          </form>
        </div>
      </ng-template>
    </brn-dialog>
  `,
  styles: [':host { display: contents; }'],
})
export class ProtestFormDialog {
  /** Unique per host row, so two dialogs on a page never share element ids. */
  readonly idPrefix = input.required<string>();
  readonly heading = input.required<string>();
  /** The paragraphs under the title: why it is asked, what happens, the deadline. */
  readonly description = input.required<readonly string[]>();
  readonly label = input.required<string>();
  readonly sendLabel = input.required<string>();
  /** The refusal shown when the text is empty. */
  readonly requiredMessage = input.required<string>();
  readonly maxLinks = input(3);

  /** A valid body: the host writes, then calls {@link succeed} or {@link fail}. */
  readonly send = output<ProtestFormValue>();
  /** The success sentence, emitted once the dialog has closed and the page is readable. */
  readonly announce = output<string>();

  private readonly dialog = viewChild(BrnDialog);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private pendingAnnouncement = '';
  /** Resolvers for the promises `succeed()` and `abandon()` return. */
  private closeWaiters: Array<() => void> = [];

  constructor() {
    // A row that re-renders under an open dialog destroys it before `closed` fires.
    // Release any waiting host so its refetch still runs.
    this.destroyRef.onDestroy(() => this.releaseWaiters());
  }

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly text = signal('');
  protected readonly links = signal<readonly string[]>([]);
  protected readonly textError = signal(false);

  protected get ids() {
    const p = this.idPrefix();
    return { text: `${p}-text`, link: `${p}-link-` };
  }

  /** Called from a click handler only. */
  open(): void {
    this.reset();
    this.pendingAnnouncement = '';
    this.dialog()?.open();
  }

  /**
   * The write landed: close, then announce `sentence`. Resolves once the dialog has
   * closed and announced. The host refetches only then: a refetch that lands first
   * re-renders the row, destroys this dialog and loses the announcement.
   */
  succeed(sentence: string): Promise<void> {
    this.busy.set(false);
    this.pendingAnnouncement = sentence;
    return this.closeAfterRender();
  }

  /** The write was refused: keep the draft and say why. */
  fail(message: string): void {
    this.busy.set(false);
    this.error.set(message);
  }

  /** The write was refused and the row moved: close without announcing. Resolves
   *  once the dialog has closed. */
  abandon(): Promise<void> {
    this.busy.set(false);
    return this.closeAfterRender();
  }

  protected onClosed(): void {
    this.reset();
    const pending = this.pendingAnnouncement;
    this.pendingAnnouncement = '';
    if (pending) this.announce.emit(pending);
    this.releaseWaiters();
  }

  private closeAfterRender(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    // `disableClose` reaches the open dialog through an effect, so close after the
    // render that lifts it (the logo dialog's rule).
    afterNextRender(() => this.dialog()?.close(), { injector: this.injector });
    return closed;
  }

  private releaseWaiters(): void {
    const waiters = this.closeWaiters;
    this.closeWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  protected setText(event: Event): void {
    this.text.set((event.target as HTMLTextAreaElement).value);
    if (this.textError()) this.textError.set(false);
  }

  protected addLink(): void {
    if (this.links().length >= this.maxLinks()) return;
    this.links.update((current) => [...current, '']);
    const id = `${this.ids.link}${this.links().length - 1}`;
    afterNextRender(() => this.document.getElementById(id)?.focus(), {
      injector: this.injector,
    });
  }

  protected removeLink(index: number): void {
    this.links.update((current) => current.filter((_, i) => i !== index));
  }

  protected setLink(index: number, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.links.update((current) => current.map((u, i) => (i === index ? value : u)));
  }

  protected linkInvalid(url: string): boolean {
    const trimmed = url.trim();
    return trimmed !== '' && !isHttpUrl(trimmed);
  }

  protected submit(): void {
    if (this.busy()) return;
    this.error.set(null);
    const text = this.text().trim();
    const evidence = this.links()
      .map((u) => u.trim())
      .filter((u) => u !== '');
    if (text === '') {
      this.textError.set(true);
      this.error.set(this.requiredMessage());
      afterNextRender(() => this.document.getElementById(this.ids.text)?.focus(), {
        injector: this.injector,
      });
      return;
    }
    if (evidence.some((u) => !isHttpUrl(u))) {
      this.error.set(
        $localize`:@@vendor.protestDialog.error.link:Each link must be a full web address that starts with http:// or https://.`,
      );
      return;
    }
    this.busy.set(true);
    this.send.emit({ text, evidence_urls: evidence });
  }

  private reset(): void {
    this.busy.set(false);
    this.error.set(null);
    this.text.set('');
    this.links.set([]);
    this.textError.set(false);
  }

  protected readonly labelClass = FIELD_LABEL_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly errorClass = FIELD_ERROR_CLASS;
}
