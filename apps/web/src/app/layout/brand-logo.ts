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
 * The letters are outlined paths, not `<text>`. Until 2026-10-17 the file drew
 * live text in the visitor's system font, so the connector gaps varied by OS
 * and the brand spec's 7-unit gaps held on exactly one platform. The outlines
 * come from Atkinson Hyperlegible Next (the body font, SIL Open Font License),
 * so the mark renders identically everywhere and the spec's gaps are measured
 * on the file itself: C ink ends at x=50.34, first dot starts at 57.34,
 * second dot ends at 76.34, I ink starts at 83.34. Rebuild instructions and the
 * full coordinate table are in `branding/logo-construction.md` §The wordmark.
 * The `branding/` wordmark family, stacked logo, monogram and OG cards were
 * outlined the same day, so every logo asset shares these letterforms.
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
        width="196"
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
