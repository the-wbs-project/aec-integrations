/**
 * AECI-1149 — the integration detail page shell (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.17.1, §6.17.2).
 *
 * What these pin: which entry the route names (id AND context product); not
 * found without a probe, and never before the list settles; the h2 title and
 * the status pill; "Things that need you" and its jumps; the section nav as
 * native fragment anchors with Overview current on first render; focus moving to
 * a section heading on a nav choice.
 */
import { provideHttpClient } from '@angular/common/http';
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorApi } from '../vendor-api';
import {
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_ME_FIXTURE,
  VENDOR_OWNED_INTEGRATIONS_FIXTURE,
  VENDOR_SYNC_OWNED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { makeApi, type MockApi } from './integration-detail-testing.harness';
import { VendorIntegrationDetailPage } from './vendor-integration-detail-page';
import { expectVendorDocsLink } from '../components/vendor-docs-link.testing';

@Component({ selector: 'aec-test-list', template: 'list' })
class ListStub {}

let api: MockApi;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  api = makeApi([INTEGRATION_PROCORE_DETAIL, INTEGRATION_OWNED_CLAIMED]);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([
        { path: 'products/:productSlug/integrations', component: ListStub },
        {
          path: 'products/:productSlug/integrations/:integrationId',
          component: VendorIntegrationDetailPage,
        },
      ]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

const PRIMARY = INTEGRATION_PROCORE_DETAIL.context_product.slug;

async function open(path: string): Promise<{ harness: RouterTestingHarness; root: HTMLElement }> {
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(path);
  for (let n = 0; n < 4; n++) {
    harness.detectChanges();
    await flush();
  }
  harness.detectChanges();
  return { harness, root: harness.routeNativeElement as HTMLElement };
}

describe('which entry the route names', () => {
  it('renders the integration under its product, titled as an h2', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expect(root.querySelector('h2')?.textContent?.trim()).toBe(
      'Summit Model Coordination and Procore',
    );
    expect(root.querySelector('[data-testid="integration-status"]')?.textContent).toContain(
      'Disagreement open',
    );
    expect(root.querySelectorAll('h3[id$="-heading"]').length).toBeGreaterThanOrEqual(5);
  });

  it('says not found for an id under a different product, and makes no request with it', async () => {
    const { root } = await open(
      `/products/summit-field-issues/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expect(root.querySelector('[data-testid="integration-not-found"]')).not.toBeNull();
    expect(root.textContent).toContain(
      'This integration is not one of Summit Field Issues’ integrations.',
    );
    expect(api.getContests).not.toHaveBeenCalled();
  });

  it('shows loading, never not found, before the list settles', async () => {
    api.getIntegrations.mockReturnValue(new Promise(() => undefined));
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expect(root.textContent).toContain('Loading the integration');
    expect(root.querySelector('[data-testid="integration-not-found"]')).toBeNull();
  });

  it('reads the page’s change requests with the integration filter', async () => {
    await open(`/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`);
    expect(api.getContests).toHaveBeenCalledWith(INTEGRATION_PROCORE_DETAIL.id);
  });
});

describe('"Things that need you"', () => {
  it('lists what needs the caller and what waits on someone else', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const needs = root.querySelector('[data-testid="integration-needs"]')!;
    expect(needs.querySelector('h3')?.textContent).toContain('Things that need you');
    expect(needs.textContent).toContain('Procore Technologies added Documents. Is this right?');
    expect(needs.textContent).toContain('Waiting on someone else');
  });

  it('jumps to the item and focuses it', async () => {
    const { harness, root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const item = [
      ...root.querySelectorAll<HTMLButtonElement>('[data-testid="integration-needs"] button'),
    ].find((b) => b.textContent?.includes('added Documents'))!;
    item.click();
    harness.detectChanges();
    await flush();
    harness.detectChanges();
    expect(document.activeElement?.id).toMatch(/^added-/);
  });
});

describe('the section nav', () => {
  it('is a named nav of native fragment anchors, Overview current first', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const nav = root.querySelector('nav[aria-label="Integration sections"]')!;
    const links = [...nav.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href')?.split('#')[1])).toEqual([
      'overview',
      'data-shared',
      'links',
      'change-requests',
      'settings',
    ]);
    expect(links[0]!.getAttribute('href')).toContain(
      `/integrations/${INTEGRATION_PROCORE_DETAIL.id}#`,
    );
    expect(links[0]!.getAttribute('aria-current')).toBe('location');
    for (const id of ['overview', 'data-shared', 'links', 'change-requests', 'settings']) {
      expect(root.querySelector(`#${id}`)?.className).toContain('scroll-mt-20');
    }
  });

  // AECI-1843: the hrefs carry the query, so a section click on a URL with one is a
  // same-document jump, not a page load. They read Location, so the first render is right.
  it('keeps the query string in every section href', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}?utm_source=mail`,
    );
    const nav = root.querySelector('nav[aria-label="Integration sections"]')!;
    expect(nav.querySelector('a')!.getAttribute('href')).toBe(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}?utm_source=mail#overview`,
    );
  });

  // AECI-1752: the portal keeps its smooth in-page jump (ruling R2, tokens only).
  it('opts every section link into the smooth in-page jump', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const links = [...root.querySelectorAll('nav[aria-label="Integration sections"] a')];
    expect(links).toHaveLength(5);
    for (const a of links) expect(a.hasAttribute('data-smooth-scroll'), a.id).toBe(true);
  });

  it('moves focus to the chosen section’s heading', async () => {
    const { harness, root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const link = root.querySelector<HTMLAnchorElement>('[data-testid="section-nav-settings"]')!;
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    link.click();
    harness.detectChanges();
    expect(document.activeElement?.id).toBe('settings-heading');
    expect(link.getAttribute('aria-current')).toBe('location');
  });

  it('links back to all integrations inside a breadcrumb nav', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const back = root.querySelector('nav[aria-label="Integration breadcrumb"] a')!;
    expect(back.getAttribute('href')).toBe(`/products/${PRIMARY}/integrations`);
    expect(back.textContent).toContain('All integrations');
  });

  it('opens the public page in a new tab and names the destination', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    const link = [...root.querySelectorAll('a[target="_blank"]')].find((a) =>
      a.getAttribute('href')?.startsWith('/products/'),
    )!;
    expect(link.getAttribute('href')).toBe(`/products/${PRIMARY}/integrations/procore`);
    expect(link.getAttribute('aria-label')).toBe(
      'View public page: the Summit Model Coordination and Procore integration (opens in a new tab)',
    );
  });
});

describe('the guide links (AECI-1253)', () => {
  it('links one guide page per section: owning, attesting, contests', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/${INTEGRATION_PROCORE_DETAIL.id}`,
    );
    expectVendorDocsLink(root.querySelector('#overview')!, 'owning-an-integration');
    expectVendorDocsLink(root.querySelector('#data-shared')!, 'confirming-integration-data');
    expectVendorDocsLink(root.querySelector('#change-requests')!, 'requesting-changes-and-appeals');
  });
});

/** AECI-2045: a row the caller owns but holds no endpoint of gets its own page. */
describe('an owned row (AECI-2045)', () => {
  const SYNC_CLAIMED = VENDOR_SYNC_OWNED_FIXTURE[0]!;
  const SYNC_UNCLAIMED = VENDOR_SYNC_OWNED_FIXTURE[1]!;
  const PAIR_CLAIMED = VENDOR_OWNED_INTEGRATIONS_FIXTURE[1]!;

  beforeEach(() => {
    api.getIntegrations.mockResolvedValue({
      integrations: [INTEGRATION_PROCORE_DETAIL],
      owned: [...VENDOR_OWNED_INTEGRATIONS_FIXTURE, ...VENDOR_SYNC_OWNED_FIXTURE],
      counterpart_added_unanswered: 0,
    });
  });

  it('renders the page shell for the owned pair, with four sections and no links section', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    expect(root.querySelector('[data-testid="owned-detail"]')).not.toBeNull();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Procore and Acumatica');
    const nav = [...root.querySelectorAll('nav[aria-label="Integration sections"] a')].map((a) =>
      a.textContent?.trim(),
    );
    expect(nav).toEqual(['Overview', "Data that's shared", 'Change requests', 'Settings']);
    expect(root.querySelector('#links')).toBeNull();
    // AECI-2045 QA: Invoices has no answer from the owner, so the pair is not up to date.
    expect(root.querySelector('[data-testid="integration-status"]')?.textContent).toContain(
      'Needs your answer',
    );
    const pub = [...root.querySelectorAll('a[target="_blank"]')].find((a) =>
      a.getAttribute('href')?.startsWith('/products/'),
    )!;
    expect(pub.getAttribute('href')).toBe('/products/procore/integrations/acumatica');
  });

  it('counts the owner flows that wait for an answer, by the checklist rule (AECI-2045 QA)', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    const needs = root.querySelector('[data-testid="integration-needs"]')!;
    expect(needs.textContent).toContain('Things that need you');
    expect(needs.textContent).toContain('1 row of data needs your answer');
    expect(needs.textContent).not.toContain('Nothing needs you right now');
  });

  it('reads All up to date once every owner flow has an answer', async () => {
    const answered = {
      ...SYNC_CLAIMED,
      flows: SYNC_CLAIMED.flows.map((f) => ({ ...f, answer: 'yes' as const })),
    };
    api.getIntegrations.mockResolvedValue({
      integrations: [INTEGRATION_PROCORE_DETAIL],
      owned: [answered],
      counterpart_added_unanswered: 0,
    });
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    expect(root.querySelector('[data-testid="integration-status"]')?.textContent).toContain(
      'All up to date',
    );
    expect(root.querySelector('[data-testid="integration-needs"]')?.textContent).toContain(
      'Nothing needs you right now',
    );
  });

  it('asks for a decision on a received data flow report, and names a removal', async () => {
    const answered = {
      ...SYNC_CLAIMED,
      flows: SYNC_CLAIMED.flows.map((f) => ({ ...f, answer: 'yes' as const })),
    };
    api.getIntegrations.mockResolvedValue({
      integrations: [INTEGRATION_PROCORE_DETAIL],
      owned: [answered],
      counterpart_added_unanswered: 0,
    });
    const pair = {
      integration_id: SYNC_CLAIMED.id,
      anchor: 'evidenced_pair' as const,
      name: 'Procore and Acumatica',
      connector: null,
      product_a: null,
      product_b: null,
    };
    api.listPairContests.mockResolvedValue({
      submitted: [],
      received: [
        {
          id: '00000000-0000-4000-8000-00000000a001',
          kind: 'data_flow',
          pair,
          flow: {
            claim_id: SYNC_CLAIMED.flows[1]!.id,
            data_object_slug: 'invoices',
            data_object_name: 'Invoices',
            current_direction: 'b_to_a',
            proposed_direction: null,
          },
          reason: 'Not offered',
          submitter_vendor_id: '00000000-0000-4000-8000-00000000a002',
          submitter_name: 'Acumatica',
          routed_to: 'owner',
          owner_vendor_id: null,
          owner_name: null,
          status: 'open',
          decision_note: null,
          decided_at: null,
          accept_mode: null,
          protest: null,
          protest_closes_at: null,
          created_at: '2026-11-22T00:00:00.000Z',
          updated_at: '2026-11-22T00:00:00.000Z',
        },
      ],
    });
    api.listVetoes.mockResolvedValue({
      filed: [],
      received: [
        {
          id: '00000000-0000-4000-8000-00000000a003',
          pair,
          vendor_id: null,
          vendor_name: 'Trimble',
          reason: 'Not certified',
          filed_at: '2026-11-21T00:00:00.000Z',
          in_force: true,
          ended_at: null,
          ended_how: null,
          end_note: null,
          other_vetoes_in_force: 0,
          updated_at: '2026-11-21T00:00:00.000Z',
        },
      ],
    });
    const { root, harness } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    await flush();
    harness.detectChanges();
    expect(root.querySelector('[data-testid="integration-status"]')?.textContent).toContain(
      'Needs your decision',
    );
    const needs = root.querySelector('[data-testid="integration-needs"]')!.textContent ?? '';
    expect(needs).toContain('Acumatica reported a problem with the Invoices data flow');
    expect(needs).toContain(
      'Trimble removed this integration from its product. Trimble gave this reason: Not certified',
    );
    expect(root.querySelector('#change-requests aec-vendor-pair-rights-list')).not.toBeNull();
  });

  it('lists the nine fields with the direction in words, and offers Edit details once claimed', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    const rows = root.querySelectorAll('[data-testid^="owned-overview-row-"]');
    expect(rows).toHaveLength(9);
    expect(
      root.querySelector('[data-testid="owned-overview-row-direction"]')?.textContent,
    ).toContain('Both ways');
    expect(
      root.querySelector('[data-testid="owned-overview-row-pricing_url"]')?.textContent,
    ).toContain('https://summitbim.example.com/sync/pricing');
    expect(root.querySelector('[data-testid="owned-overview-edit"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="owned-overview-claim"]')).toBeNull();
  });

  it('renders the owner flow controls under the section heading on a Sync Service pair', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    const section = root.querySelector('#data-shared')!;
    expect(section.querySelector('aec-vendor-owned-flows')).not.toBeNull();
    // One heading per section: the component's own is dropped.
    expect(section.querySelectorAll('h3, h4').length).toBe(1);
    expect(section.textContent).toContain('Commitments');
  });

  it('shows Claim and Not ours on an unclaimed pair, and says claim first in Settings', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_UNCLAIMED.id}`);
    expect(root.querySelector('[data-testid="owned-overview-claim"]')).not.toBeNull();
    expect(root.querySelector('aec-vendor-not-ours')).not.toBeNull();
    expect(root.querySelector('[data-testid="integration-status"]')?.textContent).toContain(
      'Ready to claim',
    );
    expect(root.querySelector('#settings')?.textContent).toContain(
      'Once you claim this integration',
    );
  });

  it('claims from the Overview and revalidates the list', async () => {
    const { harness, root } = await open(`/products/${PRIMARY}/integrations/${SYNC_UNCLAIMED.id}`);
    const calls = api.getIntegrations.mock.calls.length;
    (root.querySelector('[data-testid="owned-overview-claim"]') as HTMLButtonElement).click();
    await flush();
    harness.detectChanges();
    expect(api.claimIntegration).toHaveBeenCalledWith(SYNC_UNCLAIMED.id);
    expect(api.getIntegrations.mock.calls.length).toBeGreaterThan(calls);
  });

  it('lists only this row in Change requests, under the section heading', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${SYNC_CLAIMED.id}`);
    const section = root.querySelector('#change-requests')!;
    expect(section.querySelector('aec-vendor-contests-list')).not.toBeNull();
    expect(section.querySelector('#vendor-contests-heading')).toBeNull();
    expect(section.textContent).toContain(
      'No change requests have come in about this integration.',
    );
  });

  it('reads the flows of a non Sync Service pair read-only, and offers Retire in Settings', async () => {
    const { root } = await open(`/products/${PRIMARY}/integrations/${PAIR_CLAIMED.id}`);
    expect(root.querySelector('[data-testid="owned-flows-note"]')?.textContent).toContain(
      'These rows stay as they were',
    );
    expect(root.querySelector('#data-shared aec-vendor-owned-flows')).toBeNull();
    expect(root.querySelector('#settings aec-vendor-owned-retire')).not.toBeNull();
  });

  it('still says not found for an id that is neither listed nor owned', async () => {
    const { root } = await open(
      `/products/${PRIMARY}/integrations/00000000-0000-4000-8000-00000000ffff`,
    );
    expect(root.querySelector('[data-testid="integration-not-found"]')).not.toBeNull();
  });
});
