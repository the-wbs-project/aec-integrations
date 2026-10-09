import { Directive, ElementRef, inject, input } from '@angular/core';

import { Analytics, type ExternalLinkContext } from './analytics';

/**
 * Fires the `external_link_clicked` PostHog event (§14.1) when an outbound
 * anchor is activated. Applied to the `target="_blank"` links on detail pages
 * (vendor/product website, vendor socials, the pair card's listing, docs and
 * price links).
 *
 * The destination is read from the host element's resolved `href` at click
 * time, and `source` is the surface that owns the link (e.g.
 * `'product_detail'`). `aecLinkContext` carries the ownership facts
 * (AECI-933, `docs/VENDOR_PERFORMANCE_SPEC.md` §3.2): whose site it is, whose
 * link it is, the page it came from and what it is for. The input is required,
 * so a surface that forgets it does not compile. Capture is fire-and-forget and
 * consent-gated inside `Analytics`, so a click is never blocked by analytics.
 *
 *   <a [href]="p.website" target="_blank" aecTrackExternalLink="product_detail"
 *      [aecLinkContext]="websiteLinkContext()">…</a>
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

  /** The link's ownership facts, spread into the event as-is. Unaliased: the
   *  lint rule allows an alias only when it matches the selector. */
  readonly aecLinkContext = input.required<ExternalLinkContext>();

  protected onClick(): void {
    const destination = this.el.nativeElement.href;
    if (!destination) return;
    this.analytics.externalLinkClicked({
      destination,
      source: this.source(),
      ...this.aecLinkContext(),
    });
  }
}
