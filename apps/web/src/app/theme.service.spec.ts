import { describe, expect, it } from 'vitest';

import {
  COOKIE_MAX_AGE_SECONDS,
  COOKIE_NAME,
  buildThemeCookieHeader,
  nextMode,
  parseThemeCookie,
  resolveMode,
  type Mode,
} from './theme.helpers';

describe('parseThemeCookie', () => {
  it.each([
    ['theme=light', 'light'],
    ['theme=dark', 'dark'],
    ['theme=system', 'system'],
    ['theme=light; sb-access-token=abc', 'light'],
    ['sb-access-token=abc; theme=dark; csrf=xyz', 'dark'],
    ['  theme=light  ', 'light'],
    // First in-source match wins. Documents — and locks — current behavior.
    ['theme=light;theme=dark', 'light'],
  ])('parses %j as %s', (input, expected) => {
    expect(parseThemeCookie(input)).toBe(expected);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['no theme cookie', 'sb-access-token=abc'],
    ['empty value', 'theme='],
    ['value not in enum', 'theme=invalid'],
    // Parser is case-sensitive — assert so a future loosening is an intentional change.
    ['uppercase value', 'theme=DARK'],
    // Prefix/suffix names must not match. The check is `name === 'theme'`.
    ['name with suffix', 'themed=dark'],
    ['name with prefix', 'mytheme=dark'],
    ['name only, no =', 'theme'],
    // `rest.join('=')` reconstructs values containing `=`, but the result must
    // still be in the enum. `da=rk` is not, so the cookie is rejected.
    ['value containing =', 'theme=da=rk'],
  ])('returns null for %s', (_label, input) => {
    expect(parseThemeCookie(input)).toBeNull();
  });
});

describe('resolveMode', () => {
  it.each([
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', false, 'light'],
    ['system', true, 'dark'],
  ] as const)('maps (%s, systemDark=%s) → %s', (mode, systemDark, expected) => {
    expect(resolveMode(mode, systemDark)).toBe(expected);
  });
});

describe('nextMode', () => {
  it.each([
    ['light', 'dark'],
    ['dark', 'system'],
    ['system', 'light'],
  ] as const)('%s → %s', (current, expected) => {
    expect(nextMode(current)).toBe(expected);
  });

  it('returns to start after a full cycle', () => {
    expect(nextMode(nextMode(nextMode('light')))).toBe('light');
    expect(nextMode(nextMode(nextMode('dark')))).toBe('dark');
    expect(nextMode(nextMode(nextMode('system')))).toBe('system');
  });
});

describe('buildThemeCookieHeader', () => {
  function parseAttributes(header: string): {
    nameValue: string;
    attrs: Record<string, string | true>;
  } {
    const [nameValue, ...rest] = header.split(';').map((s) => s.trim());
    const attrs: Record<string, string | true> = {};
    for (const part of rest) {
      const eq = part.indexOf('=');
      if (eq === -1) attrs[part] = true;
      else attrs[part.slice(0, eq)] = part.slice(eq + 1);
    }
    return { nameValue, attrs };
  }

  it.each(['light', 'dark', 'system'] as const)(
    'emits a Path=/, SameSite=Lax cookie for %s with the source-of-truth Max-Age',
    (mode) => {
      const { nameValue, attrs } = parseAttributes(buildThemeCookieHeader(mode));
      expect(nameValue).toBe(`${COOKIE_NAME}=${mode}`);
      expect(attrs['Path']).toBe('/');
      expect(attrs['Max-Age']).toBe(String(COOKIE_MAX_AGE_SECONDS));
      expect(attrs['SameSite']).toBe('Lax');
      // The cookie is read by the inline pre-paint script in index.html and by
      // document.cookie post-hydration; neither flag is desired. Locking the
      // intent so a future change is explicit.
      expect(attrs['Secure']).toBeUndefined();
      expect(attrs['HttpOnly']).toBeUndefined();
    },
  );

  it.each(['light', 'dark', 'system'] as const satisfies readonly Mode[])(
    'round-trips through parseThemeCookie for %s',
    (mode) => {
      expect(parseThemeCookie(buildThemeCookieHeader(mode))).toBe(mode);
    },
  );
});
