import { Component, DestroyRef, inject } from '@angular/core';

import { PlanInquiryDialog } from './plan-inquiry-dialog';
import { PlanInquiryService } from './plan-inquiry.service';

/**
 * The one plan inquiry dialog for a page (AECI-1279). Mount it once; every
 * `aecPlanInquiryTrigger` link on the page opens it. While it is mounted the triggers
 * open the dialog; without it they follow their link to `/contact?topic=managed`.
 *
 * The dialog is `@defer`-loaded on the first open, so it adds nothing to the page's
 * initial JS and renders nothing into the cached SSR HTML.
 */
@Component({
  selector: 'aec-plan-inquiry-host',
  host: { class: 'contents' },
  imports: [PlanInquiryDialog],
  template: `
    @defer (when inquiry.isOpen()) {
      <aec-plan-inquiry-dialog />
    }
  `,
})
export class PlanInquiryHost {
  protected readonly inquiry = inject(PlanInquiryService);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(this.inquiry.attachHost());
  }
}
