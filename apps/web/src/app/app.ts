import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { SiteFooter } from './layout/site-footer';
import { SiteHeader } from './layout/site-header';
import { SkipLink } from './layout/skip-link';
import { ThemeService } from './theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SiteHeader, SiteFooter, SkipLink],
  template: `
    <div class="flex min-h-screen flex-col bg-(--surface-base) text-(--text-primary)">
      <aec-skip-link />
      <aec-site-header />
      <main id="main" class="flex-1">
        <router-outlet />
      </main>
      <aec-site-footer />
    </div>
  `,
  styles: [':host { display: block; min-height: 100vh; }'],
})
export class App {
  // Ensures ThemeService instantiates at bootstrap so SSR resolves theme from
  // request headers before the first render.
  protected readonly theme = inject(ThemeService);
}
