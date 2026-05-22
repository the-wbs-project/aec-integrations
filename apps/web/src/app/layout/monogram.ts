import { NgOptimizedImage } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ThemeService } from '../theme.service';

/**
 * Theme-aware AECi monogram. Acts as the home link.
 *
 * The two monogram variants in `apps/web/public/branding/` are named for the
 * theme they belong with (not for their fill colour): `monogram-light.svg`
 * is the dark-on-light variant used in the light theme, and `monogram-dark.svg`
 * is the light-on-dark variant used in the dark theme.
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
        [ngSrc]="src()"
        [width]="size()"
        [height]="size()"
        alt=""
        priority
        class="block rounded-md"
      />
      @if (showWordmark()) {
        <span
          class="font-display font-semibold tracking-tight text-(--text-primary)"
          i18n="@@app.brand"
        >AEC Integrations</span>
      }
    </a>
  `,
})
export class Monogram {
  readonly size = input(32);
  readonly showWordmark = input(true);

  private readonly theme = inject(ThemeService);

  protected readonly src = computed(() =>
    this.theme.resolved() === 'dark'
      ? '/branding/monogram-dark.svg'
      : '/branding/monogram-light.svg',
  );
}
