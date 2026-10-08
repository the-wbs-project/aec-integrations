import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { ProductListItem } from '@aeci/shared';

import { LogoOrInitial } from '../logo-or-initial/logo-or-initial';

/**
 * One row the picker can offer. `GET /api/products` returns the full
 * `ProductListItem`; the logo and vendor are optional so a caller (or a test)
 * holding a leaner row still renders, falling back to the initial and no vendor
 * line.
 */
export type ProductComboboxItem = Pick<ProductListItem, 'id' | 'name' | 'slug'> &
  Partial<Pick<ProductListItem, 'logo_url' | 'vendor'>>;

/** The caller's search. It should ask the server for `sort=name`, so the rows
 *  arrive A to Z; the picker keeps the order it is given. */
export type ProductComboboxSearch = (
  query: string,
) => Promise<{ readonly data: readonly ProductComboboxItem[] }>;

/** Type-ahead pause before a search goes out, in ms. */
export const PRODUCT_COMBOBOX_DEBOUNCE_MS = 250;
/** Shortest query that searches. One letter matches most of the catalogue. */
export const PRODUCT_COMBOBOX_MIN_CHARS = 2;

type Phase = 'idle' | 'short' | 'loading' | 'done' | 'error';

/**
 * `aec-product-combobox`: pick one published product by typing its name
 * (AECI-1244). It replaced three "text box + Search button + result list"
 * pickers: the admin connector mapping edit, the vendor "Add an integration"
 * counterpart, and the vendor catalogue mapping form.
 *
 * ── BEHAVIOUR ───────────────────────────────────────────────────────────────
 * Searches as the user types, after a {@link PRODUCT_COMBOBOX_DEBOUNCE_MS} pause
 * and once the query has {@link PRODUCT_COMBOBOX_MIN_CHARS} letters. A sequence
 * counter drops any response that is not for the latest query, so a slow early
 * search cannot overwrite a fast later one. Rows show the logo or initial, the
 * name and the vendor. The popup says when it is searching, when nothing
 * matched, and when the search failed.
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────
 * An editable Angular Aria combobox over an Aria listbox (ADR 0010), wired the
 * way `search/search-autocomplete.ts` and `shared/aec-select/aec-select.ts` are:
 * Aria supplies the roles, `aria-activedescendant` and the keyboard model
 * (arrows, Home/End, Enter selects, Escape closes, Tab leaves). Aria's popup
 * renders in-flow, so an outer `cdkConnectedOverlay` (`usePopover: 'inline'`)
 * supplies the floating layer. The listbox renders only when there are rows,
 * so an empty `role="listbox"` never reaches the DOM. Enter never submits the
 * surrounding form.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * The caller owns the `<label for>`, the hint, the error text and what a chosen
 * product looks like. The result count goes out through {@link announce}, never
 * a live region of its own: the admin console and the vendor portal each keep
 * exactly one polite region, and two regions on a page race.
 */
@Component({
  selector: 'aec-product-combobox',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule, LogoOrInitial],
  host: { class: 'block' },
  template: `
    <div class="relative w-full" #origin>
      <svg
        class="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--text-secondary)"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        ngCombobox
        #cb="ngCombobox"
        #field
        [id]="inputId()"
        type="text"
        autocomplete="off"
        spellcheck="false"
        [disabled]="disabled()"
        [(value)]="query"
        [(expanded)]="expanded"
        (input)="onInput($event)"
        (focusin)="focused.set(true)"
        (focusout)="focused.set(false)"
        (keydown.enter)="$event.preventDefault()"
        (keydown.escape)="dismissed.set(true)"
        (keydown.arrowdown)="dismissed.set(false)"
        [placeholder]="placeholderText()"
        [attr.aria-describedby]="describedBy()"
        [attr.aria-invalid]="invalid() ? 'true' : null"
        [attr.aria-busy]="phase() === 'loading' ? 'true' : null"
        [class]="inputClass()"
        data-product-combobox-input
      />
      <span class="absolute end-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
        @if (phase() === 'loading') {
          <svg
            class="h-4 w-4 text-(--text-secondary) motion-safe:animate-spin"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
            data-product-combobox-spinner
          >
            <path d="M21 12a9 9 0 1 1-6.2-8.6" />
          </svg>
        }
        @if (query() !== '' && !disabled()) {
          <button
            type="button"
            tabindex="-1"
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-(--text-secondary) hover:bg-(--surface-sunken) hover:text-(--text-primary)"
            [attr.aria-label]="clearLabel"
            (click)="clear()"
            data-product-combobox-clear
          >
            <svg
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        }
      </span>

      <!--
        Aria's ComboboxPopup renders in-flow, so the outer cdkConnectedOverlay
        (usePopover inline, the browser top layer) is the floating layer and the
        edge flip, per ADR 0010. The same wiring as aec-select. With no rows the
        combobox stays collapsed and the panel holds one line of state text, so
        an expanded combobox never points at a missing listbox.
      -->
      <ng-template
        [cdkConnectedOverlay]="{ origin, usePopover: 'inline', matchWidth: true }"
        [cdkConnectedOverlayOpen]="popupOpen()"
      >
        <div
          class="mt-1 w-full min-w-[16rem] overflow-hidden rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) shadow-lg"
          data-product-combobox-popup
        >
          <ng-template ngComboboxPopup [combobox]="cb" popupType="listbox">
            @if (hasList()) {
              <ul
                ngComboboxWidget
                ngListbox
                #listbox="ngListbox"
                [(value)]="selection"
                (valueChange)="onSelect($event)"
                [activeDescendant]="listbox.activeDescendant()"
                focusMode="activedescendant"
                selectionMode="explicit"
                [attr.aria-label]="listLabel()"
                class="m-0 flex max-h-[min(20rem,50vh)] list-none flex-col gap-0.5 overflow-y-auto p-1.5"
              >
                @for (p of visible(); track p.id) {
                  <li
                    ngOption
                    [value]="p"
                    [label]="p.name"
                    class="flex cursor-pointer items-center gap-3 rounded-(--radius-sm) px-2 py-1.5 data-[active=true]:bg-(--surface-sunken)"
                    data-product-option
                  >
                    <aec-logo-or-initial [src]="p.logo_url ?? null" [name]="p.name" size="sm" />
                    <span class="flex min-w-0 flex-col">
                      <span class="truncate text-sm font-medium text-(--text-primary)">{{
                        p.name
                      }}</span>
                      @if (p.vendor; as vendor) {
                        <span class="truncate text-xs text-(--text-secondary)">{{
                          vendor.name
                        }}</span>
                      }
                    </span>
                  </li>
                }
              </ul>
            }
          </ng-template>
          @if (!hasList()) {
            <p class="m-0 px-3 py-2.5 text-sm text-(--text-secondary)" data-product-combobox-state>
              {{ stateMessage() }}
            </p>
          }
        </div>
      </ng-template>
    </div>
  `,
})
export class ProductCombobox {
  /** The input's id, for the caller's `<label for>`. */
  readonly inputId = input.required<string>();
  /** Runs one search. See {@link ProductComboboxSearch}. */
  readonly search = input.required<ProductComboboxSearch>();
  /** Product ids never offered, such as the vendor's own product. */
  readonly exclude = input<readonly string[]>([]);
  /** The caller's hint and error ids, space-separated. */
  readonly describedBy = input<string | null>(null);
  /** Paints the error border and sets `aria-invalid`. */
  readonly invalid = input(false);
  readonly disabled = input(false);
  /** Overrides the default placeholder. The label is still the caller's. */
  readonly placeholder = input<string | null>(null);
  /** The listbox's accessible name. */
  readonly listLabel = input($localize`:@@productCombobox.list:Matching products`);

  /** A product was chosen. The query and the results clear. */
  readonly picked = output<ProductComboboxItem>();
  /** Text for the host's single polite live region: the result count, or the failure. */
  readonly announce = output<string>();

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');
  private readonly comboboxDirective = viewChild.required(Combobox);

  /** The text box value, two-way with `ngCombobox`. */
  protected readonly query = signal('');
  /** Popup state, two-way with `ngCombobox`. Aria opens it on input and closes
   *  it on Escape and on focus leaving. */
  protected readonly expanded = signal(false);
  /** The listbox selection, reset after every pick. */
  protected readonly selection = signal<ProductComboboxItem[]>([]);
  protected readonly phase = signal<Phase>('idle');
  private readonly results = signal<readonly ProductComboboxItem[]>([]);
  /** The query the shown results answer, for the empty-state sentence. */
  private readonly settledQuery = signal('');

  protected readonly visible = computed(() => {
    const excluded = new Set(this.exclude());
    return this.results().filter((p) => !excluded.has(p.id));
  });

  /** Whether the box holds focus. Gates the state panel and a late reopen. */
  protected readonly focused = signal(false);
  /** Escape hides the panel until the next keystroke or ArrowDown. */
  protected readonly dismissed = signal(false);

  protected readonly hasList = computed(() => this.visible().length > 0);

  /** Rows open with the combobox. State text (too short, searching, nothing,
   *  failed) shows while the box is focused, with the combobox collapsed. */
  protected readonly popupOpen = computed(() =>
    this.hasList()
      ? this.expanded()
      : this.focused() && !this.dismissed() && this.phase() !== 'idle',
  );

  protected readonly clearLabel = $localize`:@@productCombobox.clear:Clear the search`;
  private readonly defaultPlaceholder = $localize`:@@productCombobox.placeholder:Type a product name`;
  protected readonly placeholderText = computed(
    () => this.placeholder() ?? this.defaultPlaceholder,
  );

  protected readonly stateMessage = computed(() => {
    switch (this.phase()) {
      case 'short':
        return $localize`:@@productCombobox.short:Type at least two letters.`;
      case 'loading':
        return $localize`:@@productCombobox.loading:Searching…`;
      case 'error':
        return $localize`:@@productCombobox.failed:The search did not work. Try again.`;
      default: {
        const query = this.settledQuery();
        return $localize`:@@productCombobox.none:No published product matches “${query}:QUERY:”.`;
      }
    }
  });

  protected readonly inputClass = computed(() => {
    // The error tell is the border plus the caller's message. Border colour is an
    // arbitrary property because border-colour utilities lose to the unlayered
    // `*` rule in styles.css.
    const border = this.invalid()
      ? 'border [border-color:var(--status-error)]'
      : 'border border-(--border-default)';
    return (
      `w-full rounded-(--radius-md) ${border} bg-(--surface-base) py-2 ps-9 pe-16 text-sm` +
      ' text-(--text-primary) placeholder:text-(--text-secondary)' +
      ' focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)' +
      ' aria-disabled:cursor-not-allowed aria-disabled:bg-(--surface-sunken)'
    );
  });

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic request id. A response is dropped unless it is still the latest. */
  private seq = 0;

  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // Aria expands on every keystroke. With no rows to point at, an expanded
    // combobox would announce a popup that is not there (axe aria-required-attr).
    effect(() => {
      if (this.expanded() && !this.hasList()) untracked(() => this.setExpanded(false));
    });
    this.destroyRef.onDestroy(() => {
      this.cancelPending();
      this.seq++;
    });
  }

  /** Move focus into the text box, for a caller whose "Change" button just
   *  brought the picker back. */
  focus(): void {
    this.field().nativeElement.focus();
  }

  protected onInput(event: Event): void {
    this.dismissed.set(false);
    this.schedule((event.target as HTMLInputElement).value);
  }

  protected clear(): void {
    this.query.set('');
    this.schedule('');
    this.focus();
  }

  protected onSelect(values: ProductComboboxItem[]): void {
    const chosen = values.at(-1);
    if (!chosen) return; // the reset below re-enters here with []
    this.selection.set([]);
    this.query.set('');
    this.schedule('');
    this.picked.emit(chosen);
  }

  private schedule(raw: string): void {
    this.cancelPending();
    // Every keystroke makes an in-flight answer stale, including one that
    // lands during the pause before the next search starts.
    this.seq++;
    const query = raw.trim();
    if (query.length < PRODUCT_COMBOBOX_MIN_CHARS) {
      this.results.set([]);
      this.phase.set(query.length === 0 ? 'idle' : 'short');
      if (query.length === 0) this.setExpanded(false);
      return;
    }
    // Earlier rows stay up while the next search runs, so the list does not
    // flicker on every keystroke. The spinner says a newer answer is coming.
    this.phase.set('loading');
    this.timer = setTimeout(() => void this.run(query), PRODUCT_COMBOBOX_DEBOUNCE_MS);
  }

  private async run(query: string): Promise<void> {
    this.timer = null;
    const mine = this.seq;
    try {
      const page = await this.search()(query);
      if (mine !== this.seq) return;
      this.results.set(page.data);
      this.settledQuery.set(query);
      this.phase.set('done');
      // Rows that land after the keystroke reopen the list, unless the user
      // dismissed it or left the box.
      if (this.hasList() && this.focused() && !this.dismissed()) this.setExpanded(true);
      this.announce.emit(countAnnouncement(this.visible().length));
    } catch {
      if (mine !== this.seq) return;
      this.results.set([]);
      this.phase.set('error');
      this.announce.emit(
        $localize`:@@productCombobox.failedLive:The product search did not work. Try again.`,
      );
    }
  }

  /**
   * Open or close through the directive's own model. Setting only the local
   * signal is not enough: the two-way binding pushes a value down only when it
   * differs from the last one it pushed, and Aria's own `expanded.set(true)` on
   * input never went through that binding, so a local `false` after it would
   * look unchanged and never reach Aria.
   */
  private setExpanded(value: boolean): void {
    this.comboboxDirective().expanded.set(value);
    this.expanded.set(value);
  }

  private cancelPending(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

function countAnnouncement(count: number): string {
  if (count === 0) return $localize`:@@productCombobox.live.none:No products match.`;
  if (count === 1) return $localize`:@@productCombobox.live.one:1 product found.`;
  return $localize`:@@productCombobox.live.many:${count}:COUNT: products found.`;
}
