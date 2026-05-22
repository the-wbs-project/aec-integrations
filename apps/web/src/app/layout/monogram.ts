import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Theme-aware AECi monogram. Acts as the home link.
 *
 * Both variants are always present in the SSR HTML; CSS hides the inactive
 * one via `dark:hidden` / `dark:block` driven by the `.theme-dark` class on
 * `<html>`. This keeps the SSR output visitor-state-neutral so the edge cache
 * is never poisoned by a per-visitor `sec-ch-prefers-color-scheme` header.
 *
 * The two files in `apps/web/public/branding/` are named for their theme:
 * `monogram-light.svg` = dark-on-light (light theme), `monogram-dark.svg` =
 * light-on-dark (dark theme).
 */
@Component({
  selector: 'aec-monogram',
  imports: [NgOptimizedImage, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      routerLink="/"
      class="inline-flex items-center gap-2 rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n-aria-label="@@app.brand.aria"
      aria-label="AEC Integrations — home"
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
