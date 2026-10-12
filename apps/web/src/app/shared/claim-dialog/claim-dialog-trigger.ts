import { isPlatformBrowser } from '@angular/common';
import { Directive, PLATFORM_ID, inject, input } from '@angular/core';

import type { PlanInterest } from '@aeci/shared';

import type { ClaimDialogEntry, PlanCtaPage } from '../../analytics/analytics';

import { ClaimDialogService } from './claim-dialog.service';

/**
 * Opens the claim dialog from a "Claim your listing" or "Start with Managed" link
 * (AECI-1293, `VENDOR_PROGRAM_PAGE_SPEC.md` §15.1), the `PlanInquiryTrigger` pattern.
 *
 * Progressive enhancement: the anchor keeps a plain `href`
 * (`CLAIM_DIALOG_FALLBACK_HREF`, the search page). Without JS,
 * before hydration, on a page with no `ClaimDialogHost`, or on a modified or
 * non-primary click, the link is followed. A plain `href`, not `routerLink`, because
 * `RouterLink` navigates whether or not the click was prevented.
 */
@Directive({
  selector: 'a[aecClaimDialogTrigger]',
  host: { '(click)': 'onClick($event)' },
})
export class ClaimDialogTrigger {
  private readonly dialog = inject(ClaimDialogService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** Which control this is, for `claim_dialog_step.entry`. */
  readonly entry = input.required<ClaimDialogEntry>({ alias: 'aecClaimDialogTrigger' });
  /** Which page it sits on. */
  readonly aecClaimDialogPage = input.required<PlanCtaPage>();
  /** The plan step's seed: `managed` from a Managed control, `free` from the Free card. */
  readonly aecClaimDialogPlan = input<PlanInterest | null>(null);

  protected onClick(event: MouseEvent): void {
    if (!this.isBrowser || !this.dialog.hosted()) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    this.dialog.open({
      page: this.aecClaimDialogPage(),
      entry: this.entry(),
      plan: this.aecClaimDialogPlan(),
    });
  }
}
