import { Component } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header class="shell-header">
      <div class="shell-header__inner">
        <div class="shell-header__brand">
          <span class="shell-header__title">AEC Integrations</span>
          <span class="shell-header__label">review</span>
        </div>
        <nav class="nav" aria-label="Main navigation">
          <a
            class="nav__item"
            routerLink="/tools"
            routerLinkActive="nav__item--active"
          >
            Tools
          </a>
          <a
            class="nav__item"
            routerLink="/vendors"
            routerLinkActive="nav__item--active"
          >
            Vendors
          </a>
        </nav>
      </div>
    </header>
    <main class="shell-main">
      <router-outlet />
    </main>
  `,
  styles: `
    .shell-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: var(--color-bg-elevated);
      border-bottom: 0.5px solid var(--color-border-default);
    }

    .shell-header__inner {
      display: flex;
      align-items: center;
      gap: var(--space-8);
      max-width: 1440px;
      margin: 0 auto;
      padding: 0 var(--space-6);
      height: 48px;
    }

    .shell-header__brand {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .shell-header__title {
      font-size: var(--text-sm);
      font-weight: 500;
      color: var(--color-text-primary);
    }

    .shell-header__label {
      font-size: var(--text-xs);
      font-weight: 500;
      color: var(--color-accent);
      background: var(--color-accent-bg);
      padding: 2px var(--space-2);
      border-radius: var(--radius-sm);
      line-height: 1;
    }

    .shell-main {
      min-height: calc(100vh - 48px);
    }
  `,
})
export class ShellComponent {}
