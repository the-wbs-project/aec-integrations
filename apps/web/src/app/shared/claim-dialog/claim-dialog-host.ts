import { Component, DestroyRef, inject } from '@angular/core';

import { ClaimDialog } from './claim-dialog';
import { ClaimDialogService } from './claim-dialog.service';

/**
 * The one claim dialog for a page (AECI-1293). Mount it once; every
 * `aecClaimDialogTrigger` link on the page, and Find your product, open it. Without
 * it the triggers follow their link to Find your product on `/vendor-program`.
 *
 * The dialog is `@defer`-loaded on the first open, so it adds nothing to the page's
 * initial JS and renders nothing into the cached SSR HTML.
 */
@Component({
  selector: 'aec-claim-dialog-host',
  host: { class: 'contents' },
  imports: [ClaimDialog],
  template: `
    @defer (when dialog.isOpen()) {
      <aec-claim-dialog />
    }
  `,
})
export class ClaimDialogHost {
  protected readonly dialog = inject(ClaimDialogService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(this.dialog.attachHost());
  }
}
