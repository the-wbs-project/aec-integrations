import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { LinkRef } from '../../types';

/**
 * Searchable multi-select replacement.
 *
 * Renders selected items as removable chips with an inline search field. Typing
 * filters the option dropdown (case-insensitive substring match); Enter adds
 * the active option, Backspace on an empty field removes the last chip, ↑/↓
 * navigates the dropdown, Escape closes it.
 */
@Component({
  selector: 'app-tag-input',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="tag-input"
      (click)="focusField()"
      (keydown)="onContainerKeydown($event)"
    >
      @for (chip of selectedChips(); track chip.id) {
        <span class="tag-input__chip">
          {{ chip.name }}
          <button
            type="button"
            class="tag-input__chip-remove"
            [attr.aria-label]="'Remove ' + chip.name"
            (click)="remove(chip.id, $event)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      }
      <input
        #field
        type="text"
        class="tag-input__field"
        [placeholder]="selectedIds().length ? '' : placeholder()"
        [value]="query()"
        (input)="onInput($event)"
        (focus)="open.set(true)"
        (keydown)="onFieldKeydown($event)"
        [attr.aria-label]="placeholder()"
        [attr.aria-expanded]="open()"
        autocomplete="off"
      />

      @if (open()) {
        <div class="tag-input__menu" role="listbox">
          @if (filteredOptions().length === 0) {
            <span class="tag-input__option tag-input__option--empty">No matches</span>
          }
          @for (opt of filteredOptions(); track opt.id; let i = $index) {
            <button
              type="button"
              class="tag-input__option"
              [class.tag-input__option--active]="i === activeIndex()"
              (mousedown)="add(opt.id, $event)"
              (mouseenter)="activeIndex.set(i)"
              role="option"
              [attr.aria-selected]="i === activeIndex()"
            >
              {{ opt.name }}
            </button>
          }
        </div>
      }
    </div>
  `,
})
export class TagInputComponent {
  readonly options = input.required<LinkRef[]>();
  readonly selectedIds = input.required<string[]>();
  readonly placeholder = input<string>('Add…');
  readonly selectedIdsChange = output<string[]>();

  protected readonly query = signal('');
  protected readonly open = signal(false);
  protected readonly activeIndex = signal(0);

  private readonly fieldRef = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly host = inject(ElementRef<HTMLElement>);

  protected readonly selectedChips = computed<LinkRef[]>(() => {
    const ids = new Set(this.selectedIds());
    const map = new Map(this.options().map(o => [o.id, o]));
    // Preserve the saved order.
    return this.selectedIds()
      .map(id => map.get(id))
      .filter((o): o is LinkRef => !!o && ids.has(o.id));
  });

  protected readonly filteredOptions = computed<LinkRef[]>(() => {
    const q = this.query().trim().toLowerCase();
    const selected = new Set(this.selectedIds());
    return this.options()
      .filter(o => !selected.has(o.id))
      .filter(o => !q || o.name.toLowerCase().includes(q))
      .slice(0, 50);
  });

  protected focusField(): void {
    this.fieldRef()?.nativeElement.focus();
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    this.activeIndex.set(0);
    this.open.set(true);
  }

  protected onFieldKeydown(event: KeyboardEvent): void {
    const opts = this.filteredOptions();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.open.set(true);
        if (opts.length) this.activeIndex.set((this.activeIndex() + 1) % opts.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (opts.length) this.activeIndex.set((this.activeIndex() - 1 + opts.length) % opts.length);
        break;
      case 'Enter':
        if (this.open() && opts[this.activeIndex()]) {
          event.preventDefault();
          this.add(opts[this.activeIndex()].id);
        }
        break;
      case 'Backspace':
        if (this.query() === '' && this.selectedIds().length) {
          event.preventDefault();
          const ids = this.selectedIds().slice(0, -1);
          this.selectedIdsChange.emit(ids);
        }
        break;
      case 'Escape':
        this.open.set(false);
        break;
    }
  }

  // Catch keys at the container level only when the field doesn't have focus —
  // currently a no-op but keeps the API symmetric with the field handler.
  protected onContainerKeydown(_event: KeyboardEvent): void {}

  protected add(id: string, event?: Event): void {
    event?.preventDefault();
    if (this.selectedIds().includes(id)) return;
    this.selectedIdsChange.emit([...this.selectedIds(), id]);
    this.query.set('');
    this.activeIndex.set(0);
    this.fieldRef()?.nativeElement.focus();
  }

  protected remove(id: string, event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    this.selectedIdsChange.emit(this.selectedIds().filter(x => x !== id));
    this.fieldRef()?.nativeElement.focus();
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (!this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }
}

