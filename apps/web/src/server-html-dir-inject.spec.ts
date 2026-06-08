import { describe, expect, it } from 'vitest';

import { injectHtmlLangDir } from './server-html-dir-inject';
import { DEFAULT_LOCALE, localeAttrsForPath, type LocaleEntry } from './server-runtime';

// Synthetic locale table: adds an RTL locale so the injection can be exercised
// without shipping a real i18n build (AECI-153 — dormant infra). The production
// `LOCALES` constant stays untouched (en-US LTR only); the `locales` parameter
// is what makes the helper testable without mutating that readonly constant.
const LOCALES_WITH_RTL: readonly LocaleEntry[] = [
  { locale: 'en-US', prefix: '', dir: 'ltr' },
  { locale: 'ar', prefix: '/ar', dir: 'rtl' },
];

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function req(path: string): Request {
  return new Request(`https://demo.aecintegrations.com${path}`);
}

describe('localeAttrsForPath', () => {
  it('resolves the default (en-US LTR) for an unprefixed path', () => {
    expect(localeAttrsForPath('/products', LOCALES_WITH_RTL)).toEqual({
      lang: 'en-US',
      dir: 'ltr',
    });
  });

  it('resolves the RTL locale on its exact prefix and on prefixed sub-paths', () => {
    expect(localeAttrsForPath('/ar', LOCALES_WITH_RTL)).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(localeAttrsForPath('/ar/products', LOCALES_WITH_RTL)).toEqual({
      lang: 'ar',
      dir: 'rtl',
    });
  });

  it('does not match a prefix that is merely a string-prefix of another segment', () => {
    // `/article` must NOT be treated as the `/ar` locale (segment boundary).
    expect(localeAttrsForPath('/article', LOCALES_WITH_RTL)).toEqual({
      lang: 'en-US',
      dir: 'ltr',
    });
  });

  it('defaults to en-US LTR against the production LOCALES table', () => {
    expect(localeAttrsForPath('/anything')).toEqual({ lang: DEFAULT_LOCALE, dir: 'ltr' });
  });
});

describe('injectHtmlLangDir', () => {
  it('rewrites the whole <html> tag for a non-default (RTL) locale', async () => {
    const res = htmlResponse(
      '<!doctype html><html lang="en-US" dir="ltr"><head></head><body>x</body></html>',
    );
    const out = await injectHtmlLangDir(res, req('/ar/products'), LOCALES_WITH_RTL);
    const html = await out.text();
    expect(html).toContain('<html lang="ar" dir="rtl">');
    expect(html).not.toContain('lang="en-US"');
    // Body content is otherwise preserved.
    expect(html).toContain('<body>x</body>');
  });

  it('overwrites pre-existing attrs regardless of order/quoting', async () => {
    const res = htmlResponse("<html dir='ltr' data-x lang=en-US><head></head></html>");
    const out = await injectHtmlLangDir(res, req('/ar'), LOCALES_WITH_RTL);
    expect(await out.text()).toContain('<html lang="ar" dir="rtl">');
  });

  it('strips content-length after rewriting so the runtime recomputes it', async () => {
    const body = '<html lang="en-US" dir="ltr"><head></head></html>';
    const res = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
      },
    });
    const out = await injectHtmlLangDir(res, req('/ar'), LOCALES_WITH_RTL);
    expect(out.headers.get('content-length')).toBeNull();
  });

  it('is a no-op (same response object) on the shipping en-US LTR path', async () => {
    const res = htmlResponse('<html lang="en-US" dir="ltr"><head></head></html>');
    const out = await injectHtmlLangDir(res, req('/products'), LOCALES_WITH_RTL);
    expect(out).toBe(res);
  });

  it('is a no-op for non-text/html responses even on an RTL path', async () => {
    const json = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const out = await injectHtmlLangDir(json, req('/ar/api/thing'), LOCALES_WITH_RTL);
    expect(out).toBe(json);
  });

  it('is a no-op when the body has no <html> tag (the cheap-text 404)', async () => {
    const res = htmlResponse('Page not found.', 404);
    const out = await injectHtmlLangDir(res, req('/ar/missing'), LOCALES_WITH_RTL);
    expect(out).toBe(res);
  });

  it('rewrites a full-document 404 — gated on content-type, not status', async () => {
    const res = htmlResponse(
      '<html lang="en-US" dir="ltr"><head></head><body>404</body></html>',
      404,
    );
    const out = await injectHtmlLangDir(res, req('/ar/missing'), LOCALES_WITH_RTL);
    expect(out.status).toBe(404);
    expect(await out.text()).toContain('<html lang="ar" dir="rtl">');
  });
});
