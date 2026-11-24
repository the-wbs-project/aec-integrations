/**
 * The product hero's connector-kind wording (AECI-2037): the role chip and the reach line.
 *
 * These pins lived in `product-hero-visual.component.spec.ts`, which AECI-2018 deleted with
 * the category hub and pair finder it pinned. The wheel that replaced them is pinned in
 * `product-integration-wheel.component.spec.ts`, including a connector's wheel of the
 * products its pairs reach. Named `.component.spec.ts` so it runs under `ng test`.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, ProductIntegrationItem, ProductLink } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';

import { ProductHero } from './product-hero';

const link = (slug: string, name: string): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

const page = link('revu', 'Revu');
let seq = 0;

function edge(
  partner: ProductLink,
  categories: { slug: string; name: string }[],
  extra: Partial<ProductIntegrationItem> = {},
): ProductIntegrationItem {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    name: `${partner.name} link`,
    mechanism_kind: 'native',
    mechanism_name: null,
    direction: null,
    context_direction: null,
    source: page,
    target: partner,
    via: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: categories,
    agreement: null,
    caption: null,
    corrections: [],
    under_review: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as ProductIntegrationItem;
}

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    claim_status: 'claimed',
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'revu',
    name: 'Revu',
    logo_url: null,
    vendor_facts: { company_size: null, ownership_type: null },
    product_role: 'application',
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: null,
    website: null,
    tool_integrations_url: null,
    api_docs_url: null,
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    usefulness: null,
    usefulness_source: null,
    integrations_as_source: [],
    integrations_as_target: [],
    integrations_as_connector: [],
    related_products: [],
    extension_of: [],
    extensions: [],
    reviews: [],
    reachable_pair_count: 0,
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    under_review: [],
    ...overrides,
  } as ProductDetail;
}

function setup(product: ProductDetail) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: { capture: vi.fn(), track: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(ProductHero);
  fixture.componentRef.setInput('product', product);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

// AECI-2037: the hero's role chip and reach line read the connector kind.
describe('ProductHero connector kind (AECI-2037)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    seq = 0;
  });

  // Two pairs the page product sits in the middle of: three distinct endpoints.
  function connector(kind: ProductDetail['connector_kind']): ProductDetail {
    const a = link('procore', 'Procore');
    return buildProduct({
      slug: 'fx-connector',
      name: 'Fixture connector',
      product_role: 'connector',
      connector_kind: kind,
      integrations_as_connector: [
        edge(link('acumatica', 'Acumatica'), [], { source: a }),
        edge(link('quickbooks', 'QuickBooks'), [], { source: a }),
      ],
    });
  }

  function chip(el: HTMLElement): string {
    return el.querySelector('aec-role-badge')?.textContent?.trim() ?? '';
  }

  it.each([
    [
      'integration_platform',
      'Integration platform',
      'Connects 3 products in the AEC Integrations catalog',
    ],
    ['sync_service', 'Sync Service', 'Syncs 3 products in the AEC Integrations catalog'],
    [null, 'Connector', 'Connects 3 products in the AEC Integrations catalog'],
  ] as const)('kind %s: chip "%s" and line "%s"', (kind, label, line) => {
    const { el } = setup(connector(kind));
    expect(chip(el)).toBe(label);
    expect(el.textContent).toContain(line);
    // QA pass on AECI-2035: a connector's wheel shows the products its pairs reach, the
    // reach line's set, so its count line agrees with the line above.
    expect(el.querySelector('[data-testid="product-hero-wheel"]')).not.toBeNull();
    expect(el.querySelector('.aec-wheel-count')?.textContent?.trim()).toBe('3 products');
    expect(el.querySelector('.aec-wheel-name')?.textContent?.trim()).toBe(
      kind === 'sync_service' ? 'Products it syncs' : 'Products it connects',
    );
  });
});
