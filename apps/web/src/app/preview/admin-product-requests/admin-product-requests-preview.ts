import { HttpErrorResponse } from '@angular/common/http';
import { Component, Injectable } from '@angular/core';

import type {
  AdminProductRequest,
  DecideProductRequest,
  ListProductRequestsQuery,
  ListProductRequestsResponse,
  ProductListItem,
  ProductsListResponse,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { AdminRequestsApi } from '../../admin/requests/admin-requests-api';
import { ProductRequestQueue } from '../../admin/requests/product-request-queue';

/**
 * AECI-1377: the "Product requests from vendors" section of `/admin/requests`, fed
 * synthetic rows through a component-provided fake of {@link AdminRequestsApi}, so
 * the three decision forms and the product picker can be reviewed and axe-scanned
 * without an admin session (`ADMIN_PANEL_SPEC.md` §5.16).
 *
 * Dev-only, like every `/preview` route: blocked on the public tiers by the SSR
 * Worker (`isPreviewPath`). Decisions resolve locally and write nothing. The
 * product named "Unpromoted" answers `422 PRODUCT_NOT_PROMOTED`, so that message
 * can be seen too.
 */
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const SUMMIT = { id: uuid(5200), slug: 'summit-bim', name: 'Summit BIM' };
const SUMMIT_MC = {
  id: uuid(5201),
  slug: 'summit-model-coordination',
  name: 'Summit Model Coordination',
};

function request(over: Partial<AdminProductRequest> & { id: string }): AdminProductRequest {
  return {
    status: 'open',
    vendor_id: SUMMIT.id,
    vendor: SUMMIT,
    requested_by: uuid(1),
    context_product_id: SUMMIT_MC.id,
    context_product: SUMMIT_MC,
    name: 'Trimble Connect',
    maker: 'Trimble',
    website: 'https://connect.trimble.com',
    body: 'We sync issues both ways with it. Most of our customers use it on site.',
    created_at: '2026-10-14T09:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    decline_reason: null,
    resolved_product: null,
    ...over,
  };
}

const REQUESTS: readonly AdminProductRequest[] = [
  request({ id: uuid(7101) }),
  request({
    id: uuid(7102),
    name: 'Revu',
    maker: 'Bluebeam',
    website: null,
    body: '',
    created_at: '2026-10-12T09:00:00.000Z',
  }),
  request({
    id: uuid(7103),
    status: 'declined',
    name: 'Slack',
    maker: 'Salesforce',
    website: 'https://slack.com',
    body: '',
    created_at: '2026-10-02T09:00:00.000Z',
    resolved_at: '2026-10-03T09:00:00.000Z',
    resolved_by: uuid(2),
    decline_reason: 'We list software built for architecture, engineering and construction.',
  }),
];

const CATALOGUE: readonly ProductListItem[] = [
  ['bluebeam-revu', 'Bluebeam Revu', 'Bluebeam'],
  ['trimble-connect', 'Trimble Connect', 'Trimble'],
  ['procore', 'Procore', 'Procore Technologies'],
  ['unpromoted', 'Unpromoted', 'Example'],
].map(([slug, name, vendor], index) => ({
  id: uuid(5300 + index),
  slug: slug!,
  name: name!,
  logo_url: null,
  product_role: 'application' as const,
  vendor: { id: uuid(5600 + index), slug: slug!, name: vendor!, logo_url: null, verified: false },
  integration_count: 0,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}));

// eslint-disable-next-line @angular-eslint/use-injectable-provided-in -- component-provided preview fake
@Injectable()
class PreviewAdminRequestsApi extends AdminRequestsApi {
  override async listProductRequests(
    query: Partial<ListProductRequestsQuery> = {},
  ): Promise<ListProductRequestsResponse> {
    const rows = REQUESTS.filter((r) => r.status === (query.status ?? 'open'));
    return { data: structuredClone([...rows]), page: 1, perPage: 100, total: rows.length };
  }

  override async decideProductRequest(
    id: string,
    input: DecideProductRequest,
  ): Promise<AdminProductRequest> {
    const row = REQUESTS.find((r) => r.id === id) ?? request({ id });
    if (input.outcome === 'declined') {
      return { ...row, status: 'declined', decline_reason: input.reason };
    }
    const product = CATALOGUE.find((p) => p.id === input.product_id);
    if (!product || product.slug === 'unpromoted') {
      throw new HttpErrorResponse({
        status: 422,
        error: { error: { code: 'PRODUCT_NOT_PROMOTED', message: 'Not promoted' } },
      });
    }
    return {
      ...row,
      status: input.outcome,
      resolved_product: {
        id: product.id,
        slug: product.slug,
        name: product.name,
        logo_url: null,
      },
    };
  }

  override async searchProducts(query: string, perPage = 8): Promise<ProductsListResponse> {
    const needle = query.trim().toLowerCase();
    const items = CATALOGUE.filter((p) => p.name.toLowerCase().includes(needle))
      .sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id))
      .slice(0, perPage);
    return { data: structuredClone(items), total: items.length, page: 1, perPage };
  }
}

@Component({
  selector: 'app-admin-product-requests-preview',
  imports: [ProductRequestQueue],
  providers: [{ provide: AdminRequestsApi, useClass: PreviewAdminRequestsApi }],
  template: `
    <div class="mx-auto max-w-5xl px-6 py-10">
      <h1
        class="mb-6 text-2xl font-bold text-(--text-primary)"
        i18n="@@preview.adminProductRequests.heading"
      >
        Admin: product requests (preview)
      </h1>
      <aec-product-request-queue />
    </div>
  `,
})
export class AdminProductRequestsPreview {}
