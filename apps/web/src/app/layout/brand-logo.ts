import { NgOptimizedImage } from '@angular/common';
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * AEC Integrations primary wordmark: "AEC" in semibold and "Integrations" in
 * light, joined by the clay "integration" mark (dot-link-dot). Acts as the
 * home link.
 *
 * Rendered as an `<img>` of `/branding/wordmark.svg`, not inline SVG. Google's
 * OAuth branding check rejected the consent-screen logo instantly because the
 * homepage carried no logo image and no visible brand name: the old inline SVG
 * was `aria-hidden` artwork. An image with `alt="AEC Integrations"` gives a
 * crawler both. The SVG bakes Forest `#1E3A2F` and Clay `#E89668` as hex, the
 * same values as `--accent-primary` / `--accent-secondary`. The site is light
 * only (AECI-226), so the tokens never resolve to anything else.
 *
 * Cache-neutral: the markup is identical for every visitor (§9.1a).
 *
 * The link's `aria-label` stays the accessible name, so screen readers still
 * hear "AEC Integrations home" and not the image alt.
 *
 * Connector geometry deliberately diverges from the landing page's: measured in
 * the system font, "AEC" ink ends at x≈52.3 and "Integrations" ink starts at
 * x=86.5, so the landing's connector (centre 72.25) sat ~10.5 from "AEC" but
 * only ~4.75 from "Integrations". The mark is shifted ~2.85 left (centre ≈69.4)
 * to sit optically centred in that gap. Keep it balanced if the text x-values
 * in `wordmark.svg` ever change.
 */
@Component({
  selector: 'aec-brand-logo',
  // The host is a flex container so the inner `<a>` is laid out as a flex item,
  // not inline-flow text. As an inline-level element the `<a>` would sit on the
  // host's text baseline and the line-box strut would reserve ~7px of descent
  // *below* it, inflating the host box and floating the wordmark above its own
  // centre — which knocked it ~4px out of vertical alignment with the adjacent
  // hamburger button in the `items-center` header row. Flex layout drops the
  // strut so the host box hugs the wordmark exactly.
  host: { class: 'inline-flex items-center' },
  imports: [RouterLink, NgOptimizedImage],
  template: `
    <a
      routerLink="/"
      class="inline-flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      [style.height.px]="height()"
      i18n-aria-label="@@app.brand.aria"
      aria-label="AEC Integrations home"
    >
      <img
        class="block h-full w-auto"
        ngSrc="/branding/wordmark.svg"
        [priority]="priority()"
        width="220"
        height="30"
        i18n-alt="@@app.brand.logoAlt"
        alt="AEC Integrations"
      />
    </a>
  `,
})
export class BrandLogo {
  /** Rendered height of the wordmark in px. Width scales from the viewBox ratio. */
  readonly height = input(32);

  /**
   * Loads the image eagerly at high fetch priority. True for the header, where
   * the wordmark is above the fold. The footer passes `false`.
   */
  readonly priority = input(true);
}
