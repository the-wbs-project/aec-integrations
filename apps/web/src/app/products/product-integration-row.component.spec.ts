import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

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
  direction: 'one-way',
  context_direction: 'outbound',
  source: { id: 's1', slug: 'procore', name: 'Procore', logo_url: null },
  target: OTHER,
  via: null,
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

  it('makes the whole row a stretched link to the product-PAIR page (context = this product)', () => {
    const { el } = setup();
    const overlay = el.querySelector<HTMLAnchorElement>(
      'a[href="/products/procore/integrations/autodesk-bim-360"]',
    );
    expect(overlay).not.toBeNull();
    // Named for assistive tech, and covering the whole row.
    expect(overlay?.getAttribute('aria-label')).toContain('Autodesk BIM 360');
    expect(overlay?.className).toContain('absolute');
    expect(overlay?.className).toContain('inset-0');
    // The overlay is `absolute inset-0`, so its containing block is the nearest
    // positioned ancestor. That must be the `relative` <tr> host — a `relative`
    // <td> in between would intercept `inset-0` and shrink the click target to
    // one cell instead of the whole row (jsdom can't measure layout, so assert
    // the invariant structurally). Guards the containing-block regression.
    const cell = overlay!.closest('td')!;
    expect(cell.className).not.toContain('relative');
    expect(overlay!.parentElement?.closest('.relative')?.tagName).toBe('TR');
  });

  it('does not nest the two links (partner link is a sibling, not inside the pair overlay)', () => {
    const { el } = setup();
    const overlay = el.querySelector<HTMLAnchorElement>(
      'a[href="/products/procore/integrations/autodesk-bim-360"]',
    )!;
    const partner = el.querySelector<HTMLAnchorElement>('a[href="/products/autodesk-bim-360"]')!;
    expect(overlay.contains(partner)).toBe(false);
    expect(partner.contains(overlay)).toBe(false);
    // The overlay itself carries no descendant anchors.
    expect(overlay.querySelector('a')).toBeNull();
  });

  // Direction leads the row now — the first cell.
  it('renders "Outbound" in the leading Direction cell when data leaves this product', () => {
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

  it('renders the mechanism_kind badge and mechanism_name in the connection cell', () => {
    const { el } = setup();
    const cells = el.querySelectorAll('td');
    expect(cells[2]?.textContent).toContain('API');
    expect(cells[2]?.textContent).toContain('REST connector');
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
});
