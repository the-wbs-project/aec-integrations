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

  it('announces the new tab INSIDE the anchor', async () => {
    const fixture = await create('/vendors/acme');
    const host = fixture.nativeElement as HTMLElement;
    const note = host.querySelector('.sr-only');

    expect(note?.textContent?.trim()).toBe('(opens in a new tab)');
    // AECI-980 moved this note from beside the anchor to inside it. A sibling
    // span is not read in a VoiceOver rotor or an NVDA+F7 links list, so the
    // old placement disclosed the new tab in browse mode and nowhere else.
    expect(link_contains_note(host)).toBe(true);
  });

  it('draws the new tab for a sighted reader', async () => {
    const link = anchor(await create('/vendors/acme'));

    // The half no audit tool reports: before AECI-980 this link told a screen
    // reader about the new tab and told a sighted reader nothing at all.
    expect(link.querySelector('svg')).not.toBeNull();
    expect(link.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the visible text as the accessible name when unnamed', async () => {
    const link = anchor(await create('/vendors/acme'));

    // Correct ONLY for a once-per-page link. The repeated case must pass a name.
    expect(link.hasAttribute('aria-label')).toBe(false);
    expect(visibleText(link)).toBe('View public page');
  });

  it('applies a caller-supplied accessible name', async () => {
    const label = 'View public page: the Revit and Procore integration (opens in a new tab)';
    const link = anchor(await create('/products/revit/integrations/procore', label));

    expect(link.getAttribute('aria-label')).toBe(label);
    // The visible text is unchanged; only the announced name narrows.
    expect(visibleText(link)).toBe('View public page');
  });

  it('keeps the sr-only note under a caller-supplied name, which suppresses it anyway', async () => {
    const fixture = await create(
      '/products/revit/integrations/procore',
      'View public page: the Revit and Procore integration (opens in a new tab)',
    );

    // AECI-980 deleted the old `@if (!ariaLabel())` guard. An aria-label REPLACES
    // the anchor's contents for assistive tech, so the note cannot be announced
    // twice and does not need removing. The caller's name states the new tab
    // itself, which is why it must — nothing in the markup can do it for them.
    expect((fixture.nativeElement as HTMLElement).querySelector('.sr-only')).not.toBeNull();
  });
});

function link_contains_note(host: HTMLElement): boolean {
  return host.querySelector('a .sr-only') !== null;
}

/** The anchor's text with the sr-only new-tab note stripped back out. */
function visibleText(link: HTMLAnchorElement): string {
  const clone = link.cloneNode(true) as HTMLAnchorElement;
  clone.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return clone.textContent?.trim() ?? '';
}
