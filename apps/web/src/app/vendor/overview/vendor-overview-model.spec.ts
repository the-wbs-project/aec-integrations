/**
 * The overview's counting and ordering rules (AECI-983). Plain Vitest: the model
 * is pure, so none of this needs a TestBed.
 */
import { describe, expect, it } from 'vitest';

import type { VendorIntegration, VendorMeResponse, VendorProduct } from '@aeci/shared';

import {
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_DOWNGRADED_FIXTURE,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';

import {
  claimsOnRecord,
  PRODUCT_ROW_CAP,
  buildNeedsItems,
  conflictsByProduct,
  linkCommands,
  linkQueryParams,
  openCorrections,
  productGaps,
  profileGaps,
  waitingByProduct,
  type NeedsInput,
} from './vendor-overview-model';

const INTEGRATIONS = VENDOR_INTEGRATIONS_FIXTURE.integrations;
const PRODUCT = VENDOR_ME_FIXTURE.products[0] as VendorProduct;

/** A complete product, so a test adds exactly the gap it is about. */
const complete = (over: Partial<VendorProduct> = {}): VendorProduct => ({
  ...PRODUCT,
  description: 'Described.',
  website: 'https://example.com',
  logo_url: 'https://example.com/logo.png',
  category_slugs: ['bim-authoring'],
  ...over,
});

/**
 * The owns-both case as the API serves it: the same integration, the same claim
 * ids, once per frame. The fixture list carries only one frame, so the mirror is
 * built here.
 */
function ownsBoth(agreement: 'conflict' | 'unverified', mine: boolean): VendorIntegration[] {
  const base = INTEGRATIONS.find((i) => i.slots.length === 2) as VendorIntegration;
  const claims = base.claims.map((c) => ({
    ...c,
    agreement,
    mine: mine ? c.mine : [],
  }));
  const other = {
    id: VENDOR_ME_FIXTURE.products[1]!.id,
    slug: VENDOR_ME_FIXTURE.products[1]!.slug,
    name: VENDOR_ME_FIXTURE.products[1]!.name,
    logo_url: null,
  };
  return [
    { ...base, claims },
    { ...base, context_product: { ...base.context_product, ...other }, claims },
  ];
}

function input(over: Partial<NeedsInput> = {}): NeedsInput {
  return {
    me: VENDOR_ME_FIXTURE,
    integrations: INTEGRATIONS,
    integrationsReady: true,
    seatInviteCount: 0,
    canManageSeats: false,
    contestsToDecide: 0,
    canAttest: true,
    canEditProducts: true,
    canEditProfile: true,
    ...over,
  };
}

describe('conflictsByProduct / waitingByProduct — the claim-id dedupe (AECI-993)', () => {
  it('counts a claim on an owns-both integration once vendor-wide', () => {
    const both = ownsBoth('conflict', true);
    const claimCount = both[0]!.claims.length;

    const tally = conflictsByProduct(both);

    expect(tally.total).toBe(claimCount);
    // One row per frame, each carrying the claim: right per product, which is
    // exactly why the total is not their sum.
    expect(tally.byProduct).toHaveLength(2);
    expect(tally.byProduct.reduce((n, r) => n + r.count, 0)).toBe(claimCount * 2);
  });

  it('counts every claim on record once vendor-wide (the Integrations summary line)', () => {
    const both = ownsBoth('unverified', false);
    const tally = claimsOnRecord(both);
    expect(tally.total).toBe(both[0]!.claims.length);
    expect(tally.byProduct.reduce((n, r) => n + r.count, 0)).toBe(both[0]!.claims.length * 2);
  });

  it('dedupes waiting positions the same way', () => {
    const both = ownsBoth('unverified', false);
    expect(waitingByProduct(both).total).toBe(both[0]!.claims.length);
  });

  it('never counts a connector-powered edge as waiting', () => {
    const powered = INTEGRATIONS.filter((i) => !i.attestable);
    expect(powered.length).toBeGreaterThan(0);
    expect(powered.some((i) => i.claims.some((c) => c.mine.length === 0))).toBe(true);

    expect(waitingByProduct(powered).total).toBe(0);
  });

  it('counts only conflict claims as conflicts', () => {
    const expected = new Set(
      INTEGRATIONS.flatMap((i) => i.claims)
        .filter((c) => c.agreement === 'conflict')
        .map((c) => c.id),
    ).size;
    expect(conflictsByProduct(INTEGRATIONS).total).toBe(expected);
  });
});

describe('openCorrections', () => {
  const base = VENDOR_ME_FIXTURE.requests[0]!;

  it('excludes claims, and resolved or rejected corrections', () => {
    const result = openCorrections([
      { ...base, id: 'a', kind: 'correction', status: 'open' },
      { ...base, id: 'b', kind: 'correction', status: 'in_review' },
      { ...base, id: 'c', kind: 'claim', status: 'open' },
      { ...base, id: 'd', kind: 'correction', status: 'resolved' },
      { ...base, id: 'e', kind: 'correction', status: 'rejected' },
    ]);
    expect(result.items.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('reports the newest created_at, and null when there is none', () => {
    const result = openCorrections([
      { ...base, id: 'old', status: 'open', created_at: '2026-01-01T00:00:00.000Z' },
      { ...base, id: 'new', status: 'open', created_at: '2026-03-01T00:00:00.000Z' },
    ]);
    expect(result.items[0]?.id).toBe('new');
    expect(result.newestCreatedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(openCorrections([]).newestCreatedAt).toBeNull();
  });
});

describe('productGaps / profileGaps', () => {
  it('never treats empty trades, audiences or phases as a gap', () => {
    expect(productGaps(complete({ trade_slugs: [], audience_slugs: [], phase_slugs: [] }))).toEqual(
      [],
    );
  });

  it('flags a blank description, website, logo and categories', () => {
    expect(
      productGaps(
        complete({ description: '  ', website: null, logo_url: null, category_slugs: [] }),
      ),
    ).toEqual(['description', 'website', 'logo', 'categories']);
  });

  it('flags the four company-profile fields and nothing else', () => {
    const vendor = {
      ...VENDOR_ME_FIXTURE.vendor,
      description: null,
      website: '',
      logo_url: null,
      headquarters: null,
      founded_year: null,
      linkedin_url: null,
    };
    expect(profileGaps(vendor)).toEqual(['description', 'website', 'logo', 'headquarters']);
  });
});

describe('buildNeedsItems', () => {
  it('orders Needs you now as conflicts, then open corrections', () => {
    const { now } = buildNeedsItems(input());
    const types = now.map((i) => i.type);
    expect(types[0]).toBe('conflict');
    expect(types.lastIndexOf('conflict')).toBeLessThan(types.indexOf('correction'));
  });

  it('never lists a claim request', () => {
    const { now, worthDoing } = buildNeedsItems(input());
    const requests = [...now, ...worthDoing].flatMap((i) =>
      i.type === 'correction' ? [i.request] : [],
    );
    expect(requests.every((r) => r.kind === 'correction')).toBe(true);
  });

  it('claims no conflict or waiting row before the integrations read lands', () => {
    const { now, worthDoing } = buildNeedsItems(input({ integrationsReady: false }));
    expect(now.some((i) => i.type === 'conflict')).toBe(false);
    expect(worthDoing.some((i) => i.type === 'waiting')).toBe(false);
  });

  it('caps product rows at three and adds an "and N more" row', () => {
    const products = Array.from({ length: PRODUCT_ROW_CAP + 2 }, (_, n) =>
      complete({ id: `p-${n}`, slug: `p-${n}`, name: `P ${n}`, website: null }),
    );
    const me: VendorMeResponse = { ...VENDOR_ME_FIXTURE, products };
    const { worthDoing } = buildNeedsItems(input({ me, canAttest: false }));

    const gaps = worthDoing.filter((i) => i.type === 'productGaps');
    const more = worthDoing.find((i) => i.type === 'productGapsMore');
    expect(gaps).toHaveLength(PRODUCT_ROW_CAP);
    expect(more?.type === 'productGapsMore' && more.products).toBe(2);
  });

  it('sorts waiting rows by count, highest first', () => {
    const { worthDoing } = buildNeedsItems(input());
    const counts = worthDoing.flatMap((i) => (i.type === 'waiting' ? [i.count] : []));
    expect(counts).toEqual(counts.slice().sort((a, b) => b - a));
  });

  it('links a product missing categories to its taxonomy tab, others to its profile', () => {
    const me: VendorMeResponse = {
      ...VENDOR_ME_FIXTURE,
      products: [
        complete({ id: 'a', slug: 'a', category_slugs: [] }),
        complete({ id: 'b', slug: 'b', website: null }),
      ],
    };
    const { worthDoing } = buildNeedsItems(input({ me, canAttest: false }));
    expect(worthDoing.map((i) => linkCommands(i.link))).toEqual([
      ['..', 'products', 'a', 'categories'],
      ['..', 'products', 'b', 'profile'],
      ...(profileGaps(VENDOR_ME_FIXTURE.vendor).length > 0 ? [['..', 'profile']] : []),
    ]);
  });

  it('gates each Worth doing item on its own capability', () => {
    const base = input({ seatInviteCount: 2, canManageSeats: true });
    const has = (over: Partial<NeedsInput>, type: string) =>
      buildNeedsItems({ ...base, ...over }).worthDoing.some((i) => i.type === type);

    expect(has({}, 'waiting')).toBe(true);
    expect(has({ canAttest: false }, 'waiting')).toBe(false);

    expect(has({}, 'productGaps')).toBe(true);
    expect(has({ canEditProducts: false }, 'productGaps')).toBe(false);

    expect(has({}, 'profileGaps')).toBe(true);
    expect(has({ canEditProfile: false }, 'profileGaps')).toBe(false);

    expect(has({}, 'seatInvites')).toBe(true);
    expect(has({ canManageSeats: false }, 'seatInvites')).toBe(false);
  });

  it('pauses editing rows without any editing capability, but keeps corrections and seat invites', () => {
    const result = buildNeedsItems(
      input({
        me: VENDOR_ME_DOWNGRADED_FIXTURE,
        canAttest: false,
        canEditProducts: false,
        canEditProfile: false,
        canManageSeats: true,
        seatInviteCount: 3,
      }),
    );
    expect(result.paused).toBe(true);
    expect(result.worthDoing.map((i) => i.type)).toEqual(['seatInvites']);
    expect(result.now.some((i) => i.type === 'correction')).toBe(true);
  });
});

describe('buildNeedsItems — field contests to decide (AECI-1008)', () => {
  it('adds one Needs you now row, linked to Messages, after conflicts and corrections', () => {
    const { now } = buildNeedsItems(input({ contestsToDecide: 2 }));
    const row = now.find((i) => i.type === 'contests');
    expect(row).toMatchObject({ count: 2, link: { kind: 'messages' } });
    expect(now.at(-1)?.type).toBe('contests');
  });

  it('is absent at zero', () => {
    expect(buildNeedsItems(input()).now.some((i) => i.type === 'contests')).toBe(false);
  });

  it('is never capability-gated: deciding needs a seat only (§11b.2)', () => {
    const { now, paused } = buildNeedsItems(
      input({
        contestsToDecide: 1,
        canAttest: false,
        canEditProducts: false,
        canEditProfile: false,
      }),
    );
    expect(paused).toBe(true);
    expect(now.some((i) => i.type === 'contests')).toBe(true);
  });
});

describe('linkQueryParams (AECI-999)', () => {
  it('pre-filters integrations links to the state they count', () => {
    expect(linkQueryParams({ kind: 'integrations', productSlug: 'x', status: 'conflict' })).toEqual(
      { status: 'conflict' },
    );
    expect(linkQueryParams({ kind: 'integrations', productSlug: 'x' })).toBeNull();
    expect(linkQueryParams({ kind: 'messages' })).toBeNull();
  });

  it('files conflict rows under the conflict filter and waiting rows under needs_you', () => {
    const { now, worthDoing } = buildNeedsItems({
      me: VENDOR_ME_FIXTURE,
      integrations: VENDOR_INTEGRATIONS_FIXTURE.integrations,
      integrationsReady: true,
      canAttest: true,
      canEditProducts: false,
      canEditProfile: false,
      canManageSeats: false,
      seatInviteCount: 0,
      contestsToDecide: 0,
    });
    const conflict = now.find((i) => i.type === 'conflict');
    const waiting = worthDoing.find((i) => i.type === 'waiting');
    expect(conflict && linkQueryParams(conflict.link)).toEqual({ status: 'conflict' });
    expect(waiting && linkQueryParams(waiting.link)).toEqual({ status: 'needs_you' });
  });
});
