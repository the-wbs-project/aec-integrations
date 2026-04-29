import { Component, HostListener, inject, signal } from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService, ThemeChoice } from '../services/theme.service';
import { AuthService } from '../services/auth.service';
import { NotificationsBellComponent } from './notifications-bell.component';
import { ModelSelectorComponent } from './model-selector.component';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NotificationsBellComponent, ModelSelectorComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class ShellComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  protected readonly scrolled = signal(false);
  protected readonly signingOut = signal(false);

  protected themeToggleLabel(): string {
    const c = this.theme.choice();
    if (c === 'light') return 'Theme: Light. Click for Dark';
    if (c === 'dark') return 'Theme: Dark. Click for System';
    return 'Theme: System. Click for Light';
  }

  protected async signOut(): Promise<void> {
    if (this.signingOut()) return;
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
      await this.router.navigate(['/login']);
    } finally {
      this.signingOut.set(false);
    }
  }

  @HostListener('window:scroll')
  onScroll(): void {
    this.scrolled.set(window.scrollY > 4);
  }
}
