import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import type { ContextDirection, VendorClaim, VendorIntegration } from '@aeci/shared';

import {
  dataSentence,
  directionShort,
  myAnswer,
  myNote,
  noteAudience,
} from './integration-detail-model';
import { IntegrationDetailState, noteRequiredMessage } from './integration-detail-state';
import {
  ALERT,
  BTN_PRIMARY,
  BTN_SECONDARY,
  HELP,
  ID_STYLES,
  LABEL,
} from './integration-detail-styles';
import { VendorTip } from './vendor-tip';

let nextId = 0;

/** The attestation note's ceiling (`attestationNote`, `vendor-attestations.ts`). */
const NOTE_MAX = 2000;

type WrongKind = 'not-shared' | 'direction' | 'other';

/**
 * The reason that goes with an answer on one row of data (§6.17.4).
 *
 * - `no`: "What's wrong?", the right direction when that is the choice, and a
 *   required reason. **For v1 the choice is folded into the note** (ruled
 *   2026-09-28): nothing structured is stored, the choice decides the flow, and the
 *   stored note is the reason text verbatim.
 * - `yes`: an optional note, offered when the other company said No, and when a
 *   company adds or edits its reason on a Yes.
 *
 * The answer changes only on Save. "The direction is wrong" is two writes, shown as
 * one outcome ({@link IntegrationDetailState.directionWrong}). Opening focuses the
 * first radio (or the textarea for a Yes); closing hands focus back through
 * `closed`, which the host routes to the row's control.
 */
@Component({
  selector: 'aec-integration-answer-form',
  imports: [VendorTip],
  styles: [ID_STYLES],
  template: `
    <form
      class="id-well space-y-3 p-4 text-sm"
      [attr.aria-labelledby]="id + '-title'"
      (submit)="save($event)"
      data-testid="answer-form"
    >
      <p [id]="id + '-title'" class="id-h4">
        @if (mode() === 'no') {
          <span i18n="@@vendor.im.answer.whyWrong">Why is this wrong?</span>
        } @else {
          <span i18n="@@vendor.im.answer.addNote">A note with your answer</span>
        }
        <span class="block font-normal text-(--text-secondary)">{{ subject() }}</span>
      </p>

      @if (mode() === 'no') {
        <fieldset>
          <legend [class]="label" i18n="@@vendor.im.answer.whatsWrong">What's wrong?</legend>
          <div class="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
            @for (k of kinds; track k.value; let first = $first) {
              <label
                class="inline-flex min-h-6 cursor-pointer items-center gap-2 text-(--text-primary)"
              >
                <input
                  #kindInput
                  type="radio"
                  [name]="id + '-kind'"
                  [value]="k.value"
                  [checked]="kind() === k.value"
                  (change)="kind.set(k.value)"
                  class="h-4 w-4 accent-(--accent-primary)"
                  [attr.data-first]="first ? 'true' : null"
                />
                {{ k.label }}
              </label>
            }
          </div>
        </fieldset>
        @if (kind() === 'direction') {
          <div>
            <label [for]="id + '-dir'" [class]="label" i18n="@@vendor.im.answer.rightDirection"
              >The right direction</label
            >
            <select
              [id]="id + '-dir'"
              class="id-input mt-1 max-w-xs"
              (change)="right.set(asDirection($event))"
            >
              @for (d of otherDirections(); track d) {
                <option [value]="d" [selected]="right() === d">{{ directionText(d) }}</option>
              }
            </select>
          </div>
        }
      }

      <div>
        <label [for]="id + '-note'" [class]="label">
          @if (mode() === 'no') {
            <span i18n="@@vendor.im.answer.reason">Reason</span>
            <span class="font-normal text-(--text-secondary)" i18n="@@vendor.im.answer.required">
              (required)</span
            >
          } @else {
            <span i18n="@@vendor.im.answer.note">Note</span>
            <span class="font-normal text-(--text-secondary)" i18n="@@vendor.im.answer.optional">
              (optional)</span
            >
          }
        </label>
        <textarea
          #noteField
          [id]="id + '-note'"
          rows="3"
          class="id-input mt-1"
          [attr.maxlength]="max"
          [attr.aria-describedby]="id + '-help' + (error() ? ' ' + id + '-error' : '')"
          [attr.aria-invalid]="error() ? 'true' : null"
          [attr.aria-required]="mode() === 'no' ? 'true' : null"
          [value]="note()"
          (input)="note.set(textValue($event))"
        ></textarea>
        <p [id]="id + '-help'" [class]="help">{{ audience() }}</p>
      </div>

      <div class="flex items-center gap-1 text-(--text-secondary)" data-testid="versions-soon">
        <span
          ><span class="font-semibold" i18n="@@vendor.im.answer.versions">Versions:</span>
          <span i18n="@@vendor.im.answer.comingSoon"> coming soon</span></span
        >
        <aec-vendor-tip [label]="versionsLabel" [lines]="[versionsTip()]" />
      </div>

      @if (error()) {
        <p [id]="id + '-error'" role="alert" [class]="alert">{{ error() }}</p>
      }
      @if (partial()) {
        <div role="alert" class="space-y-2">
          <p [class]="alert" i18n="@@vendor.im.answer.partial">
            Your No was saved. The corrected row was not added.
          </p>
          <button type="button" [class]="secondary" [disabled]="busy()" (click)="retryCorrected()">
            <span i18n="@@vendor.im.answer.retryCorrected">Add the corrected row</span>
          </button>
        </div>
      }

      <div class="flex flex-wrap gap-3">
        <button type="submit" [class]="primary" [disabled]="busy()" data-testid="answer-save">
          <span i18n="@@vendor.im.answer.save">Save</span>
        </button>
        <button
          type="button"
          [class]="secondary"
          [disabled]="busy()"
          (click)="closed.emit()"
          i18n="@@vendor.im.answer.cancel"
        >
          Cancel
        </button>
      </div>
    </form>
  `,
})
export class IntegrationAnswerForm {
  private readonly state = inject(IntegrationDetailState);

  readonly integration = input.required<VendorIntegration>();
  readonly claim = input.required<VendorClaim>();
  /** The answer this form saves. */
  readonly mode = input.required<'yes' | 'no'>();
  /** The form is done: saved or cancelled. */
  readonly closed = output<void>();

  protected readonly id = `answer-form-${++nextId}`;
  protected readonly max = NOTE_MAX;
  protected readonly kinds: readonly { value: WrongKind; label: string }[] = [
    {
      value: 'not-shared',
      label: $localize`:@@vendor.im.answer.kind.notShared:This data isn't shared at all`,
    },
    {
      value: 'direction',
      label: $localize`:@@vendor.im.answer.kind.direction:The direction is wrong`,
    },
    { value: 'other', label: $localize`:@@vendor.im.answer.kind.other:Something else` },
  ];
  protected readonly kind = signal<WrongKind>('not-shared');
  protected readonly right = signal<ContextDirection>('outbound');
  protected readonly note = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly partial = signal(false);

  private readonly noteField = viewChild<ElementRef<HTMLTextAreaElement>>('noteField');
  private readonly firstKind = viewChild<ElementRef<HTMLInputElement>>('kindInput');

  protected readonly subject = computed(() =>
    dataSentence(
      this.claim().data_object_name,
      this.claim().direction,
      this.integration().other_product.name,
    ),
  );
  protected readonly otherDirections = computed<readonly ContextDirection[]>(() =>
    (['outbound', 'inbound', 'both'] as const).filter((d) => d !== this.claim().direction),
  );
  protected readonly audience = computed(() =>
    noteAudience(this.integration(), this.state.myVendorId()),
  );
  protected readonly versionsLabel = $localize`:@@vendor.im.answer.versions.about:About versions`;
  protected readonly versionsTip = computed(() => {
    const product = this.integration().context_product.name;
    return $localize`:@@vendor.im.answer.versions.tip:Soon you will be able to say which versions of ${product}:product: support this.`;
  });

  protected readonly label = LABEL;
  protected readonly help = HELP;
  protected readonly alert = ALERT;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;

  constructor() {
    // Seed from the saved position, then focus the first control, once.
    afterNextRender(() => {
      // The saved note seeds the form only when it belongs to the same stance: a
      // note on a Yes is not a reason for a No.
      const current = myAnswer(this.claim());
      if (current === this.mode()) this.note.set(myNote(this.claim()) ?? '');
      this.right.set(this.otherDirections()[0] ?? 'outbound');
      (this.mode() === 'no' ? this.firstKind() : this.noteField())?.nativeElement.focus();
    });
  }

  protected directionText(direction: ContextDirection): string {
    return directionShort(direction, this.integration().other_product.name);
  }

  protected asDirection(event: Event): ContextDirection {
    const value = (event.target as HTMLSelectElement).value;
    return value === 'inbound' || value === 'both' ? value : 'outbound';
  }

  protected textValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected async save(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    const note = this.note().trim();
    if (this.mode() === 'no' && note === '') {
      this.error.set(noteRequiredMessage());
      this.noteField()?.nativeElement.focus();
      return;
    }
    this.error.set(null);
    this.busy.set(true);
    try {
      if (this.mode() === 'no' && this.kind() === 'direction') {
        const result = await this.state.directionWrong(this.claim(), note, this.right());
        if (result === 'partial') {
          this.partial.set(true);
          return;
        }
        if (result !== null) {
          this.error.set(result);
          return;
        }
      } else {
        const result = await this.state.answerWithNote(this.claim(), this.mode() === 'yes', note);
        if (result !== null) {
          this.error.set(result);
          return;
        }
      }
      this.closed.emit();
    } finally {
      this.busy.set(false);
    }
  }

  protected async retryCorrected(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (await this.state.addCorrectedRow(this.claim(), this.right())) {
        this.partial.set(false);
        this.closed.emit();
      }
    } finally {
      this.busy.set(false);
    }
  }
}
