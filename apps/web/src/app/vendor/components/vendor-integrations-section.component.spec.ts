/**
 * AECI-606 — `VendorIntegrationsSection`: the Integrations tab's body.
 *
 * The load ladder, the unverified read-only state (driven by
 * `me.vendor.verified`, NOT by an API error — `GET /api/vendor/integrations` is
 * ownership-gated but not account-access-gated, so a vendor without active access gets a real
 * 200), and the reconcile-from-echo / refetch-on-retract split.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { Location } from '@angular/common';
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
    expect(el(fixture).querySelectorAll('aec-vendor-integration-card')).toHaveLength(
      VENDOR_INTEGRATIONS_FIXTURE.integrations.length,
    );
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

describe('VendorIntegrationsSection — the inactive read-only state', () => {
  it('renders the full surface, explains account access, and offers no controls', async () => {
    const fixture = await create(false);
    const body = text(fixture);

    // Driven by the input, not by a 403: the read really does succeed.
    expect(api.getIntegrations).toHaveBeenCalled();
    expect(body).toContain('Procore');
    expect(body).toContain('with active vendor access');
    expect(body).toContain('arranged with AEC Integrations');
    expect(el(fixture).querySelector('aec-vendor-attestation-control')).toBeNull();
    expect(el(fixture).querySelector('aec-vendor-add-claim-form')).toBeNull();
  });

  it('points at account access and never at ranking, placement or search', async () => {
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
    expect(message).toContain('you confirmed this flow');
  });

  /**
   * AECI-961. "Position saved" was true and useless: a vendor who had just denied
   * a false claim heard that something was written, and nothing about whether
   * anyone would act on it. The stance and the §6.2 outcome sentence now go out
   * together, and the outcome half is the exact string the lane prints.
   */
  it('announces the stance and the consequence, differently for affirm and deny', async () => {
    const fixture = await create();
    const claim = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
    const component = fixture.componentInstance as unknown as {
      onClaimChanged(c: typeof claim): void;
    };
    const announcer = TestBed.inject(VendorPortalAnnouncer);

    component.onClaimChanged({ ...claim, mine: [{ ...claim.mine[0], asserted: false }] });
    fixture.detectChanges();
    const denied = announcer.message();
    expect(denied).toContain('you denied this flow');
    expect(denied).toContain('on the next daily check');
    // It names the counterparty, resolved from the store rather than passed down.
    expect(denied).toContain('Procore');

    component.onClaimChanged(claim);
    fixture.detectChanges();
    const affirmed = announcer.message();
    expect(affirmed).toContain('you confirmed this flow');
    expect(affirmed).not.toContain('you denied this flow');
  });

  it('degrades to the stance alone when the echo names an unloaded integration', async () => {
    // The outcome sentence names the other product, and there is no honest
    // wording for it without one.
    const fixture = await create();
    const claim = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
    const component = fixture.componentInstance as unknown as {
      onClaimChanged(c: typeof claim): void;
    };

    component.onClaimChanged({ ...claim, integration_id: 'not-a-loaded-integration' });
    fixture.detectChanges();

    const message = TestBed.inject(VendorPortalAnnouncer).message();
    expect(message).toContain('you confirmed this flow');
    expect(message).not.toContain('undefined');
    expect(message).not.toContain('null');
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
    const integrations = (VENDOR_INTEGRATIONS_FIXTURE as ListVendorIntegrationsResponse)
      .integrations;
    const claims = integrations.flatMap((i) => i.claims);
    // The two counts are scoped differently on purpose (AECI-705): everything on
    // record is readable, but only an attestable edge can be waiting on anyone.
    const awaiting = integrations
      .filter((i) => i.attestable)
      .flatMap((i) => i.claims)
      .filter((c) => c.mine.length === 0).length;

    expect(text(fixture)).toContain(`${claims.length}`);
    expect(text(fixture)).toContain(`${awaiting} waiting on your confirmation`);
  });
});

/**
 * AECI-960 / §6.7 — each card links to the edge's own PUBLIC PAIR PAGE.
 *
 * Not to the counterpart product. What a vendor authors on this card is claims
 * and attestations, and those render on the pair page; the counterpart's product
 * page shows none of it, so linking there would answer "let me see my change"
 * with a page the change is not on.
 *
 * The accessible name is destination-specific here and uniform at the other two
 * portal link sites, because this card REPEATS. N links reading "View public
 * page" and pointing N different places is `ACCESSIBILITY_AUDIT.md` finding A4
 * (WCAG 2.4.4 Link Purpose) reproduced inside the portal, and a rotor or links
 * list is where it bites. axe cannot see it, so these assertions are the guard.
 */
describe('VendorCounterpartGroup — links to the public pair page (§6.7)', () => {
  // AECI-999 moved the link from each integration card up to the counterpart
  // group row, because the pair page is per product pair, not per integration.
  const groupFor = (fixture: ComponentFixture<VendorIntegrationsSection>, name: string) => {
    const group = [...el(fixture).querySelectorAll('aec-vendor-counterpart-group')].find((g) =>
      (g.querySelector('h2')?.textContent ?? '').includes(name),
    );
    if (!group) throw new Error(`no group for "${name}"`);
    return group;
  };

  const linkIn = (group: Element) =>
    group.querySelector('aec-view-public-link a') as HTMLAnchorElement | null;

  it('builds the href context-slug first, other-slug second', async () => {
    const fixture = await create();
    const integration = VENDOR_INTEGRATIONS_FIXTURE.integrations.find(
      (i) => i.other_product.name === 'Procore' && i.context_product.name !== 'Summit Field Issues',
    );
    if (!integration) throw new Error('fixture lost its Procore edge');

    // The pair route's two segments are POSITIONAL. Swapping them addresses the
    // mirror page, which frames every direction the other way round, and it
    // still returns 200 — so nothing downstream would catch the swap.
    const hrefs = [...el(fixture).querySelectorAll('aec-vendor-counterpart-group')].map((g) =>
      linkIn(g)?.getAttribute('href'),
    );
    expect(hrefs).toContain(
      `/products/${integration.context_product.slug}/integrations/${integration.other_product.slug}`,
    );
  });

  it('gives every group exactly one link, in a new tab, with noopener', async () => {
    const fixture = await create();
    const groups = [...el(fixture).querySelectorAll('aec-vendor-counterpart-group')];

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.querySelectorAll('aec-view-public-link a')).toHaveLength(1);
      const link = linkIn(group);
      expect(link?.getAttribute('href')).toMatch(/^\/products\/[^/]+\/integrations\/[^/]+$/);
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener');
    }
  });

  it('keeps the link outside the disclosure button', async () => {
    const fixture = await create();
    for (const group of el(fixture).querySelectorAll('aec-vendor-counterpart-group')) {
      expect(group.querySelector('h2 button a')).toBeNull();
    }
  });

  it('names its destination in the accessible name, visible text first', async () => {
    const fixture = await create();
    const label = linkIn(groupFor(fixture, 'Procore'))?.getAttribute('aria-label') ?? '';

    // Visible text leads, for WCAG 2.5.3 Label in Name and speech input.
    expect(label.startsWith('View public page')).toBe(true);
    expect(label).toContain('Procore');
    // The new tab is stated, not left to be discovered.
    expect(label).toContain('opens in a new tab');
  });

  it('gives no two groups the same accessible name — the A4 guard', async () => {
    const fixture = await create();
    const labels = [...el(fixture).querySelectorAll('aec-vendor-counterpart-group')].map((g) =>
      linkIn(g)?.getAttribute('aria-label'),
    );

    expect(labels.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('links a read-only connector-powered group too', async () => {
    const fixture = await create();
    const powered = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => !i.attestable);
    if (!powered) throw new Error('fixture lost its connector-powered integration');

    // `attestable: false` withholds the WRITE controls. The public pair page is
    // a read, the edge is on it either way, and hiding the link would read as
    // the edge not being published.
    expect(linkIn(groupFor(fixture, powered.other_product.name))).not.toBeNull();
  });

  it('gives an owns-both edge a link framed from the endpoint it is filed under', async () => {
    const fixture = await create();
    const both = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => i.slots.length === 2);
    if (!both) throw new Error('fixture lost its owns-both integration');

    // One position, two framings (§6.5). Each group links to its OWN framing;
    // that is the correct answer, not a duplicate.
    expect(linkIn(groupFor(fixture, both.other_product.name))?.getAttribute('href')).toBe(
      `/products/${both.context_product.slug}/integrations/${both.other_product.slug}`,
    );
  });
});

// ─── AECI-705: connector-powered edges ───────────────────────────────────────

describe('VendorIntegrationsSection — connector-powered edges', () => {
  const poweredCard = (fixture: ComponentFixture<VendorIntegrationsSection>) => {
    const powered = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) => !i.attestable);
    if (!powered) throw new Error('fixture lost its connector-powered integration');
    const cards = [...el(fixture).querySelectorAll('aec-vendor-integration-card')];
    const card = cards.find((c) => (c.textContent ?? '').includes(powered.other_product.name));
    return { powered, card };
  };

  it('renders the powered edge read-only, naming the connector', async () => {
    const fixture = await create();
    const body = text(fixture);
    expect(body).toContain('Delivered through Agave ERP Sync');
    expect(body).toContain('neither product vendor confirms them');
  });

  it('offers no attestation control and no add-claim form on that card', async () => {
    const fixture = await create();
    const { card } = poweredCard(fixture);
    expect(card).toBeTruthy();
    expect(card?.querySelector('aec-vendor-attestation-control')).toBeNull();
    expect(card?.querySelector('aec-vendor-add-claim-form')).toBeNull();
  });

  it('still offers controls on the direct edges beside it', async () => {
    // The gate is per edge, not a mode. If a powered row could switch the whole
    // tab read-only, 14% of the catalogue would silently take the other 86% with it.
    const fixture = await create();
    expect(el(fixture).querySelectorAll('aec-vendor-attestation-control').length).toBeGreaterThan(
      0,
    );
    expect(el(fixture).querySelectorAll('aec-vendor-add-claim-form').length).toBeGreaterThan(0);
  });

  it('says nothing extra when the vendor is unverified — one explanation, not two', async () => {
    // The section already explains the vendor-level reason above the list.
    // Repeating a per-card reason there would read as two separate problems.
    const body = text(await create(false));
    expect(body).toContain('with active vendor access');
    expect(body).not.toContain('Delivered through');
  });

  it('falls back to the mechanism name when the connector is not a promoted product', async () => {
    // 53 of production's 132 powered edges, so this branch is the common one.
    api.getIntegrations.mockResolvedValue({
      integrations: [
        {
          ...VENDOR_INTEGRATIONS_FIXTURE.integrations[0],
          attestable: false,
          powered_by: null,
          mechanism_name: 'Zapier connector',
        },
      ],
    });
    expect(text(await create())).toContain('Delivered through Zapier connector');
  });

  it('stays generic when there is no connector name at all', async () => {
    api.getIntegrations.mockResolvedValue({
      integrations: [
        {
          ...VENDOR_INTEGRATIONS_FIXTURE.integrations[0],
          attestable: false,
          powered_by: null,
          mechanism_name: null,
        },
      ],
    });
    expect(text(await create())).toContain('Delivered through a connector');
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

/**
 * AECI-967 — the card is what carries the context product's SLUG down to the
 * lane, which holds only a UUID and display names of its own. The lane's spec
 * sets the input directly, so this is the only place the wiring is checked.
 */
describe('VendorIntegrationCard — feeds the conflict correction link (AECI-967)', () => {
  it('passes the context slug down, so the lane addresses the right listing', async () => {
    const fixture = await create();
    const integration = VENDOR_INTEGRATIONS_FIXTURE.integrations.find((i) =>
      i.claims.some((c) => c.agreement === 'conflict'),
    );
    if (!integration) throw new Error('fixture lost its conflict claim');

    const links = [
      ...el(fixture).querySelectorAll('li[aec-vendor-claim-lane] a[href$="/correction"]'),
    ];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      // The CONTEXT product, never the counterpart. Nothing downstream would
      // catch the swap: both slugs resolve and both pages return 200.
      expect(link.getAttribute('href')).toBe(
        `/products/${integration.context_product.slug}/correction`,
      );
    }
  });
});

// ─── AECI-999: the drill-down ────────────────────────────────────────────────

describe('VendorIntegrationsSection — drill-down (AECI-999)', () => {
  const groups = (fixture: ComponentFixture<VendorIntegrationsSection>) => [
    ...el(fixture).querySelectorAll('aec-vendor-counterpart-group'),
  ];
  const groupNamed = (fixture: ComponentFixture<VendorIntegrationsSection>, name: string) =>
    groups(fixture).find((g) => g.querySelector('h2')?.textContent?.includes(name))!;
  const toggleOf = (group: Element) => group.querySelector('h2 button') as HTMLButtonElement;
  const panelOf = (group: Element) =>
    group.querySelector(`#${toggleOf(group).getAttribute('aria-controls')}`) as HTMLElement;
  const chip = (fixture: ComponentFixture<VendorIntegrationsSection>, label: string) =>
    [...el(fixture).querySelectorAll('[role="group"] button')].find((b) =>
      b.textContent?.includes(label),
    ) as HTMLButtonElement;

  it('renders one group per counterpart, every one collapsed', async () => {
    const fixture = await create();
    const all = groups(fixture);
    // Five integrations with the same pair twice, so one fewer group.
    expect(all).toHaveLength(VENDOR_INTEGRATIONS_FIXTURE.integrations.length - 1);
    for (const group of all) {
      expect(toggleOf(group).getAttribute('aria-expanded')).toBe('false');
      expect(panelOf(group).hidden).toBe(true);
    }
    for (const lane of el(fixture).querySelectorAll('[aec-vendor-claim-lane] > button')) {
      expect(lane.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('shows health and counts on the collapsed row', async () => {
    const fixture = await create(
      true,
      VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!.context_product.id,
    );
    const procore = groupNamed(fixture, 'Procore');
    const row = toggleOf(procore).textContent ?? '';
    expect(row).toContain('Conflict');
    expect(row).toContain('2 integrations');
    expect(row).toContain('5 data flows');
    expect(row).toContain('1 in conflict');
  });

  it('opens a group on click and goes straight to the flows when it has one integration', async () => {
    const fixture = await create();
    const acumatica = groupNamed(fixture, 'Acumatica');
    toggleOf(acumatica).click();
    fixture.detectChanges();

    expect(toggleOf(acumatica).getAttribute('aria-expanded')).toBe('true');
    expect(panelOf(acumatica).hidden).toBe(false);
    // No second disclosure to open, and a label saying why.
    expect(acumatica.querySelector('h3 button')).toBeNull();
    expect(acumatica.textContent).toContain('The only integration on record with Acumatica');
  });

  it('nests a collapsed row per integration when a counterpart has several', async () => {
    const fixture = await create(
      true,
      VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!.context_product.id,
    );
    const procore = groupNamed(fixture, 'Procore');
    toggleOf(procore).click();
    fixture.detectChanges();

    const nested = [...procore.querySelectorAll('h3 button')];
    expect(nested).toHaveLength(2);
    for (const button of nested) expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(procore.textContent).toContain('Via Kroo Connector');
  });

  it('keeps a group open through a store update', async () => {
    const fixture = await create();
    const acumatica = groupNamed(fixture, 'Acumatica');
    toggleOf(acumatica).click();
    fixture.detectChanges();

    const store = TestBed.inject(VendorPortalStore);
    store.apply('integrations', (list) => list.map((i) => ({ ...i }))).commit();
    fixture.detectChanges();

    expect(toggleOf(groupNamed(fixture, 'Acumatica')).getAttribute('aria-expanded')).toBe('true');
  });

  it('filters by status, and clears', async () => {
    const fixture = await create();
    chip(fixture, 'Conflict').click();
    fixture.detectChanges();

    expect(chip(fixture, 'Conflict').getAttribute('aria-pressed')).toBe('true');
    expect(groups(fixture).map((g) => g.querySelector('h2')?.textContent?.trim())).toEqual([
      expect.stringContaining('Procore'),
    ]);
    expect(text(fixture)).toContain('Showing 1 of');

    const clear = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Clear filters'),
    )!;
    clear.click();
    fixture.detectChanges();
    expect(groups(fixture)).toHaveLength(VENDOR_INTEGRATIONS_FIXTURE.integrations.length - 1);
  });

  it('filters by text across data object names', async () => {
    const fixture = await create();
    const input = el(fixture).querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'punch';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(groups(fixture)).toHaveLength(1);
  });

  it('filters to integrations with the vendor on both sides', async () => {
    const fixture = await create();
    const select = el(fixture).querySelector('select') as HTMLSelectElement;
    select.value = 'own';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const both = VENDOR_INTEGRATIONS_FIXTURE.integrations.filter((i) => i.slots.length === 2);
    expect(groups(fixture)).toHaveLength(both.length);
  });

  it('keeps an opened integration listed after a write stops it matching the filter', async () => {
    const fixture = await create();
    chip(fixture, 'Needs your input').click();
    fixture.detectChanges();
    const before = groups(fixture).length;
    expect(before).toBeGreaterThan(0);

    const first = groups(fixture)[0]!;
    toggleOf(first).click();
    fixture.detectChanges();

    // Answer every flow, as an optimistic Affirm would.
    const store = TestBed.inject(VendorPortalStore);
    const mine = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!.claims[1]!.mine;
    store
      .apply('integrations', (list) =>
        list.map((i) => ({ ...i, claims: i.claims.map((c) => ({ ...c, mine })) })),
      )
      .commit();
    fixture.detectChanges();

    // The opened group stays put; the others, which were never opened, drop out.
    expect(groups(fixture)).toHaveLength(1);
    expect(toggleOf(groups(fixture)[0]!).getAttribute('aria-expanded')).toBe('true');
  });

  it('writes filters and open groups to the URL without navigating, when routed', async () => {
    const location = TestBed.inject(Location);
    const replace = vi.spyOn(location, 'replaceState');
    const fixture = TestBed.createComponent(VendorIntegrationsSection);
    fixture.componentRef.setInput('verified', true);
    fixture.componentRef.setInput('vendorName', 'Summit BIM');
    fixture.componentRef.setInput('urlState', true);
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    chip(fixture, 'Conflict').click();
    fixture.detectChanges();
    expect(replace).toHaveBeenLastCalledWith('/?status=conflict');

    toggleOf(groupNamed(fixture, 'Procore')).click();
    expect(replace).toHaveBeenLastCalledWith('/?status=conflict&open=procore');
  });

  it('does not touch the URL when unrouted', async () => {
    const location = TestBed.inject(Location);
    const replace = vi.spyOn(location, 'replaceState');
    const fixture = await create();
    chip(fixture, 'Conflict').click();
    expect(replace).not.toHaveBeenCalled();
  });
});
