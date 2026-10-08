import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { ProductIntegrationRow } from './product-integration-row';

// Context product is "Procore"; the *other* endpoint is "Autodesk BIM 360".
const OTHER: ProductLink = {
  id: 't1',
  slug: 'autodesk-bim-360',
  name: 'Autodesk BIM 360',
  logo_url: null,
};

// `context_direction` is the server-precomputed, context-relative direction
// (claims-aware, §3.2) the row renders verbatim — the row no longer re-frames.
const baseIntegration: ProductIntegrationItem = {
  id: '00000000-0000-4000-8000-000000040001',
  name: 'Procore → BIM 360',
  mechanism_kind: 'api',
  mechanism_name: 'REST connector',
  direction: 'a_to_b',
  context_direction: 'outbound',
  source: { id: 's1', slug: 'procore', name: 'Procore', logo_url: null },
  target: OTHER,
  via: null,
  powered_by_product: null,
  data_object_slugs: [],
  created_at: '2024-03-01T00:00:00.000Z',
  updated_at: '2024-06-15T00:00:00.000Z',
};

@Component({
  imports: [ProductIntegrationRow],
  template: `
    <table>
      <tbody>
        <tr
          aec-product-integration-row
          [integration]="integration()"
          [other]="other()"
          [contextSlug]="contextSlug()"
        ></tr>
      </tbody>
    </table>
  `,
})
class Host {
  integration = signal<ProductIntegrationItem>(baseIntegration);
  other = signal<ProductLink>(OTHER);
  contextSlug = signal('procore');
}

function setup(overrides: Partial<Host> = {}) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  const host = fixture.componentInstance;
  if (overrides.integration) host.integration = overrides.integration;
  if (overrides.other) host.other = overrides.other;
  if (overrides.contextSlug) host.contextSlug = overrides.contextSlug;
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, host };
}

describe('ProductIntegrationRow', () => {
  it('links the partner product name to the partner product page', () => {
    const { el } = setup();
    const link = el.querySelector('a[href="/products/autodesk-bim-360"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Autodesk BIM 360');
  });

  it('renders the product-PAIR page link (context = this product) in the trailing cell', () => {
    const { el } = setup();
    const pair = el.querySelector<HTMLAnchorElement>(
      'a[href="/products/procore/integrations/autodesk-bim-360"]',
    );
    expect(pair).not.toBeNull();
    // Named for assistive tech; it is the row's one link to the pair page.
    expect(pair?.getAttribute('aria-label')).toContain('Autodesk BIM 360');
    const cells = el.querySelectorAll('td');
    expect(pair!.closest('td')).toBe(cells[cells.length - 1]);
  });

  // Safari < 27 computes `position: relative` on a <tr> as `static`, so a
  // stretched `absolute inset-0` link anchored to the row covered the whole
  // viewport instead (every row's overlay stacked over the page). jsdom cannot
  // measure layout, so guard the structure: no positioned row, no overlay link.
  it('does not anchor a stretched overlay link to the <tr> (Safari < 27 regression)', () => {
    const { el } = setup();
    const row = el.querySelector('tr')!;
    expect(row.className).not.toContain('relative');
    for (const a of Array.from(el.querySelectorAll('a'))) {
      expect(a.className).not.toMatch(/\babsolute\b|\binset-0\b/);
    }
  });

  it('forwards a click anywhere else on the row to the pair-page link', () => {
    const { el } = setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    el.querySelectorAll('td')[1]!.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toBe(
      '/products/procore/integrations/autodesk-bim-360',
    );
  });

  it('lets the partner link keep its own destination', () => {
    const { el } = setup();
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    el.querySelector<HTMLAnchorElement>('a[href="/products/autodesk-bim-360"]')!.click();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(String(navigate.mock.calls[0]![0])).toBe('/products/autodesk-bim-360');
  });

  it('opens the pair page in a new tab on a Cmd/Ctrl click elsewhere on the row', () => {
    const { el } = setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    el.querySelectorAll('td')[1]!.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0]![0])).toContain(
      '/products/procore/integrations/autodesk-bim-360',
    );
    open.mockRestore();
  });

  it('does not nest the two links (partner link is a sibling, not inside the pair link)', () => {
    const { el } = setup();
    const pair = el.querySelector<HTMLAnchorElement>(
      'a[href="/products/procore/integrations/autodesk-bim-360"]',
    )!;
    const partner = el.querySelector<HTMLAnchorElement>('a[href="/products/autodesk-bim-360"]')!;
    expect(pair.contains(partner)).toBe(false);
    expect(partner.contains(pair)).toBe(false);
    expect(pair.querySelector('a')).toBeNull();
  });

  // AECI-853 folded Direction out of its own leading cell and into the meta line
  // under the partner name, which is the FIRST cell. The row is now two content
  // cells + the trailing nav chevron, so these assertions read cells[0] for
  // both the partner and the direction, and cells[1] for the connection.
  it('renders "Outbound" in the partner cell meta line when data leaves this product', () => {
    const { el } = setup();
    const cells = el.querySelectorAll('td');
    expect(cells[0]?.textContent).toContain('Outbound');
    expect(cells[0]?.textContent).toContain('→');
  });

  it('renders "Inbound" when data arrives from the other product', () => {
    const { el } = setup({
      integration: signal({ ...baseIntegration, context_direction: 'inbound' }),
    });
    const cells = el.querySelectorAll('td');
    expect(cells[0]?.textContent).toContain('Inbound');
    expect(cells[0]?.textContent).toContain('←');
  });

  it('renders "Both" with the ⇄ glyph for a bidirectional flow', () => {
    const { el } = setup({
      integration: signal({ ...baseIntegration, context_direction: 'both' }),
    });
    const cells = el.querySelectorAll('td');
    expect(cells[0]?.textContent).toContain('Both');
    expect(cells[0]?.textContent).toContain('⇄');
  });

  it('renders exactly two content cells plus the trailing chevron (no Direction column)', () => {
    const { el } = setup();
    expect(el.querySelectorAll('td').length).toBe(3);
  });

  // AECI-919. The trailing cell used to render a literal "\u2192", the same character
  // `directionGlyph('outbound')` emits into the meta line of this same row — two
  // arrows, two meanings, one row. It is a navigation affordance, so it is now a
  // Lucide chevron-right and carries no direction vocabulary at all.
  it('renders the nav affordance as a chevron, never a direction arrow', () => {
    const { el } = setup();
    const nav = el.querySelectorAll('td')[2]!;

    expect(nav.textContent).not.toContain('\u2192');
    expect(nav.textContent).not.toContain('\u2190');
    expect(nav.textContent).not.toContain('\u21C4');

    const chevron = nav.querySelector('svg')!;
    expect(chevron).toBeTruthy();
    // Lucide `chevron-right`; aria-hidden because the enclosing pair link
    // already carries the accessible name for this row's destination.
    expect(chevron.querySelector('path')?.getAttribute('d')).toBe('m9 18 6-6-6-6');
    expect(chevron.getAttribute('aria-hidden')).toBe('true');
  });

  // The direction arrow in the meta line is the one arrow that survives, and it
  // has to keep working — the chevron swap must not have taken it with it.
  it('still renders a direction glyph in the meta line, distinct from the chevron', () => {
    const { el } = setup();
    const cells = el.querySelectorAll('td');
    expect(cells[0]?.textContent).toContain('\u2192');
    expect(cells[2]?.textContent).not.toContain('\u2192');
  });

  it('keeps the direction in the same cell as the partner name', () => {
    const { el } = setup();
    const partnerCell = el.querySelector('td')!;
    expect(partnerCell.querySelector('a[href="/products/autodesk-bim-360"]')).not.toBeNull();
    expect(partnerCell.textContent).toContain('Outbound');
  });

  // The <th> that named this value is gone, so the sr-only prefix is the only
  // thing left telling a screen reader what "Outbound" is a property OF.
  it('labels the direction for assistive tech with an sr-only prefix', () => {
    const { el } = setup();
    const prefix = [...el.querySelectorAll('span.sr-only')].find((s) =>
      s.textContent?.includes('Direction:'),
    );
    expect(prefix).toBeDefined();
  });

  it('renders the mechanism_kind badge and mechanism_name in the connection cell', () => {
    const { el } = setup();
    const cells = el.querySelectorAll('td');
    expect(cells[1]?.textContent).toContain('API');
    expect(cells[1]?.textContent).toContain('REST connector');
  });

  it('renders an en-dash placeholder when the context direction is unknown', () => {
    const { el } = setup({
      integration: signal({ ...baseIntegration, context_direction: null }),
    });
    const placeholder = el.querySelector('span[aria-label="Direction not listed"]');
    expect(placeholder?.textContent?.trim()).toBe('–');
  });

  it('renders an en-dash placeholder when mechanism_kind is null (AECI-115, no native fallback)', () => {
    const { el } = setup({ integration: signal({ ...baseIntegration, mechanism_kind: null }) });
    const placeholder = el.querySelector('span[aria-label="Mechanism not listed"]');
    expect(placeholder?.textContent?.trim()).toBe('–');
  });

  describe('depth axis: object coverage (AECI-711)', () => {
    it('renders an "N data objects" chip beside the mechanism badge', () => {
      const { el } = setup({
        integration: signal({ ...baseIntegration, data_object_slugs: ['rfis', 'models'] }),
      });
      const chip = el.querySelector('[data-testid="row-data-objects"]');
      expect(chip?.textContent?.trim()).toBe('2 types of data');
      // Same cell, same wrapper as the mechanism badge: the same visual weight.
      expect(chip?.parentElement?.textContent).toContain('API');
    });

    it('uses the singular for one object', () => {
      const { el } = setup({
        integration: signal({ ...baseIntegration, data_object_slugs: ['rfis'] }),
      });
      expect(el.querySelector('[data-testid="row-data-objects"]')?.textContent?.trim()).toBe(
        '1 type of data',
      );
    });

    it('repeats the count on the below-md meta line', () => {
      const { el } = setup({
        integration: signal({ ...baseIntegration, data_object_slugs: ['rfis', 'models'] }),
      });
      const sub = el.querySelector('[data-testid="row-data-objects-sublabel"]');
      expect(sub?.textContent?.trim()).toBe('2 types of data');
      expect(sub?.classList).toContain('md:hidden');
    });

    it('keeps the "–" mechanism placeholder and adds the chip when the kind is null', () => {
      const { el } = setup({
        integration: signal({
          ...baseIntegration,
          mechanism_kind: null,
          data_object_slugs: ['rfis'],
        }),
      });
      expect(el.querySelector('span[aria-label="Mechanism not listed"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="row-data-objects"]')).not.toBeNull();
    });

    it('drops the "–" beside the chip on a Via-lane row (ruled 2026-09-23)', () => {
      const { el } = setup({
        integration: signal({
          ...baseIntegration,
          mechanism_kind: null,
          via: { id: 'z1', slug: 'zapier', name: 'Zapier', logo_url: null },
          data_object_slugs: ['rfis', 'models'],
        }),
      });
      expect(el.querySelector('span[aria-label="Mechanism not listed"]')).toBeNull();
      expect(el.querySelector('[data-testid="row-data-objects"]')?.textContent?.trim()).toBe(
        '2 types of data',
      );
    });

    it('keeps the "–" on a Via-lane row that has no objects', () => {
      const { el } = setup({
        integration: signal({
          ...baseIntegration,
          mechanism_kind: null,
          via: { id: 'z1', slug: 'zapier', name: 'Zapier', logo_url: null },
        }),
      });
      expect(el.querySelector('span[aria-label="Mechanism not listed"]')).not.toBeNull();
    });

    it('renders no chip and no marker when the edge has no claims', () => {
      const { el } = setup();
      expect(el.querySelector('[data-testid="row-data-objects"]')).toBeNull();
      expect(el.querySelector('[data-testid="row-data-objects-sublabel"]')).toBeNull();
    });
  });
});
