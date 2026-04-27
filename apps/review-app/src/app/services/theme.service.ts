import { Injectable, computed, signal } from '@angular/core';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'review-app:theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _choice = signal<ThemeChoice>(this.readStoredChoice());
  private readonly _systemPrefersDark = signal<boolean>(this.readSystemPrefersDark());

  readonly choice = this._choice.asReadonly();
  readonly resolved = computed<ResolvedTheme>(() => {
    const c = this._choice();
    if (c === 'system') return this._systemPrefersDark() ? 'dark' : 'light';
    return c;
  });

  constructor() {
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = (e: MediaQueryListEvent) => {
        this._systemPrefersDark.set(e.matches);
        this.applyAttribute();
      };
      mql.addEventListener('change', onChange);
    }
    this.applyAttribute();
  }

  set(choice: ThemeChoice): void {
    this._choice.set(choice);
    try {
      if (choice === 'system') {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        localStorage.setItem(STORAGE_KEY, choice);
      }
    } catch {
      // localStorage may be unavailable (private mode, SSR) — ignore
    }
    this.applyAttribute();
  }

  cycle(): void {
    const next: Record<ThemeChoice, ThemeChoice> = {
      light: 'dark',
      dark: 'system',
      system: 'light',
    };
    this.set(next[this._choice()]);
  }

  private applyAttribute(): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', this.resolved());
  }

  private readStoredChoice(): ThemeChoice {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === 'light' || raw === 'dark') return raw;
    } catch {
      // ignore
    }
    return 'system';
  }

  private readSystemPrefersDark(): boolean {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
}
