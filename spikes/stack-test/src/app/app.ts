import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { BrnButton } from '@spartan-ng/brain/button';

import { ThemeService } from './theme.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, BrnButton],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="min-h-screen flex flex-col">
      <header
        class="border-b border-(--border) bg-(--surface) px-6 py-4 flex items-center justify-between gap-6"
      >
        <a
          routerLink="/"
          class="font-medium tracking-tight text-(--text-primary) hover:text-(--accent)"
          i18n="@@app.brand"
        >
          AECi · stack-test
        </a>
        <nav class="flex gap-4 text-sm">
          <a
            routerLink="/"
            routerLinkActive="text-(--accent)"
            [routerLinkActiveOptions]="{ exact: true }"
            class="text-(--text-secondary) hover:text-(--text-primary)"
            i18n="@@app.nav.home"
          >
            Home
          </a>
          <a
            routerLink="/cached/abc"
            routerLinkActive="text-(--accent)"
            class="text-(--text-secondary) hover:text-(--text-primary)"
          >
            /cached/abc
          </a>
          <a
            routerLink="/cached/xyz"
            routerLinkActive="text-(--accent)"
            class="text-(--text-secondary) hover:text-(--text-primary)"
          >
            /cached/xyz
          </a>
          <a
            routerLink="/admin"
            routerLinkActive="text-(--accent)"
            class="text-(--text-secondary) hover:text-(--text-primary)"
            i18n="@@app.nav.admin"
          >
            Admin
          </a>
        </nav>
        <button
          brnButton
          type="button"
          (click)="theme.cycle()"
          class="text-sm px-3 py-1.5 rounded-md border border-(--border-strong) bg-(--surface-muted) text-(--text-primary) hover:bg-(--accent) hover:text-(--accent-fg) hover:border-(--accent) transition-colors cursor-pointer"
        >
          <ng-container i18n="@@app.theme.label">theme</ng-container>: {{ theme.choice() }} ({{
            theme.resolved()
          }})
        </button>
      </header>
      <main class="flex-1 px-6 py-10 max-w-3xl w-full mx-auto">
        <router-outlet />
      </main>
      <footer
        class="border-t border-(--border) px-6 py-4 text-xs text-(--text-muted)"
        i18n="@@app.footer"
      >
        Stack-validation probe · Angular 21 zoneless · Cloudflare Workers SSR · Spartan brain
        primitives
      </footer>
    </div>
  `,
  styles: [':host { display: block; min-height: 100vh; }'],
})
export class App {
  protected readonly theme = inject(ThemeService);
}
