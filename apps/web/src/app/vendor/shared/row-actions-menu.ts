import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { AecButton } from '../../shared/button/button';
import { AecIcon } from '../../shared/icon/icon';

/** One item in a row's Actions menu. `destructive` reads in the error colour. */
export interface RowAction {
  readonly id: string;
  readonly label: string;
  readonly destructive?: boolean;
}

/**
 * The portal's per-row Actions menu (AECI-2213, `DESIGN.md` "Row actions menu"): one
 * icon button that opens a list of plain buttons, so a table row stays a row. Lifted
 * from the Billing tab's per-subscription menu (AECI-1391), which now uses it, so the
 * two menus behave alike (the Same-Behavior Rule).
 *
 * ── THE MENU ───────────────────────────────────────────────────────────────
 * A `BrnPopover`, the pattern of the header's `layout/user-menu.ts`: CDK overlay (so
 * a sideways-scrolling table does not clip it), focus trap, Tab between items, Escape
 * and outside-click close, focus back to the trigger, and `aria-haspopup` /
 * `aria-expanded` on the trigger. No `role="menu"` and no roving tabindex: the items
 * are buttons in a labelled list.
 *
 * Not `@angular/aria/menu` (ADR 0010's row for application menus) and not
 * `@angular/cdk/menu`. The header's eager combobox already imports a module that each
 * of them shares, and esbuild then keeps that whole module in `main`: Aria's menu
 * patterns, or CDK's list key manager (+7.8 kB raw). That cost lands on every public
 * page and breaks the 1.05 MB initial budget. `BrnPopover` is already eager, so this
 * menu adds nothing there. ADR 0010's 2026-10-16 amendment records the exception.
 *
 * ── PICKING AN ITEM ────────────────────────────────────────────────────────
 * A click moves focus to the trigger, closes the popover, then emits `picked`. The
 * focus move comes first: a dialog the host opens from `picked` saves the focused
 * element and hands focus back to it on close, and the menu item is about to be
 * destroyed. `picked` fires inside the click, so the host may call `BrnDialog.open()`
 * from it (never from an `effect()`, NG0602).
 */
@Component({
  selector: 'aec-row-actions-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton, AecIcon, BrnPopover, BrnPopoverContent, BrnPopoverTrigger],
  host: { class: 'inline-flex' },
  template: `
    <button
      #triggerEl
      aecButton
      variant="ghost"
      iconOnly
      type="button"
      brnPopoverTrigger
      [brnPopoverTriggerFor]="actionsMenu"
      [attr.aria-label]="label()"
      [class]="triggerClass"
      [attr.data-testid]="testId() + '-trigger'"
    >
      <aec-icon name="more-vertical" decorative />
    </button>

    <brn-popover #actionsMenu="brnPopover" class="contents" align="end" [sideOffset]="4">
      <ng-template brnPopoverContent>
        <ul
          [attr.aria-label]="label()"
          class="aec-popover m-0 flex min-w-[12rem] list-none flex-col gap-1 p-2"
          [attr.data-testid]="testId() + '-menu'"
        >
          @for (action of actions(); track action.id) {
            <li>
              <button
                type="button"
                (click)="pick(action.id)"
                [class]="action.destructive ? destructiveItemClass : itemClass"
                [attr.data-testid]="testId() + '-' + action.id"
              >
                {{ action.label }}
              </button>
            </li>
          }
        </ul>
      </ng-template>
    </brn-popover>
  `,
})
export class RowActionsMenu {
  /** The trigger's accessible name, also the list's: "Actions for {thing}". */
  readonly label = input.required<string>();
  /** The items, in order. Put a destructive item last. */
  readonly actions = input.required<readonly RowAction[]>();
  /** The `data-testid` prefix: `{testId}-trigger`, `{testId}-menu`, `{testId}-{id}`. */
  readonly testId = input('row-actions');
  /** The id of the picked item, emitted inside its click. */
  readonly picked = output<string>();

  private readonly popover = viewChild(BrnPopover);
  private readonly triggerEl = viewChild<ElementRef<HTMLButtonElement>>('triggerEl');

  /** Focus the trigger, for a host that needs focus back on the row. */
  focus(): void {
    this.triggerEl()?.nativeElement.focus();
  }

  protected pick(id: string): void {
    this.focus();
    this.popover()?.close();
    this.picked.emit(id);
  }

  /** The ghost icon button keeps a sunken fill while its menu is open. */
  protected readonly triggerClass = 'aria-expanded:bg-(--surface-sunken)';
  /**
   * A menu item: the header account menu's item recipe (`layout/user-menu.ts`). It
   * stays a native button, because a menu row is not a button look: full width, text
   * at the start, no frame.
   */
  protected readonly itemClass =
    'block min-h-11 w-full cursor-pointer rounded-mark px-3 py-2 text-start text-t-14 text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus:bg-(--surface-sunken) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
  /** A destructive item: the same recipe in the error colour, which also holds on hover. */
  protected readonly destructiveItemClass =
    'block min-h-11 w-full cursor-pointer rounded-mark px-3 py-2 text-start text-t-14 text-(--status-error) hover:bg-(--surface-sunken) focus:bg-(--surface-sunken) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';
}
