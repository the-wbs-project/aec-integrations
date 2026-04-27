import { Component, HostListener, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService, ThemeChoice } from '../services/theme.service';
import { NotificationsBellComponent } from './notifications-bell.component';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NotificationsBellComponent],
  template: `
    <header class="shell-header" [class.shell-header--scrolled]="scrolled()">
      <div class="shell-header__inner">
        <a routerLink="/" class="shell-header__brand" aria-label="AEC Integrations Review">
          <span class="shell-header__brand-mark" aria-hidden="true"></span>
          <span class="shell-header__brand-text">
            <span class="shell-header__brand-name">AEC Integrations</span>
            <span class="shell-header__brand-tag">Review</span>
          </span>
        </a>
        <nav class="nav" aria-label="Main navigation">
          <a class="nav__item" routerLink="/" routerLinkActive="nav__item--active" [routerLinkActiveOptions]="{ exact: true }">Dashboard</a>
          <a class="nav__item" routerLink="/tools" routerLinkActive="nav__item--active">Tools</a>
          <a class="nav__item" routerLink="/vendors" routerLinkActive="nav__item--active">Vendors</a>
          <a class="nav__item" routerLink="/runs" routerLinkActive="nav__item--active">Runs</a>
        </nav>
        <div class="shell-header__actions">
          <app-notifications-bell />
          <button
            type="button"
            class="theme-toggle"
            (click)="theme.cycle()"
            [attr.aria-label]="themeToggleLabel()"
            [title]="themeToggleLabel()"
          >
            @switch (theme.choice()) {
              @case ('light') {
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                </svg>
              }
              @case ('dark') {
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              }
              @default {
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="12" rx="2" />
                  <path d="M8 20h8M12 16v4" />
                </svg>
              }
            }
          </button>
        </div>
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
      transition: box-shadow var(--duration-base) var(--easing-default);
    }

    .shell-header--scrolled {
      box-shadow: var(--shadow-sm);
    }

    .shell-header__inner {
      display: flex;
      align-items: center;
      gap: var(--space-6);
      max-width: 1440px;
      margin: 0 auto;
      padding: 0 var(--space-6);
      height: 52px;
    }

    .shell-header__brand {
      display: inline-flex;
      align-items: center;
      gap: var(--space-2);
      text-decoration: none;
      color: inherit;
    }

    .shell-header__brand:hover { text-decoration: none; }

    .shell-header__brand-mark {
      width: 22px;
      height: 22px;
      border-radius: 5px;
      background:
        linear-gradient(135deg, var(--color-brand-forest) 0%, var(--color-brand-forest) 55%, var(--color-accent) 55%, var(--color-accent) 100%);
      box-shadow: 0 0 0 0.5px var(--color-border-default);
    }

    .shell-header__brand-text {
      display: inline-flex;
      align-items: baseline;
      gap: var(--space-2);
    }

    .shell-header__brand-name {
      font-size: var(--text-sm);
      font-weight: 600;
      color: var(--color-text-primary);
      letter-spacing: -0.005em;
    }

    .shell-header__brand-tag {
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--color-text-secondary);
    }

    .nav { margin-left: var(--space-2); }

    .shell-header__actions {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .shell-main {
      min-height: calc(100vh - 52px);
    }
  `,
})
export class ShellComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly scrolled = signal(false);

  protected themeToggleLabel(): string {
    const c = this.theme.choice();
    if (c === 'light') return 'Theme: Light. Click for Dark';
    if (c === 'dark') return 'Theme: Dark. Click for System';
    return 'Theme: System. Click for Light';
  }

  @HostListener('window:scroll')
  onScroll(): void {
    this.scrolled.set(window.scrollY > 4);
  }
}
