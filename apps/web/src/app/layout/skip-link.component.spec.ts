import { PLATFORM_ID, provideZonelessChangeDetection } from '@angular/core';
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

  function configure(platform: 'browser' | 'server') {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '**', component: Stub }]),
        { provide: PLATFORM_ID, useValue: platform },
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

    it('renders the path only, so a cached page never carries another URL query', async () => {
      expect(href(await render('/products/egnyte?utm_source=x&page=2'))).toBe(
        '/products/egnyte#main',
      );
    });
  });
});
