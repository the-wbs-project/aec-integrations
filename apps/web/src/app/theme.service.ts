import { DOCUMENT, isPlatformBrowser } from '@angular/common';
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

export type Mode = 'system' | 'light' | 'dark';
export type Resolved = 'light' | 'dark';

const COOKIE_NAME = 'theme';
const STORAGE_KEY = 'theme';
const DARK_CLASS = 'theme-dark';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly request = inject(REQUEST, { optional: true });

  private readonly _mode = signal<Mode>(this.readInitialMode());
  private readonly _systemDark = signal<boolean>(this.readInitialSystemDark());

  readonly mode: Signal<Mode> = this._mode.asReadonly();
  readonly resolved: Signal<Resolved> = computed(() => {
    const m = this._mode();
    if (m === 'system') return this._systemDark() ? 'dark' : 'light';
    return m;
  });

  constructor() {
    effect(() => {
      const html = this.document.documentElement;
      if (this.resolved() === 'dark') html.classList.add(DARK_CLASS);
      else html.classList.remove(DARK_CLASS);
    });

    afterNextRender(() => {
      if (!isPlatformBrowser(this.platformId)) return;
      const stored = localStorage.getItem(STORAGE_KEY) as Mode | null;
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        this._mode.set(stored);
      }
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      this._systemDark.set(mql.matches);
      mql.addEventListener('change', (e) => this._systemDark.set(e.matches));
    });
  }

  setMode(mode: Mode): void {
    this._mode.set(mode);
    if (isPlatformBrowser(this.platformId)) {
      localStorage.setItem(STORAGE_KEY, mode);
      document.cookie = `${COOKIE_NAME}=${mode}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
    }
  }

  cycle(): void {
    const order: Mode[] = ['light', 'dark', 'system'];
    const next = order[(order.indexOf(this._mode()) + 1) % order.length];
    this.setMode(next);
  }

  private readInitialMode(): Mode {
    if (isPlatformBrowser(this.platformId)) {
      return this.readCookieFromDocument() ?? 'system';
    }
    return this.readCookieFromRequest() ?? 'system';
  }

  private readInitialSystemDark(): boolean {
    const hint = this.request?.headers.get('sec-ch-prefers-color-scheme');
    if (hint) return hint.toLowerCase() === 'dark';
    return false;
  }

  private readCookieFromRequest(): Mode | null {
    return parseThemeCookie(this.request?.headers.get('cookie'));
  }

  private readCookieFromDocument(): Mode | null {
    return parseThemeCookie(this.document.cookie);
  }
}

function parseThemeCookie(raw: string | null | undefined): Mode | null {
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
