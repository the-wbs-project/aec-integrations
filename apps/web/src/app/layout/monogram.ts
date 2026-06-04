import { NgOptimizedImage } from '@angular/common';
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Theme-aware AECi monogram. Acts as the home link.
 *
 * Both variants are always present in the SSR HTML; CSS hides the inactive one
 * via `dark:hidden` / `dark:block`. The `dark:` variant is bound to the app's
 * `.theme-dark` class on `<html>` by the `@custom-variant dark` declaration in
 * `styles.css` (which overrides the Spartan preset's `.dark`-based default), so
 * the monogram follows the user's explicit theme choice — not the OS
 * `prefers-color-scheme` media query and not the never-set `.dark` class.
 *
 * Cache neutrality has two halves. Keeping both variants in the markup means the
 * monogram element itself is visitor-state-neutral. And `ThemeService` never
 * reads the per-visitor `sec-ch-prefers-color-scheme` request header during SSR
 * (`readInitialSystemDark()` returns `false` server-side), so `.theme-dark` is
 * never baked onto `<html>` from per-visitor state either. Together that keeps the
 * SSR output — and therefore the URL-keyed edge cache — free of per-visitor theme
 * state (§9.1a, CLAUDE.md non-negotiable #6; AECI-88).
 *
 * The two files in `apps/web/public/branding/` are named for their theme:
 * `monogram-light.svg` = dark-on-light (light theme), `monogram-dark.svg` =
 * light-on-dark (dark theme).
 */
@Component({
  selector: 'aec-monogram',
  imports: [NgOptimizedImage, RouterLink],
  template: `
    <a
      routerLink="/"
      class="inline-flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n-aria-label="@@app.brand.aria"
      aria-label="AEC Integrations home"
    >
      <img
        ngSrc="/branding/monogram-light.svg"
        [width]="size()"
        [height]="size()"
        alt=""
        priority
        class="block rounded-md dark:hidden"
      />
      <img
        ngSrc="/branding/monogram-dark.svg"
        [width]="size()"
        [height]="size()"
        alt=""
        priority
        class="hidden rounded-md dark:block"
      />
      @if (showWordmark()) {
        <span
          class="font-display font-semibold tracking-tight text-(--text-primary)"
          i18n="@@app.brand"
          >AEC Integrations</span
        >
      }
    </a>
  `,
})
export class Monogram {
  readonly size = input(32);
  readonly showWordmark = input(true);
}
