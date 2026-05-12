import { DOCUMENT } from '@angular/common';
import {
  Injectable,
  PLATFORM_ID,
  REQUEST,
  Signal,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const COOKIE_NAME = 'theme';
const STORAGE_KEY = 'theme';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly request = inject(REQUEST, { optional: true });

  private readonly _choice = signal<ThemeChoice>(this.readInitialChoice());
  private readonly _systemDark = signal<boolean>(this.readInitialSystemDark());

  readonly choice: Signal<ThemeChoice> = this._choice.asReadonly();
  readonly resolved: Signal<ResolvedTheme> = computed(() => {
    const c = this._choice();
    if (c === 'system') return this._systemDark() ? 'dark' : 'light';
    return c;
  });

  constructor() {
    // Apply data-theme to <html> on every change (server + client).
    effect(() => {
      const theme = this.resolved();
      this.document.documentElement.setAttribute('data-theme', theme);
    });

    // Browser-only: sync with localStorage and matchMedia after hydration.
    afterNextRender(() => {
      if (!isPlatformBrowser(this.platformId)) return;
      const stored = localStorage.getItem(STORAGE_KEY) as ThemeChoice | null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        this._choice.set(stored);
      }
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      this._systemDark.set(mql.matches);
      mql.addEventListener('change', (e) => this._systemDark.set(e.matches));
    });
  }

  set(choice: ThemeChoice): void {
    this._choice.set(choice);
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(STORAGE_KEY, choice);
      // Cookie survives across page loads — this is what SSR reads.
      const oneYear = 60 * 60 * 24 * 365;
      document.cookie = `${COOKIE_NAME}=${choice}; Path=/; Max-Age=${oneYear}; SameSite=Lax`;
    }
  }

  cycle(): void {
    const order: ThemeChoice[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(this._choice()) + 1) % order.length];
    this.set(next);
  }

  private readInitialChoice(): ThemeChoice {
    if (isPlatformBrowser(this.platformId)) {
      // Hydration parity: trust the cookie that SSR also read. localStorage is
      // applied later in afterNextRender to avoid mismatch.
      return this.readCookieFromDocument() ?? 'system';
    }
    return this.readCookieFromRequest() ?? 'system';
  }

  private readInitialSystemDark(): boolean {
    // SSR: use Client Hints header if present, else assume light.
    const hint = this.request?.headers.get('sec-ch-prefers-color-scheme');
    if (hint) return hint.toLowerCase() === 'dark';
    return false;
  }

  private readCookieFromRequest(): ThemeChoice | null {
    const cookie = this.request?.headers.get('cookie');
    return parseThemeCookie(cookie);
  }

  private readCookieFromDocument(): ThemeChoice | null {
    return parseThemeCookie(this.document.cookie);
  }
}

function parseThemeCookie(raw: string | null | undefined): ThemeChoice | null {
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) {
      const val = rest.join('=');
      if (val === 'light' || val === 'dark' || val === 'system') return val;
    }
  }
  return null;
}
