/**
 * AECI-606 — `VendorIntegrationsSection`: the Integrations tab's body.
 *
 * The load ladder, the unverified read-only state (driven by
 * `me.vendor.verified`, NOT by an API error — `GET /api/vendor/integrations` is
 * ownership-gated but not Verified-gated, so an unverified vendor gets a real
 * 200), and the reconcile-from-echo / refetch-on-retract split.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListVendorIntegrationsResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  VENDOR_DATA_OBJECTS_FIXTURE,
  VENDOR_INTEGRATIONS_EMPTY_FIXTURE,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_PRODUCT_VERSIONS_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorIntegrationCard } from './vendor-integration-card';
import { VendorIntegrationsSection } from './vendor-integrations-section';

let api: {
  getIntegrations: ReturnType<typeof vi.fn>;
  getDataObjects: ReturnType<typeof vi.fn>;
  listProductVersions: ReturnType<typeof vi.fn>;
  getNotifications: ReturnType<typeof vi.fn>;
  upsertAttestation: ReturnType<typeof vi.fn>;
  retractAttestation: ReturnType<typeof vi.fn>;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getIntegrations: vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE),
    getDataObjects: vi.fn().mockResolvedValue({ data_objects: VENDOR_DATA_OBJECTS_FIXTURE }),
    listProductVersions: vi.fn().mockImplementation(async (id: string) => ({
      versions: VENDOR_PRODUCT_VERSIONS_FIXTURE[id] ?? [],
    })),
    getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
    upsertAttestation: vi.fn(),
    retractAttestation: vi.fn().mockResolvedValue(undefined),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

async function create(
  verified = true,
  contextProductId: string | null = null,
): Promise<ComponentFixture<VendorIntegrationsSection>> {
  const fixture = TestBed.createComponent(VendorIntegrationsSection);
  fixture.componentRef.setInput('verified', verified);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  fixture.componentRef.setInput('contextProductId', contextProductId);
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ComponentFixture<VendorIntegrationsSection>) =>
  fixture.nativeElement as HTMLElement;
const text = (fixture: ComponentFixture<VendorIntegrationsSection>) =>
  el(fixture).textContent ?? '';

describe('VendorIntegrationsSection — loading', () => {
  it('renders a card per integration once loaded', async () => {
    const fixture = await create();
    expect(el(fixture).querySelectorAll('aec-vendor-integration-card')).toHaveLength(4);
    expect(text(fixture)).toContain('Procore');
  });

  it('keeps the claim list a real list — no element between the ul and its li', async () => {
    // A component ELEMENT selector here would put a wrapper between them, which
    // axe rates serious on both `list` and `listitem`, and which silently costs
    // a screen-reader user the "6 items" announcement. Hence
    // `li[aec-vendor-claim-lane]`, the same fix as `tr[aec-product-card]`.
    const fixture = await create();
    const lists = [...el(fixture).querySelectorAll('ul')].filter((ul) =>
      ul.querySelector('[aec-vendor-claim-lane]'),
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect(list.children.length).toBeGreaterThan(0);
      for (const child of list.children) expect(child.tagName).toBe('LI');
    }
    // And every lane IS one of those `<li>`s, not a child of one.
    for (const lane of el(fixture).querySelectorAll('[aec-vendor-claim-lane]')) {
      expect(lane.tagName).toBe('LI');
    }
  });

  it('offers a retry when the list fails', async () => {
    api.getIntegrations.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();

    expect(text(fixture)).toContain('Could not load your integrations');
    const retry = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Try again'),
    );
    expect(retry).toBeDefined();

    retry!.click();
    await flush();
    fixture.detectChanges();
    expect(el(fixture).querySelectorAll('aec-vendor-integration-card').length).toBeGreaterThan(0);
  });

  it('explains an empty surface without implying anything is wrong', async () => {
    api.getIntegrations.mockResolvedValue(VENDOR_INTEGRATIONS_EMPTY_FIXTURE);
    const fixture = await create();

    // The API returns `200 { integrations: [] }` here, never a 404.
    expect(text(fixture)).toContain('No integrations are on record');
    expect(el(fixture).querySelectorAll('aec-vendor-integration-card')).toHaveLength(0);
  });

  it('degrades without the vocabulary rather than failing the tab', async () => {
    api.getDataObjects.mockRejectedValue(new Error('offline'));
    const fixture = await create();

    expect(el(fixture).querySelectorAll('aec-vendor-integration-card').length).toBeGreaterThan(0);
    expect(text(fixture)).toContain('cannot be added right now');
  });

  it('asks only for the caller’s own endpoint products’ versions', async () => {
    await create();

    const requested = api.listProductVersions.mock.calls.map((c) => c[0] as string);
    // §8.2: a stamp must belong to the attesting side's endpoint, so fetching
    // the counterpart's releases would only produce guaranteed 400s.
    expect(requested).toContain('00000000-0000-4000-8000-000000005201');
    expect(requested).not.toContain('00000000-0000-4000-8000-000000005301');
  });
});

describe('VendorIntegrationsSection — the unverified read-only state', () => {
  it('renders the full surface, explains verification, and offers no controls', async () => {
    const fixture = await create(false);
    const body = text(fixture);

    // Driven by the input, not by a 403: the read really does succeed.
    expect(api.getIntegrations).toHaveBeenCalled();
    expect(body).toContain('Procore');
    expect(body).toContain('once your account is verified');
    expect(body).toContain('arranged with AEC Integrations');
    expect(el(fixture).querySelector('aec-vendor-attestation-control')).toBeNull();
    expect(el(fixture).querySelector('aec-vendor-add-claim-form')).toBeNull();
  });

  it('points at verification and never at ranking, placement or search', async () => {
    const body = text(await create(false));
    expect(body).not.toMatch(/rank|placement/i);
    expect(body).not.toMatch(/instantly|live in search/i);
  });

  it('never calls a write endpoint', async () => {
    await create(false);
    expect(api.upsertAttestation).not.toHaveBeenCalled();
    expect(api.retractAttestation).not.toHaveBeenCalled();
  });
});

describe('VendorIntegrationsSection — reconciliation', () => {
  it('re-reads after a retract instead of reconstructing the claim locally', async () => {
    const fixture = await create();
    const before = api.getIntegrations.mock.calls.length;

    const component = fixture.componentInstance as unknown as {
      onRetracted(claimId: string): Promise<void>;
    };
    await component.onRetracted(VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1].id);
    fixture.detectChanges();

    // A 204 carries no recomputed agreement, and `counterparty` is a lossy
    // reduction of every other voter, so a local guess can be actively wrong.
    expect(api.getIntegrations.mock.calls.length).toBe(before + 1);
  });

  it('applies a write echo without re-reading the list', async () => {
    const fixture = await create();
    const before = api.getIntegrations.mock.calls.length;

    const claim = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
    const component = fixture.componentInstance as unknown as {
      onClaimChanged(c: typeof claim): void;
    };
    component.onClaimChanged({ ...claim, agreement: 'confirmed' });
    fixture.detectChanges();

    expect(api.getIntegrations.mock.calls.length).toBe(before);
    expect(text(fixture)).toContain('Both vendors confirmed');
  });

  it('announces a write through the portal channel, naming the subject', async () => {
    const fixture = await create();
    const claim = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
    const component = fixture.componentInstance as unknown as {
      onClaimChanged(c: typeof claim): void;
    };
    component.onClaimChanged(claim);
    fixture.detectChanges();

    // The wording still originates here — this is the one component that sees
    // every write's result and can therefore say WHICH flow was saved.
    const message = TestBed.inject(VendorPortalAnnouncer).message();
    expect(message).toContain('RFIs');
    expect(message).toContain('position saved');
  });
});

/**
 * AECI-631 / §6.3 — this tab used to own the surface's live region. It no longer
 * does: the region was hoisted to `vendor-dashboard-tabbed.ts` so that a tab
 * switch cannot destroy it mid-announcement, and so that the integration card's
 * second `role="status"` could not race it. What is asserted here is the half
 * that would silently regress: that nothing in this subtree declares a live
 * region of its own, in any of its states.
 */
describe('VendorIntegrationsSection — no live region of its own (§6.3)', () => {
  const regions = (fixture: ComponentFixture<VendorIntegrationsSection>) =>
    el(fixture).querySelectorAll('[role="status"], [aria-live]');

  it('declares none once loaded, with cards on screen', async () => {
    const fixture = await create();
    expect(el(fixture).querySelectorAll('aec-vendor-integration-card').length).toBeGreaterThan(0);
    expect(regions(fixture)).toHaveLength(0);
  });

  it('declares none in the failure state either, and marks the block busy while loading', async () => {
    api.getIntegrations.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();

    expect(text(fixture)).toContain('Could not load your integrations');
    expect(regions(fixture)).toHaveLength(0);
    // `aria-busy` is how the loading state is expressed now that the paragraph
    // is not a region. It is cleared once the read settles, either way.
    expect(el(fixture).querySelector('[aria-busy]')).toBeNull();
  });

  it('announces the outcome of a retry, since the failure text no longer speaks', async () => {
    api.getIntegrations.mockRejectedValueOnce(new Error('offline'));
    const fixture = await create();

    const retry = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Try again'),
    );
    retry!.click();
    await flush();
    fixture.detectChanges();

    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('up to date');
  });

  it('renders the card’s duplicate pivot as visible copy plus one announcement, not a second region', async () => {
    const fixture = await create();
    const card = fixture.debugElement.query(By.directive(VendorIntegrationCard))
      .componentInstance as {
      onDuplicate(hit: { claimId: string; dataObjectName: string }): void;
    };

    const claim = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
    card.onDuplicate({ claimId: claim.id, dataObjectName: claim.data_object_name });
    fixture.detectChanges();

    // Sighted readers still get the sentence in place, beside the lane it points
    // at; assistive tech gets it once, through the shell's region.
    expect(text(fixture)).toContain('It is highlighted below');
    expect(regions(fixture)).toHaveLength(0);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('It is highlighted below');
  });
});

describe('VendorIntegrationsSection — copy discipline', () => {
  it('never promises instant search and never mentions ranking', async () => {
    const body = text(await create());
    expect(body).not.toMatch(/rank|placement/i);
    expect(body).not.toMatch(/instantly|live in search|immediately in search/i);
  });

  it('summarises what is on record and what is waiting on the vendor', async () => {
    const fixture = await create();
    const claims = (
      VENDOR_INTEGRATIONS_FIXTURE as ListVendorIntegrationsResponse
    ).integrations.flatMap((i) => i.claims);
    const awaiting = claims.filter((c) => c.mine.length === 0).length;

    expect(text(fixture)).toContain(`${claims.length}`);
    expect(text(fixture)).toContain(`${awaiting} waiting on your confirmation`);
  });
});

// ─── AECI-666: the tab is filed under a product ──────────────────────────────

describe('VendorIntegrationsSection — per-product scoping', () => {
  const cards = (fixture: ComponentFixture<VendorIntegrationsSection>) =>
    el(fixture).querySelectorAll('aec-vendor-integration-card');

  it('shows the whole vendor-wide surface when unscoped', async () => {
    // `null` is what the single-page concept passes: it has no product selection
    // to narrow by, and AECI-606 requires it not to silently lose the section.
    expect(cards(await create(true, null))).toHaveLength(
      VENDOR_INTEGRATIONS_FIXTURE.integrations.length,
    );
  });

  it('shows only the entries filed under the given product', async () => {
    const scope = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].context_product.id;
    const expected = VENDOR_INTEGRATIONS_FIXTURE.integrations.filter(
      (i) => i.context_product.id === scope,
    ).length;

    const fixture = await create(true, scope);
    expect(cards(fixture)).toHaveLength(expected);
    expect(expected).toBeLessThan(VENDOR_INTEGRATIONS_FIXTURE.integrations.length);
  });

  it('still issues ONE vendor-wide read, not one per product', async () => {
    // The AECI-627 freshness cursor scopes `integrations` with the vendor-wide
    // predicate, and a cursor whose predicate differs from its list's is worse
    // than no cursor. So the narrowing is a VIEW concern; the request is not.
    await create(true, VENDOR_INTEGRATIONS_FIXTURE.integrations[0].context_product.id);
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
    expect(api.getIntegrations).toHaveBeenCalledWith();
  });
});
