import { isPlatformBrowser } from '@angular/common';
import { Directive, PLATFORM_ID, inject, input } from '@angular/core';

import type { PlanCtaPage, PlanInquiryPlacement } from '../../analytics/analytics';

import { PlanInquiryService } from './plan-inquiry.service';

/**
 * Opens the plan inquiry dialog from a "Talk to us about Managed" link (AECI-1279),
 * in place of navigating to `/contact?topic=managed`.
 *
 * Progressive enhancement, as `RequestTrigger` does it: the anchor keeps a plain
 * `href` to `/contact?topic=managed`, which carries the same form. Without JS, before
 * hydration, or on a page with no `PlanInquiryHost`, the click follows the link. A
 * modified or non-primary click (new tab, new window) is left alone too. A plain
 * `href`, not `routerLink`, because `RouterLink` navigates whether or not the click
 * was prevented.
 */
@Directive({
  selector: 'a[aecPlanInquiryTrigger]',
  host: { '(click)': 'onClick($event)' },
})
export class PlanInquiryTrigger {
  private readonly inquiry = inject(PlanInquiryService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Which button this is, carried to `plan_inquiry_submitted`. */
  readonly placement = input.required<PlanInquiryPlacement>({ alias: 'aecPlanInquiryTrigger' });
  /** Which page this button sits on, carried to `plan_inquiry_submitted`. */
  readonly aecPlanInquiryPage = input.required<PlanCtaPage>();

  protected onClick(event: MouseEvent): void {
    if (!this.isBrowser || !this.inquiry.hosted()) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    this.inquiry.open(this.placement(), this.aecPlanInquiryPage());
  }
}
