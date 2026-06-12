import { isPlatformBrowser } from '@angular/common';
import { Directive, PLATFORM_ID, inject, input } from '@angular/core';

import type { RequestKind, RequestTargetType } from '@aeci/shared';

import { RequestDrawerService } from './request-drawer.service';

/**
 * Opens the in-place claim/correction `RequestDrawer` from a detail-page anchor
 * (AECI-128), instead of navigating to the routed form page — so the visitor keeps
 * the product/vendor they're correcting in view.
 *
 * Progressive enhancement: the anchor keeps its `[routerLink]`/`href`. With JS we
 * `preventDefault()` and open the drawer; without it — or before hydration — the
 * click falls through to the routed `/…/{claim,correction}` page (same destination,
 * just full-page). Modified clicks (new-tab/window, middle-click) are left alone so
 * the fallback page opens as the user expects.
 */
@Directive({
  selector: 'a[aecRequestTrigger]',
  host: {
    '(click)': 'onClick($event)',
  },
})
export class RequestTrigger {
  private readonly drawer = inject(RequestDrawerService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  readonly entity = input.required<RequestTargetType>();
  readonly kind = input.required<RequestKind>();
  readonly slug = input.required<string>();

  protected onClick(event: MouseEvent): void {
    if (!this.isBrowser) return;
    // Let the browser handle new-tab/window and non-primary clicks via the
    // anchor's href (the routed fallback form).
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    this.drawer.open({ entity: this.entity(), kind: this.kind(), slug: this.slug() });
  }
}
