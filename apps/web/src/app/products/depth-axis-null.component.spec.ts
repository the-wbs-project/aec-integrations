/**
 * AECI-711 null-case guard. The ruling on the issue (2026-09-22): the depth axis
 * renders direction and object coverage **only when present**, and a row with a
 * null direction and no object claims renders exactly as it did before the axis
 * existed. These snapshots were recorded against the pre-AECI-711 templates and
 * must never be updated to make a depth-axis change pass.
 *
 * `normalize` strips two things that are not content: Angular's generated
 * `_ngcontent-*` / `_nghost-*` / `ng-reflect-*` attributes (their counters shift
 * whenever any component is added to the build) and the `<!--container-->`
 * anchor comments control-flow blocks emit (an `@if` that renders nothing still
 * leaves one). Every element, attribute and text node a reader or a screen reader
 * can reach is compared byte for byte.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductIntegrationItem, ProductLink, ProductPairResponse } from '@aeci/shared';

import { ProductIntegrationRow } from './product-integration-row';
import { ProductsPairPage } from './products-pair';

function normalize(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s(?:_ngcontent|_nghost|ng-reflect)-[\w-]*(?:="[^"]*")?/g, '');
}

const OTHER: ProductLink = { id: 't1', slug: 'revit', name: 'Revit', logo_url: null };

/** Null direction, no claims: the population the ruling protects. */
const nullRow = {
  id: '00000000-0000-4000-8000-000000071101',
  name: 'Procore and Revit',
  mechanism_kind: 'api',
  mechanism_name: null,
  direction: null,
  context_direction: null,
  source: { id: 's1', slug: 'procore', name: 'Procore', logo_url: null },
  target: OTHER,
  via: null,
  powered_by_product: null,
  created_at: '2024-03-01T00:00:00.000Z',
  updated_at: '2024-06-15T00:00:00.000Z',
} as ProductIntegrationItem;

@Component({
  imports: [ProductIntegrationRow],
  template: `
    <table>
      <tbody>
        @if (merged()) {
          <tr
            aec-product-integration-row
            [integration]="integration()"
            [other]="other"
            contextSlug="procore"
            [mergedMechanismKinds]="[]"
            [mergedDirection]="null"
          ></tr>
        } @else {
          <tr
            aec-product-integration-row
            [integration]="integration()"
            [other]="other"
            contextSlug="procore"
          ></tr>
        }
      </tbody>
    </table>
  `,
})
class RowHost {
  integration = signal<ProductIntegrationItem>(nullRow);
  merged = signal(false);
  other = OTHER;
}

function renderRow(integration: ProductIntegrationItem, merged = false): string {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(RowHost);
  fixture.componentInstance.integration.set(integration);
  fixture.componentInstance.merged.set(merged);
  fixture.detectChanges();
  return normalize((fixture.nativeElement as HTMLElement).querySelector('tr')!.outerHTML);
}

const listItem = (slug: string, name: string) => ({
  id: `00000000-0000-4000-8000-${slug.padEnd(12, '0')}`,
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: null,
  primary_category: null,
  integration_count: 1,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

function nullPair(via: ProductLink | null): ProductPairResponse {
  return {
    context_product: listItem('procore', 'Procore'),
    other_product: listItem('revit', 'Revit'),
    mechanisms: [
      {
        id: '00000000-0000-4000-8000-0000000711aa',
        mechanism_kind: via ? null : 'api',
        mechanism_name: 'Procore and Revit',
        direction: null,
        description: 'A mechanism with no direction and no claims.',
        listing_url: null,
        docs_url: null,
        built_by_vendor: null,
        powered_by_product: null,
        via,
        origin: 'aeci',
        vendor_links: { context: null, other: null },
        claims: [],
      },
    ],
    sync_headline: { total: 0, confirmed: 0, single_source: 0 },
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    version_diff: null,
    moved_to: null,
  };
}

function renderPair(pair: ProductPairResponse, view: 'basic' | 'detailed'): string {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: {
          data: of({ pair }),
          snapshot: { data: { pair } },
          queryParamMap: of(convertToParamMap({ view })),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProductsPairPage);
  fixture.detectChanges();
  return normalize((fixture.nativeElement as HTMLElement).querySelector('article')!.outerHTML);
}

const ZAPIER: ProductLink = { id: 'z1', slug: 'zapier', name: 'Zapier', logo_url: null };

describe('AECI-711 depth axis: the null case renders exactly as before', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('integration row, direct lane (integrations arm)', () => {
    expect(renderRow(nullRow)).toMatchSnapshot();
  });

  it('integration row, collapsed Via lane (connector_evidenced_pairs arm)', () => {
    expect(renderRow({ ...nullRow, mechanism_kind: null, via: ZAPIER }, true)).toMatchSnapshot();
  });

  it('pair page mechanism card, integrations arm, Detailed view', () => {
    expect(renderPair(nullPair(null), 'detailed')).toMatchSnapshot();
  });

  it('pair page mechanism card, integrations arm, Basic view', () => {
    expect(renderPair(nullPair(null), 'basic')).toMatchSnapshot();
  });

  it('pair page mechanism card, connector_evidenced_pairs arm, Detailed view', () => {
    expect(renderPair(nullPair(ZAPIER), 'detailed')).toMatchSnapshot();
  });
});
