import { Combobox, ComboboxPopup, ComboboxWidget } from '@angular/aria/combobox';
import { Listbox, Option } from '@angular/aria/listbox';
import { OverlayModule } from '@angular/cdk/overlay';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';

import type { VendorProduct } from '@aeci/shared';

import { VENDOR_NAV_ITEM_CLASS } from './vendor-nav';

/**
 * The portal nav's Products item: a disclosure button over a dropdown whose
 * first control is a search box, filtering this vendor's own catalog. Choosing
 * a product navigates to `…/products/:productSlug`.
 *
 * The trigger is the label alone — **no arrow icon**, matching the public nav
 * (`layout/nav-flyout-trigger.ts`) and the admin console's category row. The
 * disclosure lives in `aria-expanded` / `aria-controls`, not in a glyph.
 *
 * ── WHY THE PRODUCT CHOICE LIVES IN THE NAV ─────────────────────────────────
 * It used to live inside the section, as an `<aec-select>` beside the "Your
 * products" heading — which meant a vendor had to be ON the products page to
 * change which product they were editing, and a vendor with a hundred products
 * had a picker with no way to type a name. In the nav it answers "which product
 * am I editing" from anywhere in the portal, and the search box makes a long
 * catalog navigable in two keystrokes. The choice is still a URL segment, so it
 * is still a bookmark, a Back step, and a link a colleague can be sent.
 *
 * ── WHY THIS IS A COMBOBOX AND NOT A MENU ───────────────────────────────────
 * `role="menu"` may not own a `textbox` — a search field inside one is an
 * `aria-required-children` violation — and the menu pattern claims printable
 * characters for first-letter typeahead, so it would eat every keystroke aimed
 * at the search box. A filter inside a popup is a combobox. `user-menu.ts` and
 * `nav-menu.ts` reached the same conclusion for their own panels.
 *
 * The composition (ADR 0010: Aria supplies behavior, not the floating layer):
 *
 *  - the OUTER open state is ours — a plain `signal` driving
 *    `cdkConnectedOverlayOpen`;
 *  - the combobox is `alwaysExpanded`, which makes Aria's own `expanded` model,
 *    its Escape handler and its close-on-blur effect all inert. Without it two
 *    open states fight each other and the listbox collapses under the panel;
 *  - `cdkConnectedOverlayDisableClose` is on because CDK's built-in Escape
 *    detaches the overlay directly, behind the back of our `open` signal, which
 *    would desync the trigger. Escape is handled below, WITH the focus return
 *    that CDK does not do.
 *
 * The panel MUST be an overlay rather than an `absolute top-full` panel: the nav
 * row is `overflow-x-auto` (a clip container), so an in-flow panel would be
 * clipped by the row it hangs from. `usePopover: 'inline'` puts it in the
 * browser's top layer.
 *
 * ── NO LIVE REGION HERE, DELIBERATELY ───────────────────────────────────────
 * The portal has exactly one polite live region and it lives in the shell
 * (`vendor-dashboard-tabbed.ts`, `STAGE_2_REALTIME_SPEC.md` §6.3). A "3 products
 * match" `role="status"` on this panel would be precisely the forbidden second
 * region: two regions on one page make announcements race and duplicate. The
 * combobox already announces its own result count through the listbox.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-products-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Combobox, ComboboxPopup, ComboboxWidget, Listbox, Option, OverlayModule],
  template: `
    <button
      type="button"
      #origin
      [id]="TRIGGER_ID"
      [attr.aria-expanded]="open()"
      [attr.aria-controls]="open() ? PANEL_ID : null"
      [attr.aria-current]="isActive() ? 'true' : null"
      (click)="toggle()"
      [class]="triggerClass"
    >
      <span>{{ label() }}</span>
    </button>

    <!--
      One overlay, one open state. The combobox nests INSIDE it and renders its
      listbox in-flow (ComboboxPopup is a DeferredContent host, not a floating
      layer), so there is no second overlay to position or dismiss.
    -->
    <ng-template
      [cdkConnectedOverlay]="{
        origin,
        usePopover: 'inline',
        matchWidth: false,
        disableClose: true,
      }"
      [cdkConnectedOverlayOpen]="open()"
      (attach)="onAttach()"
      (overlayOutsideClick)="close()"
    >
      <div
        [id]="PANEL_ID"
        class="z-50 flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-1.5
          rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)
          p-1.5 shadow-lg"
      >
        <label [attr.for]="SEARCH_ID" class="sr-only" i18n="@@vendor.nav.products.search.label"
          >Filter products</label
        >
        <input
          ngCombobox
          #cb="ngCombobox"
          #searchEl
          alwaysExpanded
          [id]="SEARCH_ID"
          type="text"
          autocomplete="off"
          [(value)]="query"
          (keydown)="onSearchKeydown($event)"
          [placeholder]="searchPlaceholder"
          class="h-9 w-full rounded-(--radius-sm) border border-(--border-default)
            bg-(--surface-base) px-3 text-sm text-(--text-primary)
            placeholder:text-(--text-secondary) focus-visible:outline-2
            focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
        />

        <ng-template ngComboboxPopup [combobox]="cb" popupType="listbox">
          <!--
            The listbox renders only when something matches. Aria's combobox
            expands on EVERY keystroke, so gating the expansion cannot keep an
            empty role="listbox" out of the DOM; gating the widget itself does.
            An empty listbox is an aria-required-children violation, and a
            "No matches" row dressed as an option is an unselectable option.
          -->
          @if (filtered().length > 0) {
            <ul
              ngComboboxWidget
              ngListbox
              #listbox="ngListbox"
              [(value)]="selection"
              (valueChange)="onChoose()"
              (mousedown)="$event.preventDefault()"
              [activeDescendant]="listbox.activeDescendant()"
              focusMode="activedescendant"
              selectionMode="explicit"
              [attr.aria-label]="listboxLabel"
              class="m-0 flex max-h-[min(18rem,50vh)] list-none flex-col gap-0.5
                overflow-y-auto p-0"
            >
              @for (product of filtered(); track product.slug) {
                <li
                  ngOption
                  [value]="product"
                  [label]="product.name"
                  class="flex cursor-pointer items-center justify-between gap-3
                    rounded-(--radius-sm) px-3 py-2 text-sm text-(--text-primary)
                    data-[active=true]:bg-(--surface-sunken)"
                >
                  <span>{{ product.name }}</span>
                  @if (product.slug === currentSlug()) {
                    <span aria-hidden="true" class="text-(--accent-primary)">&#10003;</span>
                  }
                </li>
              }
            </ul>
          } @else {
            <p class="px-3 py-2 text-sm text-(--text-secondary)" i18n="@@vendor.nav.products.empty">
              No products match that name.
            </p>
          }
        </ng-template>
      </div>
    </ng-template>
  `,
  styles: [':host { display: contents; }'],
})
export class VendorProductsMenu {
  /** This vendor's catalog, straight off the `me` payload. */
  readonly products = input.required<readonly VendorProduct[]>();
  /** The nav label, already localized in `vendor-nav.ts` so the IA owns its copy. */
  readonly label = input.required<string>();

  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  /** One menu per page, so the ids are constants rather than a module counter.
   *  A counter would be a hydration mismatch waiting to happen: unlike
   *  `AecSelect`, this control renders during SSR. */
  protected readonly TRIGGER_ID = 'vendor-products-menu-trigger';
  protected readonly PANEL_ID = 'vendor-products-menu-panel';
  protected readonly SEARCH_ID = 'vendor-products-menu-search';

  /**
   * The shared nav-item treatment plus a button reset, plus the active
   * declarations `routerLinkActive` would have supplied if this were a link.
   * These must mirror `VENDOR_NAV_ITEM_ACTIVE_CLASS` exactly. The underline is
   * not among them: `.aec-nav-tab[aria-current]` covers both kinds of item.
   */
  protected readonly triggerClass =
    `${VENDOR_NAV_ITEM_CLASS} cursor-pointer border-x-0 border-t-0 bg-transparent ` +
    'aria-[current=true]:font-bold aria-[current=true]:text-(--accent-primary)';

  protected readonly searchPlaceholder = $localize`:@@vendor.nav.products.search.placeholder:Search your products`;
  protected readonly listboxLabel = $localize`:@@vendor.nav.products.listbox.aria:Your products`;

  protected readonly open = signal(false);
  /** The search text, written by Aria's own input handler via `[(value)]`. */
  protected readonly query = signal('');
  /** Aria's array-valued listbox selection model. Reset after every commit so
   *  the same product can be chosen again later. */
  protected readonly selection = signal<VendorProduct[]>([]);

  private readonly triggerEl = viewChild.required<ElementRef<HTMLButtonElement>>('origin');
  private readonly searchEl = viewChild<ElementRef<HTMLInputElement>>('searchEl');

  /**
   * The option list is FROZEN while the panel is open. `VendorLiveSync` refetches
   * `me` every 20 seconds, and products is one of its six scopes — so without
   * this, a background poll could add or drop rows under a pointer already
   * travelling toward one, which is the one thing §6.3 forbids outright. The
   * same instinct the store already applies to a section holding unsaved edits.
   */
  private readonly frozen = signal<readonly VendorProduct[] | null>(null);

  /** Alphabetical: the menu is a lookup, so it is ordered the way a reader would
   *  look something up, not by `is_primary`. */
  private readonly sorted = computed<readonly VendorProduct[]>(() =>
    [...(this.frozen() ?? this.products())].sort((a, b) => a.name.localeCompare(b.name)),
  );

  protected readonly filtered = computed<readonly VendorProduct[]>(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.sorted();
    return this.sorted().filter((p) => p.name.toLowerCase().includes(q));
  });

  /** Re-read the router on every completed navigation. The shell is not
   *  re-created when a section changes, so nothing else would refresh these. */
  private readonly navigated = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * "You are here" for a control that is not a link.
   *
   * The other four nav items get `aria-current="page"` free from
   * `routerLinkActive`; that directive needs a `routerLink`, and this one is a
   * disclosure button. `subset` matching is what keeps the item current on
   * `…/products/:productSlug` as well as on the bare path.
   */
  protected readonly isActive = computed(() => {
    this.navigated();
    return this.router.isActive(
      this.router.createUrlTree(['products'], { relativeTo: this.route }),
      {
        paths: 'subset',
        queryParams: 'ignored',
        fragment: 'ignored',
        matrixParams: 'ignored',
      },
    );
  });

  /** The product the URL currently names, for the check mark. */
  protected readonly currentSlug = computed<string | null>(() => {
    this.navigated();
    return this.route.firstChild?.snapshot.paramMap.get('productSlug') ?? null;
  });

  protected toggle(): void {
    if (this.open()) this.close();
    else this.openPanel();
  }

  private openPanel(): void {
    this.query.set('');
    this.frozen.set(this.products());
    this.open.set(true);
  }

  protected close(): void {
    this.open.set(false);
    this.frozen.set(null);
  }

  /** Move focus into the search box once the panel is in the DOM. This is a
   *  context change the vendor asked for by activating the trigger, so it is not
   *  a WCAG 3.2.1 problem — and without it a keyboard user has no way to know a
   *  text field appeared. Never do this on hover. */
  protected onAttach(): void {
    afterNextRender(() => this.searchEl()?.nativeElement.focus(), { injector: this.injector });
  }

  /**
   * Escape closes and returns focus to the trigger; Tab closes and hands focus
   * back to the trigger first, so tabbing out of the panel resumes in the nav
   * rather than at the top of the document.
   *
   * ON THE INPUT, not on the overlay. Aria's `KeyboardEventManager` defaults to
   * `stopPropagation: true` and binds Escape (a no-op of its own under
   * `alwaysExpanded`), so the event never reaches CDK's document-level keydown
   * dispatcher and `(overlayKeydown)` would silently never fire for it. A
   * listener on the SAME element still runs: `stopPropagation` is not
   * `stopImmediatePropagation`.
   *
   * Keydown rather than a `focusout` handler on the panel, because `focusout`
   * races the pointer (mousedown on a non-focusable option blurs the input
   * before the click commits) — which is also why the listbox swallows
   * mousedown's default above.
   */
  protected onSearchKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' && event.key !== 'Tab') return;
    if (event.key === 'Escape') event.preventDefault();
    this.close();
    this.triggerEl().nativeElement.focus();
  }

  /**
   * Navigate relative to THIS route, with no `.parent`.
   *
   * `sections/vendor-products-page.ts` navigates with `relativeTo: route.parent`
   * because it is the child; this menu is rendered by the shell, whose
   * `ActivatedRoute` already IS the portal's layout route. Adding `.parent` here
   * would produce `/vendor/products/<slug>`, making `:vendorSlug` the literal
   * "products" and 404ing in the resolver. Keeping it relative is also what lets
   * one component serve `/vendor/:vendorSlug` and `/preview/vendor-dashboard`.
   */
  protected onChoose(): void {
    const chosen = this.selection().at(-1);
    if (!chosen) return; // the post-commit reset to [] re-enters here
    this.selection.set([]);
    this.close();
    void this.router.navigate(['products', chosen.slug], { relativeTo: this.route });
  }
}
