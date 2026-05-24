/**
 * Angular-free helpers backing `ThemeService`. Kept in a separate module so
 * the unit spec can import them under Vitest without dragging
 * `@angular/common`'s partial-compiled `PlatformLocation` into the test
 * process (which would require the JIT compiler).
 */

export type Mode = 'system' | 'light' | 'dark';
export type Resolved = 'light' | 'dark';

export const COOKIE_NAME = 'theme';
export const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function parseThemeCookie(raw: string | null | undefined): Mode | null {
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

export function resolveMode(mode: Mode, systemDark: boolean): Resolved {
  if (mode === 'system') return systemDark ? 'dark' : 'light';
  return mode;
}

export function nextMode(current: Mode): Mode {
  const order: Mode[] = ['light', 'dark', 'system'];
  return order[(order.indexOf(current) + 1) % order.length];
}

export function buildThemeCookieHeader(mode: Mode): string {
  return `${COOKIE_NAME}=${mode}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}
