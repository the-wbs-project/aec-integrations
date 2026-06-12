import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  effect,
  inject,
  viewChild,
} from '@angular/core';
import {
  BrnDialog,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogTitle,
  provideBrnDialogDefaultOptions,
} from '@spartan-ng/brain/dialog';

import { RequestDrawerService } from './request-drawer.service';
import { RequestFormBody } from './request-form-body';

/**
 * In-place claim/correction drawer (AECI-128) — a bottom-right floating card (a
 * bottom sheet on mobile) that overlays a detail page so the visitor can read what
 * they're correcting while filling the form. Mounted once per detail page; reads its
 * target from the root `RequestDrawerService`, which any `aecRequestTrigger` on the
 * page drives.
 *
 * Built on Spartan `BrnDialog` (the account-dialog primitive). A browser-only
 * `effect()` drives the dialog imperatively from `service.isOpen()` (`open()` /
 * `close()` — the same calls `brnDialogTrigger` makes); SSR never opens it, so the
 * cached detail-page HTML is drawer-neutral. The backdrop is transparent
 * (`aeci-drawer-backdrop`) so the page stays visible, and `scrollStrategy="reposition"`
 * keeps it scrollable; clicking the backdrop or pressing Escape closes (both converge
 * on `service.close()` via the `closed` output). Focus trap, autofocus, and
 * focus-return-to-trigger come from BrnDialog/CDK.
 *
 * a11y: the panel's accessible name comes from `brnDialogTitle` (BrnDialog wires
 * `aria-labelledby` onto the role=dialog panel); per the account-dialog note we do NOT
 * put `aria-labelledby` on a wrapper that has no role.
 */
@Component({
  selector: 'aec-request-drawer',
  imports: [BrnDialog, BrnDialogContent, BrnDialogTitle, BrnDialogDescription, RequestFormBody],
  // backdropClass / scrollStrategy aren't BrnDialog @Inputs — they're set via the
  // default-options token. A transparent backdrop keeps the page visible (the
  // 50%-dim default is overridden by `.aeci-drawer-backdrop` in styles.css);
  // `reposition` keeps the page scrollable while open. The remaining built-in
  // defaults are already what we want (hasBackdrop, closeOnBackdropClick,
  // autoFocus='first-tabbable', ariaModal, role='dialog').
  providers: [
    provideBrnDialogDefaultOptions({
      backdropClass: 'aeci-drawer-backdrop',
      scrollStrategy: 'reposition',
    }),
  ],
  templateUrl: './request-drawer.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RequestDrawer {
  protected readonly drawer = inject(RequestDrawerService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly dialog = viewChild(BrnDialog);

  constructor() {
    // Browser-only: open/close the CDK overlay imperatively when the shared
    // service state changes. `viewChild` resolves after view init, so the dialog
    // is present by the time `isOpen()` first flips. SSR never runs this, so the
    // overlay never renders on the server (cache-neutral).
    if (this.isBrowser) {
      effect(() => {
        const open = this.drawer.isOpen();
        const dlg = this.dialog();
        if (!dlg) return;
        if (open) {
          dlg.open();
        } else {
          dlg.close();
        }
      });
    }
  }
}
