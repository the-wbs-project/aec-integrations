import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  PLATFORM_ID,
  REQUEST,
  Service,
  Signal,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import {
  buildThemeCookieHeader,
  nextMode,
  parseThemeCookie,
  resolveMode,
  type Mode,
  type Resolved,
} from './theme.helpers';

export type { Mode, Resolved } from './theme.helpers';

const STORAGE_KEY = 'theme';
const DARK_CLASS = 'theme-dark';

@Service()
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly request = inject(REQUEST, { optional: true });

  private readonly _mode = signal<Mode>(this.readInitialMode());
  private readonly _systemDark = signal<boolean>(this.readInitialSystemDark());

  readonly mode: Signal<Mode> = this._mode.asReadonly();
  readonly resolved: Signal<Resolved> = computed(() =>
    resolveMode(this._mode(), this._systemDark()),
  );

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
      document.cookie = buildThemeCookieHeader(mode);
    }
  }

  cycle(): void {
    this.setMode(nextMode(this._mode()));
  }

  private readInitialMode(): Mode {
    if (isPlatformBrowser(this.platformId)) {
      return this.readCookieFromDocument() ?? 'system';
    }
    return this.readCookieFromRequest() ?? 'system';
  }

  private readInitialSystemDark(): boolean {
    // SSR must render visitor-state-neutral HTML for cacheable routes (§9.1a;
    // CLAUDE.md non-negotiable #6). `sec-ch-prefers-color-scheme` is per-visitor
    // state — honoring it server-side bakes a theme into the URL-keyed edge cache
    // and serves the first visitor's preference to everyone. So the server stays
    // neutral (`false`); the browser reconciles the real system preference
    // pre-paint (index.html inline script) and post-hydration (`afterNextRender`
    // + `matchMedia` below). The request header is deliberately never read here.
    return false;
  }

  private readCookieFromRequest(): Mode | null {
    return parseThemeCookie(this.request?.headers.get('cookie'));
  }

  private readCookieFromDocument(): Mode | null {
    return parseThemeCookie(this.document.cookie);
  }
}
