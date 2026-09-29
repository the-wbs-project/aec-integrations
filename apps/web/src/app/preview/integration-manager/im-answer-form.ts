import {
  ChangeDetectionStrategy,
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

import { ImTip } from './im-tip';
import { BTN_PRIMARY, BTN_SECONDARY, IM_STYLES, LABEL } from './im-ui';
import {
  VIEWER,
  directionShort,
  flowSentence,
  type FlowDirection,
  type ImFlow,
  type ImIntegration,
  type WrongReason,
} from './integration-manager.fixtures';
import { IntegrationManagerStore } from './integration-manager.store';

let nextId = 0;

/** The attestation note's ceiling (`attestationNote`, packages/shared vendor-attestations.ts). */
const NOTE_MAX = 2000;

/**
 * The reason that goes with an answer on one row of data.
 *
 * - `no`: "What's wrong?" (not shared at all, the direction is wrong, something
 *   else), the correct direction when that is the choice, and a required reason.
 * - `yes`: an optional note, offered when the other company said No, so both
 *   sides can explain.
 *
 * The answer only changes on Save. The helper text says who sees the reason.
 * Chris ruled on 2026-09-28 that no vendor note is ever public, Yes or No: only
 * the other company and AEC Integrations see it. (The pair page shows notes in its
 * provenance popover today, so shipping this needs that surface changed too.)
 *
 * Version stamps stay hidden for now (same ruling): the form shows a disabled
 * "Versions: coming soon" row with a tooltip, and no pickers.
 * "What's wrong" and the suggested direction are preview only: the attestation
 * model holds a stance and a free-text note, nothing structured.
 */
@Component({
  selector: 'aec-im-answer-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ImTip],
  styles: [IM_STYLES],
  template: `
    <form
      class="im-well space-y-3 p-4 text-sm"
      (submit)="save($event)"
      [attr.aria-labelledby]="id + '-title'"
    >
      <p [id]="id + '-title'" class="im-h4">
        {{ mode() === 'no' ? 'Why is this wrong?' : 'Add a note to your answer' }}
        <span class="block font-normal text-(--text-secondary)">{{ subject() }}</span>
      </p>

      @if (mode() === 'no') {
        <fieldset>
          <legend [class]="label">What's wrong?</legend>
          <div class="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
            @for (k of kinds; track k.value) {
              <label class="inline-flex cursor-pointer items-center gap-2 text-(--text-primary)">
                <input
                  #kindInput
                  type="radio"
                  [name]="id + '-kind'"
                  [value]="k.value"
                  [checked]="kind() === k.value"
                  (change)="kind.set(k.value)"
                  class="h-4 w-4 accent-(--accent-primary)"
                />
                {{ k.label }}
              </label>
            }
          </div>
        </fieldset>
        @if (kind() === 'direction') {
          <div>
            <label [for]="id + '-dir'" [class]="label">The right direction</label>
            <select
              [id]="id + '-dir'"
              class="im-input mt-1 max-w-xs"
              (change)="suggested.set(asDirection($event))"
            >
              @for (d of otherDirections(); track d) {
                <option [value]="d" [selected]="suggested() === d">{{ direction(d) }}</option>
              }
            </select>
          </div>
        }
      }

      <div>
        <label [for]="id + '-note'" [class]="label">
          {{ mode() === 'no' ? 'Reason' : 'Note' }}
          <span class="font-normal text-(--text-secondary)">{{
            mode() === 'no' ? '(required)' : '(optional)'
          }}</span>
        </label>
        <textarea
          #noteField
          [id]="id + '-note'"
          rows="2"
          class="im-input mt-1"
          [attr.maxlength]="max"
          [attr.aria-describedby]="id + '-help'"
          [attr.aria-invalid]="error() ? 'true' : null"
          [value]="note()"
          (input)="note.set(inputValue($event))"
        ></textarea>
        <p [id]="id + '-help'" class="mt-1 text-(--text-secondary)">{{ audience() }}</p>
      </div>

      <div class="flex items-center gap-1 text-(--text-secondary)" data-testid="versions-soon">
        <span><span class="font-semibold">Versions:</span> coming soon</span>
        <aec-im-tip label="About versions" [lines]="[versionsTip]" />
      </div>

      @if (error()) {
        <p role="alert" class="font-medium text-(--status-error)">{{ error() }}</p>
      }
      <div class="flex flex-wrap gap-3">
        <button type="submit" [class]="primary">Save</button>
        <button type="button" [class]="secondary" (click)="closed.emit()">Cancel</button>
      </div>
    </form>
  `,
})
export class ImAnswerForm {
  private readonly store = inject(IntegrationManagerStore);

  readonly integration = input.required<ImIntegration>();
  readonly flow = input.required<ImFlow>();
  /** The answer this form will save. */
  readonly mode = input.required<'yes' | 'no'>();
  readonly closed = output<void>();

  protected readonly id = `im-answer-${++nextId}`;
  protected readonly versionsTip = `Soon you will be able to say which versions of ${VIEWER.product} support this.`;
  protected readonly max = NOTE_MAX;
  protected readonly kinds: ReadonlyArray<{ value: WrongReason['kind']; label: string }> = [
    { value: 'not-shared', label: "This data isn't shared at all" },
    { value: 'direction', label: 'The direction is wrong' },
    { value: 'other', label: 'Something else' },
  ];

  protected readonly kind = signal<WrongReason['kind']>('not-shared');
  protected readonly suggested = signal<FlowDirection>('outbound');
  protected readonly note = signal('');
  protected readonly error = signal<string | null>(null);

  private readonly noteField = viewChild<ElementRef<HTMLTextAreaElement>>('noteField');
  private readonly firstKind = viewChild<ElementRef<HTMLInputElement>>('kindInput');

  protected readonly label = LABEL;
  protected readonly primary = BTN_PRIMARY;
  protected readonly secondary = BTN_SECONDARY;

  protected readonly subject = computed(() => flowSentence(this.flow(), this.integration()));
  protected readonly otherDirections = computed<readonly FlowDirection[]>(() =>
    (['outbound', 'inbound', 'both'] as const).filter((d) => d !== this.flow().direction),
  );
  /** Who reads the reason, stated plainly (the note is not private). */
  protected readonly audience = computed(() => {
    const i = this.integration();
    const who = i.ownsBoth
      ? 'Only AEC Integrations sees this.'
      : `Only ${i.other.vendor} and AEC Integrations see this.`;
    return who;
  });

  constructor() {
    // Seed from the saved position, then focus the first control, once.
    afterNextRender(() => {
      const f = this.flow();
      this.note.set(f.myNote ?? '');
      if (f.myReason) this.kind.set(f.myReason.kind);
      this.suggested.set(f.myReason?.suggested ?? this.otherDirections()[0] ?? 'outbound');
      (this.mode() === 'no' ? this.firstKind() : this.noteField())?.nativeElement.focus();
    });
  }

  protected direction(d: FlowDirection): string {
    return directionShort(d, this.integration().other.name);
  }
  protected asDirection(event: Event): FlowDirection {
    const v = (event.target as HTMLSelectElement).value;
    return v === 'inbound' || v === 'both' ? v : 'outbound';
  }
  protected inputValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  protected save(event: Event): void {
    event.preventDefault();
    const note = this.note().trim();
    if (this.mode() === 'no' && note === '') {
      this.error.set('Give a reason, so the other company and AEC Integrations know what to fix.');
      this.noteField()?.nativeElement.focus();
      return;
    }
    this.error.set(null);
    const reason: WrongReason | null =
      this.mode() === 'no'
        ? this.kind() === 'direction'
          ? { kind: 'direction', suggested: this.suggested() }
          : { kind: this.kind() }
        : null;
    this.store.setAnswer(this.integration().id, this.flow().id, this.mode(), {
      note: note || null,
      reason,
    });
    this.closed.emit();
  }
}
