/**
 * AECI-960 / §6.7 — `ViewPublicLink`, the portal's way out to the public catalog.
 *
 * Everything asserted here fails SILENTLY if it regresses. A link with the
 * `target` dropped still renders and still navigates; what it costs is the
 * unsaved form state in the tab the vendor left, and `apps/web` has no
 * `CanDeactivate` guard to warn them. A missing `rel="noopener"` still renders.
 * A missing new-tab announcement still renders. None of it shows up in a visual
 * review, and axe flags none of it.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { ViewPublicLink } from './view-public-link';

async function create(href: string, ariaLabel: string | null = null) {
  const fixture: ComponentFixture<ViewPublicLink> = TestBed.createComponent(ViewPublicLink);
  fixture.componentRef.setInput('href', href);
  if (ariaLabel !== null) fixture.componentRef.setInput('ariaLabel', ariaLabel);
  fixture.detectChanges();
  return fixture;
}

const anchor = (fixture: ComponentFixture<ViewPublicLink>) =>
  (fixture.nativeElement as HTMLElement).querySelector('a') as HTMLAnchorElement;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});

describe('ViewPublicLink', () => {
  it('renders a plain href, not a routerLink', async () => {
    const link = anchor(await create('/products/revit'));

    // A router navigation would stay in the portal tab and discard unsaved form
    // state. It would also not reach the public route at all under the portal's
    // lazy child routes.
    expect(link.getAttribute('href')).toBe('/products/revit');
    expect(link.hasAttribute('routerLink')).toBe(false);
  });

  it('opens a new tab with noopener', async () => {
    const link = anchor(await create('/vendors/acme'));

    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener');
  });

  it('announces the new tab', async () => {
    const fixture = await create('/vendors/acme');
    const host = fixture.nativeElement as HTMLElement;
    const note = host.querySelector('.sr-only');

    expect(note?.textContent?.trim()).toBe('(opens in a new tab)');
    // Beside the anchor, not inside it, matching the two shipped admin sites
    // (admin/vendors/vendor-detail.html, vendor-products-table.html).
    expect(link_contains_note(host)).toBe(false);
  });

  it('falls back to the visible text as the accessible name when unnamed', async () => {
    const link = anchor(await create('/vendors/acme'));

    // Correct ONLY for a once-per-page link. The repeated case must pass a name.
    expect(link.hasAttribute('aria-label')).toBe(false);
    expect(link.textContent?.trim()).toBe('View public page');
  });

  it('applies a caller-supplied accessible name', async () => {
    const label = 'View public page: the Revit and Procore integration (opens in a new tab)';
    const link = anchor(await create('/products/revit/integrations/procore', label));

    expect(link.getAttribute('aria-label')).toBe(label);
    // The visible text is unchanged; only the announced name narrows.
    expect(link.textContent?.trim()).toBe('View public page');
  });

  it('drops the sr-only note when the name already states the new tab', async () => {
    const fixture = await create(
      '/products/revit/integrations/procore',
      'View public page: the Revit and Procore integration (opens in a new tab)',
    );

    // Both would announce the disclosure in browse mode, one after the other.
    // The name has to carry it (a rotor or links list never reads the sibling
    // span), so the span is the one that goes.
    expect((fixture.nativeElement as HTMLElement).querySelector('.sr-only')).toBeNull();
  });
});

function link_contains_note(host: HTMLElement): boolean {
  return host.querySelector('a .sr-only') !== null;
}
