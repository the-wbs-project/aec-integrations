import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
} from '@angular/core';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { AecButton } from '../../shared/button/button';
import { FIELD_ERROR_CLASS, FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';

/** One bullet in a draft list. `id` is a client-only key so a row keeps its DOM
 *  node (and its focus) across a reorder; it never reaches the wire. */
export interface BulletDraft {
  readonly id: number;
  readonly text: string;
}

let nextBulletId = 1;

/** Mint a fresh draft bullet. Module-scoped so two editors never share an id. */
export function newBullet(text = ''): BulletDraft {
  return { id: nextBulletId++, text };
}

/**
 * An editable bulleted list: one input per bullet, a plus button that adds a
 * bullet at the bottom, and per-row move-up, move-down and remove buttons
 * (AECI-994).
 *
 * ── WHY BUTTONS AND NOT DRAG ────────────────────────────────────────────────
 * Reordering is two icon buttons per row. They work with a keyboard and a screen
 * reader without a second interaction model, and `apps/web` carries no
 * drag-and-drop dependency. A drag handle can be added on top later; it could not
 * replace these, because WCAG 2.5.7 requires a non-drag alternative anyway.
 *
 * ── FOCUS FOLLOWS THE WORK ──────────────────────────────────────────────────
 * Every structural change puts focus somewhere deliberate, because the button the
 * vendor pressed can stop existing (remove) or stop being enabled (move up on the
 * new first row):
 *
 *  - add → the new bullet's input;
 *  - remove → the next bullet's input, else the previous one, else the add button;
 *  - move → the same button on the moved row, or its sibling when that button just
 *    became disabled at the end of the list.
 *
 * Each move and removal is also announced through the portal's one polite live
 * region, since the visual change is otherwise silent to a screen reader.
 *
 * Enter inside a bullet never submits the surrounding form. On the last bullet it
 * adds a new one, which is what a vendor typing a list expects.
 *
 * Stateless: the parent owns the array and receives every change through
 * {@link bulletsChange}.
 */
@Component({
  selector: 'aec-vendor-bullet-list-editor',
  imports: [AecButton, AecIcon],
  template: `
    <div class="space-y-2">
      @if (bullets().length > 0) {
        <ul class="space-y-2" [attr.aria-label]="label()">
          @for (
            bullet of bullets();
            track bullet.id;
            let i = $index, first = $first, last = $last
          ) {
            <!-- AECI-1810: the row controls are 44px aecButtons. Below about 420px they
                 wrap under the point, so the text box keeps a usable width. -->
            <li class="flex flex-wrap items-start gap-2">
              <div class="flex min-w-56 flex-1 items-start gap-2">
                <span
                  aria-hidden="true"
                  class="mt-4 size-2 shrink-0 rounded-pill bg-(--text-secondary)"
                ></span>
                <div class="min-w-0 flex-1">
                  <label [for]="inputId(bullet.id)" class="sr-only">{{ bulletLabel(i) }}</label>
                  <input
                    type="text"
                    [id]="inputId(bullet.id)"
                    [value]="bullet.text"
                    [readOnly]="disabled()"
                    [attr.aria-invalid]="tooLong(bullet) ? 'true' : null"
                    [attr.aria-describedby]="tooLong(bullet) ? inputId(bullet.id) + '-error' : null"
                    [class]="inputClass"
                    (input)="onInput(bullet.id, $event)"
                    (keydown.enter)="onEnter($event, last)"
                  />
                  @if (tooLong(bullet)) {
                    <p [id]="inputId(bullet.id) + '-error'" [class]="'mt-1 ' + errorClass">
                      {{ tooLongMessage(bullet) }}
                    </p>
                  }
                </div>
              </div>
              @if (!disabled()) {
                <div class="ms-auto flex shrink-0 items-center gap-1">
                  <button
                    aecButton
                    variant="secondary"
                    iconOnly
                    type="button"
                    [attr.data-action]="'up-' + bullet.id"
                    [disabled]="first"
                    [attr.aria-label]="moveUpLabel(i)"
                    (click)="move(i, -1)"
                  >
                    <aec-icon name="chevron-up" decorative [size]="4" />
                  </button>
                  <button
                    aecButton
                    variant="secondary"
                    iconOnly
                    type="button"
                    [attr.data-action]="'down-' + bullet.id"
                    [disabled]="last"
                    [attr.aria-label]="moveDownLabel(i)"
                    (click)="move(i, 1)"
                  >
                    <aec-icon name="chevron-down" decorative [size]="4" />
                  </button>
                  <button
                    aecButton
                    variant="secondary"
                    iconOnly
                    type="button"
                    [attr.aria-label]="removeLabel(i)"
                    (click)="remove(i)"
                  >
                    <aec-icon name="x" decorative [size]="4" />
                  </button>
                </div>
              }
            </li>
          }
        </ul>
      }

      @if (!disabled()) {
        <div class="flex flex-wrap items-center gap-3">
          <button
            aecButton
            variant="secondary"
            compact
            type="button"
            data-action="add"
            [disabled]="atCap()"
            (click)="add()"
          >
            <aec-icon name="plus" decorative [size]="4" />
            <span>{{ addLabel() }}</span>
          </button>
          <span class="text-xs text-(--text-secondary)">{{ counter() }}</span>
        </div>
      }
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorBulletListEditor {
  /** A field's inline error: the shared recipe (AECI-1984). */
  protected readonly errorClass = FIELD_ERROR_CLASS;
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly announcer = inject(VendorPortalAnnouncer);
  private readonly injector = inject(Injector);

  /** What the list is about, e.g. "How Estimators use it". Names the list and
   *  prefixes every control's accessible name. */
  readonly label = input.required<string>();
  readonly bullets = input.required<readonly BulletDraft[]>();
  readonly maxBullets = input.required<number>();
  readonly maxLength = input.required<number>();
  /** Read-only: no row controls, no add button, inputs marked readonly. */
  readonly disabled = input<boolean>(false);
  /** Unique within the page; keeps input ids distinct across many lists. */
  readonly idPrefix = input.required<string>();

  readonly bulletsChange = output<readonly BulletDraft[]>();

  /**
   * AECI-1810: the shared field recipe. A read-only list (the plan does not cover
   * the points) sits on the sunken surface: the `read-only:` variant sorts after the
   * recipe's `bg-(--surface-base)`, so it wins whenever the input is read-only.
   */
  protected readonly inputClass = `${FIELD_INPUT_CLASS} read-only:bg-(--surface-sunken)`;

  protected readonly atCap = computed(() => this.bullets().length >= this.maxBullets());
  protected readonly counter = computed(
    () =>
      $localize`:@@vendor.bullets.counter:${this.bullets().length}:COUNT: of ${this.maxBullets()}:MAX: points`,
  );
  protected readonly addLabel = computed(() =>
    this.bullets().length === 0
      ? $localize`:@@vendor.bullets.addFirst:Add a point`
      : $localize`:@@vendor.bullets.addAnother:Add another point`,
  );

  protected inputId(id: number): string {
    return `${this.idPrefix()}-bullet-${id}`;
  }

  protected tooLong(bullet: BulletDraft): boolean {
    return bullet.text.trim().length > this.maxLength();
  }

  protected tooLongMessage(bullet: BulletDraft): string {
    return $localize`:@@vendor.bullets.tooLong:${bullet.text.trim().length}:COUNT: of ${this.maxLength()}:MAX: characters. Shorten this point.`;
  }

  protected bulletLabel(i: number): string {
    return $localize`:@@vendor.bullets.itemLabel:${this.label()}:LIST:, point ${i + 1}:N:`;
  }
  protected moveUpLabel(i: number): string {
    return $localize`:@@vendor.bullets.moveUp:Move point ${i + 1}:N: up`;
  }
  protected moveDownLabel(i: number): string {
    return $localize`:@@vendor.bullets.moveDown:Move point ${i + 1}:N: down`;
  }
  protected removeLabel(i: number): string {
    return $localize`:@@vendor.bullets.remove:Remove point ${i + 1}:N:`;
  }

  protected onInput(id: number, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.bulletsChange.emit(this.bullets().map((b) => (b.id === id ? { ...b, text } : b)));
  }

  protected onEnter(event: Event, last: boolean): void {
    // Never let Enter submit the surrounding form from inside a list.
    event.preventDefault();
    if (last && !this.atCap()) this.add();
  }

  protected add(): void {
    if (this.disabled() || this.atCap()) return;
    const bullet = newBullet();
    this.bulletsChange.emit([...this.bullets(), bullet]);
    this.focusAfterRender(`[id="${this.inputId(bullet.id)}"]`);
  }

  protected remove(index: number): void {
    const list = this.bullets();
    const next = list.filter((_, i) => i !== index);
    this.bulletsChange.emit(next);
    const neighbour = next[index] ?? next[index - 1];
    this.focusAfterRender(
      neighbour ? `[id="${this.inputId(neighbour.id)}"]` : '[data-action="add"]',
    );
    this.announcer.announce(
      $localize`:@@vendor.bullets.removedAnnouncement:Point ${index + 1}:N: removed.`,
    );
  }

  protected move(index: number, delta: -1 | 1): void {
    const list = [...this.bullets()];
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const [moved] = list.splice(index, 1);
    list.splice(target, 0, moved!);
    this.bulletsChange.emit(list);
    // Keep focus on the control the vendor pressed. When that control is now
    // disabled (the row reached an end), hand it to the opposite direction.
    const atEnd = delta === -1 ? target === 0 : target === list.length - 1;
    const direction = atEnd ? (delta === -1 ? 'down' : 'up') : delta === -1 ? 'up' : 'down';
    this.focusAfterRender(`[data-action="${direction}-${moved!.id}"]`);
    this.announcer.announce(
      $localize`:@@vendor.bullets.movedAnnouncement:Point moved to position ${target + 1}:N: of ${list.length}:TOTAL:.`,
    );
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(
      () => {
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus();
      },
      { injector: this.injector },
    );
  }
}
