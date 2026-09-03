/**
 * AECI-777 — `AdminBreadcrumb`.
 *
 * The trail is DERIVED, so what these tests pin is the derivation, not markup:
 * that a nav-able screen gets its category and label from `ADMIN_NAV_GROUPS`
 * without either being restated here, that a detail route resolves its parent
 * structurally rather than from a table, and that the two ways a crumb can be
 * non-navigable — a category, which has no route, and the page you are on — both
 * render as text.
 *
 * The stale-label case is the one worth having: nothing clears
 * `AdminBreadcrumbStore` on navigation, so a label published by the last detail
 * screen is still sitting there while the next one fetches. It must not be shown.
 * The store keys on the entity id precisely so that is structural, and this is
 * the test that says so.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminBreadcrumb } from './admin-breadcrumb';
import { AdminBreadcrumbStore } from './admin-breadcrumb.store';

const VENDOR_ID = '00000000-0000-4000-8000-000000000010';

/** Render the trail at `url`. A catch-all route so `navigateByUrl` resolves any
 *  path — the component reads the URL, not the route config. */
async function renderAt(url: string): Promise<{ el: HTMLElement; store: AdminBreadcrumbStore }> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([{ path: '**', children: [] }])],
  });
  const store = TestBed.inject(AdminBreadcrumbStore);
  await TestBed.inject(Router).navigateByUrl(url);
  const fixture = TestBed.createComponent(AdminBreadcrumb);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return { el: fixture.nativeElement as HTMLElement, store };
}

/** The visible trail, separators dropped — they are `aria-hidden` decoration. */
function trail(el: HTMLElement): string[] {
  return [...el.querySelectorAll('li')]
    .filter((li) => li.getAttribute('aria-hidden') !== 'true')
    .map((li) => li.textContent?.trim() ?? '');
}

function links(el: HTMLElement): Array<{ text: string; href: string }> {
  return [...el.querySelectorAll('a')].map((a) => ({
    text: a.textContent?.trim() ?? '',
    href: a.getAttribute('href') ?? '',
  }));
}

describe('AdminBreadcrumb', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('derivation from the route', () => {
    it('names the category and the screen from ADMIN_NAV_GROUPS', async () => {
      const { el } = await renderAt('/admin/overview');
      expect(trail(el)).toEqual(['Admin', 'Insights', 'Overview']);
    });

    it('reads the category out of the group the screen actually sits in', async () => {
      // Connectors is under Catalog and Vendors under Operations — the trail must
      // follow the array, not the URL's alphabetical accident.
      expect(trail((await renderAt('/admin/connectors')).el)).toEqual([
        'Admin',
        'Catalog',
        'Connectors',
      ]);
      expect(trail((await renderAt('/admin/vendors')).el)).toEqual([
        'Admin',
        'Operations',
        'Vendors',
      ]);
    });

    it('ignores the query string — a filter is not a location', async () => {
      const { el } = await renderAt('/admin/users?banned=true');
      expect(trail(el)).toEqual(['Admin', 'Operations', 'Users']);
    });
  });

  describe('detail routes', () => {
    it('resolves the parent structurally and appends the entity crumb', async () => {
      const { el } = await renderAt(`/admin/vendors/${VENDOR_ID}`);
      expect(trail(el)).toEqual(['Admin', 'Operations', 'Vendors', 'Vendor']);
      // The section crumb is now a LINK, because it is no longer where you are.
      expect(links(el)).toContainEqual({ text: 'Vendors', href: '/admin/vendors' });
    });

    it('shows the published label once it describes this id', async () => {
      const { el, store } = await renderAt(`/admin/vendors/${VENDOR_ID}`);
      store.publish(VENDOR_ID, 'Autodesk, Inc.');
      TestBed.tick();
      expect(trail(el).at(-1)).toBe('Autodesk, Inc.');
    });

    it('ignores a label left over from the previously-viewed entity', async () => {
      const { el, store } = await renderAt(`/admin/vendors/${VENDOR_ID}`);
      store.publish('some-other-id', 'Trimble Inc.');
      TestBed.tick();
      // Falls back to the section word rather than naming the wrong vendor.
      expect(trail(el).at(-1)).toBe('Vendor');
    });

    it('uses the section fallback word for each detail pair', async () => {
      expect(trail((await renderAt('/admin/users/u1')).el).at(-1)).toBe('Account');
      expect(trail((await renderAt('/admin/claims/c1')).el).at(-1)).toBe('Vendor claim');
      expect(trail((await renderAt('/admin/connectors/k1')).el).at(-1)).toBe('Connector catalogue');
    });
  });

  describe('what is and is not navigable', () => {
    it('never links the category — there is no /admin/operations route', async () => {
      const { el } = await renderAt('/admin/vendors');
      expect(links(el).map((l) => l.text)).not.toContain('Operations');
    });

    it('never links the current page, and marks it aria-current', async () => {
      const { el } = await renderAt('/admin/vendors');
      expect(links(el).map((l) => l.text)).not.toContain('Vendors');
      const current = el.querySelector('[aria-current="page"]');
      expect(current?.textContent?.trim()).toBe('Vendors');
      expect(el.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    });

    it('links the root at /admin', async () => {
      const { el } = await renderAt('/admin/vendors');
      expect(links(el)).toContainEqual({ text: 'Admin', href: '/admin' });
    });
  });

  describe('degradation', () => {
    it('shows the root alone for a path that names no screen', async () => {
      // A typo, or a route in the router but not in the nav. Better a short trail
      // than an invented one.
      const { el } = await renderAt('/admin/nope');
      expect(trail(el)).toEqual(['Admin']);
      expect(links(el)).toEqual([]);
    });

    it('shows the root alone at bare /admin', async () => {
      const { el } = await renderAt('/admin');
      expect(trail(el)).toEqual(['Admin']);
    });
  });

  describe('accessibility', () => {
    it('is a named Breadcrumb landmark, distinct from the nav row', async () => {
      const { el } = await renderAt('/admin/vendors');
      const nav = el.querySelector('nav');
      expect(nav?.getAttribute('aria-label')).toBe('Breadcrumb');
    });

    it('emits no heading — the shell owns the h1 and the screen owns the h2', async () => {
      // ADMIN_PANEL_SPEC.md §5: a heading here would sit between them and break
      // axe's heading-order rule. Same conclusion as the nav's group labels.
      const { el } = await renderAt(`/admin/vendors/${VENDOR_ID}`);
      expect(el.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    });

    it('hides the separators from assistive tech', async () => {
      const { el } = await renderAt(`/admin/vendors/${VENDOR_ID}`);
      const separators = [...el.querySelectorAll('li[aria-hidden="true"]')];
      // Four crumbs → three separators.
      expect(separators).toHaveLength(3);
      expect(separators.every((s) => s.textContent?.trim() === '›')).toBe(true);
    });
  });
});
