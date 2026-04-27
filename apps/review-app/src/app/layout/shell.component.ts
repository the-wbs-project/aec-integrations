import { Component, HostListener, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { ThemeService, ThemeChoice } from '../services/theme.service';
import { NotificationsBellComponent } from './notifications-bell.component';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, NotificationsBellComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
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
