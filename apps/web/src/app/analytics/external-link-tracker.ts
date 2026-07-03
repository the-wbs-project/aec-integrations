import { Directive, ElementRef, inject, input } from '@angular/core';

import { Analytics } from './analytics';

/**
 * Fires the `external_link_clicked` PostHog event (§14.1) when an outbound
 * anchor is activated. Applied to the `target="_blank"` links on detail pages
 * (vendor/product website, integration listing/docs/connector URLs).
 *
 * The destination is read from the host element's resolved `href` at click
 * time, and `source` is the surface that owns the link (e.g.
 * `'product_detail'`). Capture is fire-and-forget and consent-gated inside
 * `Analytics`, so a click is never blocked by analytics.
 *
 *   <a [href]="p.website" target="_blank" aecTrackExternalLink="product_detail">…</a>
 */
@Directive({
  selector: '[aecTrackExternalLink]',
  host: { '(click)': 'onClick()' },
})
export class ExternalLinkTracker {
  private readonly analytics = inject(Analytics);
  private readonly el = inject<ElementRef<HTMLAnchorElement>>(ElementRef);

  /** The surface the link lives on — recorded as the event's `source`. */
  readonly source = input.required<string>({ alias: 'aecTrackExternalLink' });

  protected onClick(): void {
    const destination = this.el.nativeElement.href;
    if (!destination) return;
    this.analytics.externalLinkClicked({ destination, source: this.source() });
  }
}
