import { Location } from '@angular/common';
import {
  PLATFORM_ID,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  provideZonelessChangeDetection,
  type Provider,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { SkipLink } from './skip-link';

/**
 * AECI-1839: the app ships `<base href="/">`, so a bare `href="#main"` resolves to `/#main`
 * and loads the home page on every route but `/`. The href must carry the current path.
 */
describe('SkipLink', () => {
  const Stub = class {};

  function configure(platform: 'browser' | 'server', extra: Provider[] = []) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '**', component: Stub }]),
        { provide: PLATFORM_ID, useValue: platform },
        ...extra,
      ],
    });
  }

  async function render(url: string) {
    const router = TestBed.inject(Router);
    await router.navigateByUrl(url);
    const fixture = TestBed.createComponent(SkipLink);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture;
  }

  function href(fixture: { nativeElement: HTMLElement }): string | null {
    return fixture.nativeElement.querySelector('a')!.getAttribute('href');
  }

  describe('in the browser', () => {
    beforeEach(() => configure('browser'));

    it('points at #main on the home route', async () => {
      expect(href(await render('/'))).toBe('/#main');
    });

    it('keeps the path on a non-root URL', async () => {
      expect(href(await render('/products/egnyte'))).toBe('/products/egnyte#main');
    });

    it('keeps the query string so the jump never reloads or drops filters', async () => {
      expect(href(await render('/products?category_id=3&page=2'))).toBe(
        '/products?category_id=3&page=2#main',
      );
    });

    it('replaces a fragment already in the URL', async () => {
      expect(href(await render('/products/egnyte?x=1#reviews'))).toBe('/products/egnyte?x=1#main');
    });

    it('follows a client-side navigation', async () => {
      const fixture = await render('/products/egnyte');
      await TestBed.inject(Router).navigateByUrl('/docs/vendors/plans?tab=a');
      fixture.detectChanges();
      expect(href(fixture)).toBe('/docs/vendors/plans?tab=a#main');
    });

    it('never renders a bare fragment href', async () => {
      expect(href(await render('/legal/terms'))).not.toBe('#main');
    });
  });

  describe('on the server', () => {
    beforeEach(() => configure('server'));

    it('drops a query on a cached route whose key ignores it', async () => {
      expect(href(await render('/products/egnyte?utm_source=x&page=2'))).toBe(
        '/products/egnyte#main',
      );
    });

    it('keeps the listing params the cache key keeps, and drops utm_*', async () => {
      expect(href(await render('/products?page=2&sort=name'))).toBe(
        '/products?page=2&sort=name#main',
      );
      expect(href(await render('/products?utm_source=x&sort=name&page=2'))).toBe(
        '/products?page=2&sort=name#main',
      );
    });

    it('keeps view on the product pair page', async () => {
      expect(href(await render('/products/revit/integrations/procore?view=basic&fbclid=1'))).toBe(
        '/products/revit/integrations/procore?view=basic#main',
      );
    });

    it('keeps the whole query on a route the edge never caches', async () => {
      expect(href(await render('/search?q=x&utm_source=y'))).toBe('/search?q=x&utm_source=y#main');
    });

    it('keeps the token on an email token page (AECI-1848)', async () => {
      expect(href(await render('/unsubscribe?token=x'))).toBe('/unsubscribe?token=x#main');
    });
  });

  // AECI-1848 review: a render on the runtime's non-cacheable branch is never stored unless it
  // is a 404, so its server href keeps the whole query. `/contact?topic=add-product` shows a
  // panel only with its topic.
  describe('on the server, non-cacheable branch', () => {
    const uncached = (status?: number): Provider[] => [
      { provide: REQUEST_CONTEXT, useValue: { edgeCacheable: false } },
      { provide: RESPONSE_INIT, useValue: status === undefined ? {} : { status } },
    ];

    it('keeps the whole query on a 200 render', async () => {
      configure('server', uncached());
      expect(href(await render('/contact?topic=add-product'))).toBe(
        '/contact?topic=add-product#main',
      );
    });

    it('drops the query on a 404 render, which the edge stores under a path-only key', async () => {
      configure('server', uncached(404));
      expect(href(await render('/typo?token=secret'))).toBe('/typo#main');
    });

    it('recomputes when a resolver sets 404 after the shell was built', async () => {
      const init: { status?: number } = {};
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          provideZonelessChangeDetection(),
          provideRouter([
            {
              path: '**',
              component: Stub,
              resolve: {
                _: () => {
                  init.status = 404;
                  return true;
                },
              },
            },
          ]),
          { provide: PLATFORM_ID, useValue: 'server' },
          { provide: REQUEST_CONTEXT, useValue: { edgeCacheable: false } },
          { provide: RESPONSE_INIT, useValue: init },
        ],
      });
      TestBed.inject(Location).replaceState('/typo?token=secret');
      const fixture = TestBed.createComponent(SkipLink);
      fixture.detectChanges();
      expect(href(fixture)).toBe('/typo?token=secret#main');
      await TestBed.inject(Router).navigateByUrl('/typo?token=secret');
      await fixture.whenStable();
      expect(href(fixture)).toBe('/typo#main');
    });

    it('drops the query when the runtime rendered on the cacheable branch', async () => {
      configure('server', [{ provide: REQUEST_CONTEXT, useValue: { edgeCacheable: true } }]);
      expect(href(await render('/contact?topic=add-product'))).toBe('/contact#main');
    });
  });

  describe('when the URL changes without a router navigation', () => {
    beforeEach(() => configure('browser'));

    it('follows Location.replaceState, as the vendor filter writes it', async () => {
      const fixture = await render('/vendor/acme?tab=integrations');
      TestBed.inject(Location).replaceState('/vendor/acme', 'tab=integrations&status=live');
      fixture.detectChanges();
      expect(href(fixture)).toBe('/vendor/acme?tab=integrations&status=live#main');
    });
  });

  it('shows a Bone fill, Forest text and a Bone ring on focus, so it is visible over the Forest header', () => {
    const fixture = TestBed.createComponent(SkipLink);
    fixture.detectChanges();

    const classes = (fixture.nativeElement.querySelector('a') as HTMLElement).className;
    expect(classes).toContain('focus:bg-(--accent-warm)');
    expect(classes).toContain('focus:text-(--accent-primary)');
    expect(classes).toContain('focus:outline-(--focus-ring-on-brand)');
    expect(classes).not.toContain('focus:bg-(--accent-primary)');
  });

  // AECI-1777: the 44px target, the 12px radius and the 16px size.
  it('is a 44px target with the control radius and 16px text on focus', () => {
    const fixture = TestBed.createComponent(SkipLink);
    fixture.detectChanges();

    const classes = (fixture.nativeElement.querySelector('a') as HTMLElement).className;
    expect(classes).toContain('focus:min-h-11');
    expect(classes).toContain('focus:rounded-control');
    expect(classes).toContain('focus:text-t-16');
    expect(classes).toContain('focus:inline-flex');
    expect(classes).toContain('focus:items-center');
  });
});
