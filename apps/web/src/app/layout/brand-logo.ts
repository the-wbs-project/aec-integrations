import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * AEC Integrations primary wordmark — the same logo the marketing landing page
 * renders in its header (`apps/landing/public/index.html`): "AEC" in semibold
 * and "Integrations" in light, joined by the clay "integration" mark
 * (dot–link–dot). Acts as the home link.
 *
 * Theme-aware *and* cache-neutral by construction. The wordmark is a single
 * inline SVG whose ink comes from design tokens, not from baked-in hex or a
 * per-theme asset:
 *   - text → `var(--accent-primary)`   (Forest in light, lighter Forest in dark)
 *   - mark → `var(--accent-secondary)` (Clay, both themes)
 * Both are applied via `currentColor`: the link sets `text-(--accent-primary)`
 * so the glyphs inherit Forest, and the mark elements override `color` to Clay.
 *
 * `--accent-primary` flips when `.theme-dark` is toggled on `<html>`, so the
 * logo follows the user's *explicit* in-app theme — never the OS
 * `prefers-color-scheme`, never the never-set Spartan `.dark` class. The
 * AECI-94 failure mode (a `dark:` utility keyed off the wrong class) is
 * structurally impossible here because no `dark:` variant is used. And because
 * the SSR HTML is identical for every visitor — the colour resolves client-side
 * from the CSS custom properties — the URL-keyed edge cache stays free of
 * per-visitor theme state (§9.1a, CLAUDE.md non-negotiable #6).
 *
 * The glyphs live inside the SVG as artwork (a logo is a proper noun, not
 * localised); the link carries the accessible, translatable name. The system
 * font stack mirrors the landing-page logo so the two render identically.
 *
 * Connector geometry deliberately diverges from the landing page's: measured in
 * the system font, "AEC" ink ends at x≈52.3 and "Integrations" ink starts at
 * x=86.5, so the landing's connector (centre 72.25) sat ~10.5 from "AEC" but
 * only ~4.75 from "Integrations". The mark is shifted ~2.85 left (centre ≈69.4)
 * to sit optically centred in that gap. Keep it balanced if the text x-values
 * ever change.
 */
@Component({
  selector: 'aec-brand-logo',
  imports: [RouterLink],
  template: `
    <a
      routerLink="/"
      class="inline-flex items-center rounded-md text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      [style.height.px]="height()"
      i18n-aria-label="@@app.brand.aria"
      aria-label="AEC Integrations home"
    >
      <svg
        class="block h-full w-auto"
        viewBox="3 25 220 30"
        fill="currentColor"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        focusable="false"
      >
        <text
          x="10"
          y="47"
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          font-size="22"
          font-weight="600"
          letter-spacing="-0.3"
        >
          AEC
        </text>
        <circle cx="62.4" cy="40" r="2.5" class="text-(--accent-secondary)" />
        <line
          x1="65.9"
          y1="40"
          x2="72.9"
          y2="40"
          class="text-(--accent-secondary)"
          stroke="currentColor"
          stroke-width="1.5"
        />
        <circle cx="76.4" cy="40" r="2.5" class="text-(--accent-secondary)" />
        <text
          x="86.5"
          y="47"
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
          font-size="22"
          font-weight="300"
          letter-spacing="-0.3"
        >
          Integrations
        </text>
      </svg>
    </a>
  `,
})
export class BrandLogo {
  /** Rendered height of the wordmark in px. Width scales from the viewBox ratio. */
  readonly height = input(32);
}
