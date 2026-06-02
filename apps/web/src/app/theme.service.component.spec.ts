/**
 * SSR cache-neutrality tests for `ThemeService` (AECI-88, spec §9.1a /
 * CLAUDE.md non-negotiable #6).
 *
 * The edge cache is keyed by URL only. On a cacheable route the SSR Worker
 * strips the `theme` cookie, so `_mode` falls back to `'system'` and the only
 * thing that could still force dark during SSR is the per-visitor
 * `sec-ch-prefers-color-scheme` request header. If the server honored it, one
 * cache-miss request carrying `dark` would bake `class="theme-dark"` onto
 * `<html>` and poison the cache for every later visitor. These tests pin that
 * the server stays theme-neutral regardless of that header; the browser
 * reconciles the real system preference post-hydration.
 *
 * Uses the `.component.spec.ts` suffix so it runs under the Angular build test
 * pipeline (`ng test` / `@angular/build:unit-test`) with full TestBed + jsdom,
 * which `ThemeService` needs for DI (`REQUEST`, `PLATFORM_ID`, `DOCUMENT`) and
 * its constructor `effect`. The plain Vitest project excludes this file.
 */
import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID, REQUEST } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ThemeService } from './theme.service';

const DARK_CLASS = 'theme-dark';

/** Build a server request with an optional color-scheme hint and/or cookie. */
function makeRequest(opts: { header?: string; cookie?: string }): Request {
  const headers = new Headers();
  if (opts.header !== undefined) headers.set('sec-ch-prefers-color-scheme', opts.header);
  if (opts.cookie !== undefined) headers.set('cookie', opts.cookie);
  return new Request('https://aecintegrations.com/', { headers });
}

/**
 * Construct `ThemeService` as it runs during SSR: `PLATFORM_ID` server + the
 * given request bound to the `REQUEST` token. Flushes the constructor `effect`
 * so `<html>`'s class reflects `resolved()`.
 */
function injectServerThemeService(request: Request): { service: ThemeService; doc: Document } {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: 'server' },
      { provide: REQUEST, useValue: request },
    ],
  });
  const service = TestBed.inject(ThemeService);
  const doc = TestBed.inject(DOCUMENT);
  TestBed.tick();
  return { service, doc };
}

describe('ThemeService SSR cache-neutrality (AECI-88, §9.1a)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    // DOCUMENT is the shared jsdom document — clear any class a prior suite left.
    document.documentElement.classList.remove(DARK_CLASS);
  });

  // AC1 + AC2: identical, theme-dark-free SSR output regardless of the header
  // value (including the uppercase form the old code lower-cased and honored,
  // and the absent case) when no `theme` cookie is present.
  it.each([
    { header: 'dark', label: 'dark' },
    { header: 'light', label: 'light' },
    { header: 'DARK', label: 'uppercase DARK' },
    { header: undefined, label: 'absent' },
  ])(
    'renders neutral light HTML when sec-ch-prefers-color-scheme is $label and no cookie is present',
    ({ header }) => {
      const { service, doc } = injectServerThemeService(makeRequest({ header }));

      expect(service.resolved()).toBe('light');
      expect(doc.documentElement.classList.contains(DARK_CLASS)).toBe(false);
    },
  );

  it('still honors an explicit theme=dark cookie server-side (the fix is scoped to the header)', () => {
    // Non-cacheable routes pass the cookie through; an explicit dark choice must
    // still render dark on the server. Only the system/header path changed.
    // (This also proves the constructor effect runs under TestBed.tick().)
    const { service, doc } = injectServerThemeService(makeRequest({ cookie: 'theme=dark' }));

    expect(service.resolved()).toBe('dark');
    expect(doc.documentElement.classList.contains(DARK_CLASS)).toBe(true);
  });
});
