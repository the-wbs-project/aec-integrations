/**
 * The public field captions (AECI-1614): one pure decision, every form. Each case is a
 * ruling on the issue, so a change here is a legal-text question first.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  newProductEditStamps,
  productEditStamps,
  productGroupCaptions,
  rowCaption,
  toFieldCorrections,
  type CorrectionRow,
  type ProductGroupValues,
} from './field-captions';

const EDITED = '2026-06-01T00:00:00.000Z';
const ENDED = '2026-09-01T00:00:00.000Z';

describe('productGroupCaptions', () => {
  const base = {
    vendorName: 'Acme',
    hasDescription: true,
    hasUsefulness: true,
    hasProfile: true,
    descriptionEditedAt: null,
    profileEditedAt: null,
    usefulnessEditedAt: null,
    managedEditedAt: null,
    managedEndedAt: null,
  };

  it('shows no caption on a group with no vendor write, even after the plan ended', () => {
    expect(productGroupCaptions({ ...base, managedEndedAt: ENDED })).toEqual({
      description: null,
      profile: null,
      usefulness: null,
      managed: null,
    });
  });

  it('shows "updated" with the stamp while the group is editable', () => {
    const edited = {
      ...base,
      descriptionEditedAt: EDITED,
      profileEditedAt: EDITED,
      usefulnessEditedAt: EDITED,
      managedEditedAt: EDITED,
    };
    const updated = { form: 'updated', vendor_names: ['Acme'], date: EDITED };
    expect(productGroupCaptions(edited)).toEqual({
      description: updated,
      profile: updated,
      usefulness: updated,
      managed: updated,
    });
  });

  it('moves the Managed-only groups to "until" once the plan ended, never the Free ones', () => {
    const result = productGroupCaptions({
      ...base,
      descriptionEditedAt: EDITED,
      profileEditedAt: EDITED,
      usefulnessEditedAt: EDITED,
      managedEditedAt: EDITED,
      managedEndedAt: ENDED,
    });
    expect(result.description).toEqual({ form: 'updated', vendor_names: ['Acme'], date: EDITED });
    expect(result.profile).toEqual({ form: 'updated', vendor_names: ['Acme'], date: EDITED });
    const until = { form: 'until', vendor_names: ['Acme'], date: ENDED };
    expect(result.usefulness).toEqual(until);
    expect(result.managed).toEqual(until);
  });

  it('captions nothing under an empty field, or with no vendor to name', () => {
    const edited = { ...base, descriptionEditedAt: EDITED, usefulnessEditedAt: EDITED };
    const empty = productGroupCaptions({ ...edited, hasDescription: false, hasUsefulness: false });
    expect(empty.description).toBeNull();
    expect(empty.usefulness).toBeNull();
    expect(
      productGroupCaptions({ ...base, profileEditedAt: EDITED, hasProfile: false }).profile,
    ).toBeNull();
    expect(productGroupCaptions({ ...edited, vendorName: null }).description).toBeNull();
  });
});

describe('rowCaption', () => {
  const held = {
    held: true,
    owner: { companyName: 'Acme', planEndedAt: null },
    vendorEditedAt: EDITED,
    connectorPowered: false,
    votes: [],
  };

  it('names the holder with its stamp', () => {
    expect(rowCaption(held)).toEqual({ form: 'updated', vendor_names: ['Acme'], date: EDITED });
  });

  it('shows nothing on a held row with no vendor write, even with an affirmation', () => {
    const vote = {
      source: 'vendor_a',
      asserted: true,
      retractedAt: null,
      createdAt: EDITED,
      attestedByVendor: { companyName: 'Globex' },
    };
    expect(rowCaption({ ...held, vendorEditedAt: null, votes: [vote] })).toBeNull();
  });

  it('keeps an ordinary row on "updated" after the plan ended: it stays editable on Free', () => {
    const owner = { companyName: 'Acme', planEndedAt: ENDED };
    expect(rowCaption({ ...held, owner })?.form).toBe('updated');
  });

  it('moves a connector-powered row to "until" when the owner has no live license', () => {
    const owner = { companyName: 'Acme', planEndedAt: ENDED };
    expect(rowCaption({ ...held, owner, connectorPowered: true })).toEqual({
      form: 'until',
      vendor_names: ['Acme'],
      date: ENDED,
    });
    expect(rowCaption({ ...held, connectorPowered: true })?.form).toBe('updated');
  });

  it('names both affirming vendors on an unheld row, A to Z, with the latest date', () => {
    const vote = (companyName: string, createdAt: string) => ({
      source: 'vendor_a',
      asserted: true,
      retractedAt: null,
      createdAt,
      attestedByVendor: { companyName },
    });
    expect(
      rowCaption({
        ...held,
        held: false,
        owner: null,
        vendorEditedAt: null,
        votes: [vote('zeta', EDITED), vote('Acme', ENDED), vote('Acme', EDITED)],
      }),
    ).toEqual({ form: 'updated', vendor_names: ['Acme', 'zeta'], date: ENDED });
  });

  it('names nobody for AECi, a denial, a retraction or a vote with no vendor', () => {
    const base = {
      source: 'vendor_a',
      asserted: true,
      retractedAt: null,
      createdAt: EDITED,
      attestedByVendor: { companyName: 'Acme' },
    };
    const votes = [
      { ...base, source: 'aeci' },
      { ...base, asserted: false },
      { ...base, retractedAt: ENDED },
      { ...base, attestedByVendor: null },
    ];
    expect(rowCaption({ ...held, held: false, vendorEditedAt: null, votes })).toBeNull();
  });
});

describe('toFieldCorrections', () => {
  const row = (over: Partial<CorrectionRow>): CorrectionRow => ({
    id: 'a',
    entityId: 'e',
    field: 'docs_url',
    value: 'https://right.example',
    sourceUrl: 'https://source.example',
    setAt: EDITED,
    live: 'https://right.example',
    ...over,
  });

  it('shows a correction whose value is still live, with no private field', () => {
    expect(toFieldCorrections([row({})])).toEqual([
      { field: 'docs_url', date: EDITED, source_url: 'https://source.example' },
    ]);
  });

  it('renders the date alone for a correction older than the source column', () => {
    expect(toFieldCorrections([row({ sourceUrl: null })])[0]?.source_url).toBeNull();
  });

  it('drops a correction once the vendor changed the value', () => {
    expect(toFieldCorrections([row({ live: 'https://vendor.example' })])).toEqual([]);
  });

  it('keeps only the newest per field, and does not fall back to an older match', () => {
    const older = row({ id: 'a', setAt: EDITED });
    const newer = row({ id: 'b', setAt: ENDED, value: 'https://other.example' });
    expect(toFieldCorrections([newer, older])).toEqual([]);
    expect(toFieldCorrections([older, row({ id: 'b', setAt: ENDED })])[0]?.date).toBe(ENDED);
  });

  it('treats a correction to empty as true while the field stays empty', () => {
    expect(toFieldCorrections([row({ value: null, live: null })])).toHaveLength(1);
    expect(toFieldCorrections([row({ value: null, live: 'x' })])).toEqual([]);
  });

  it('compares a facet as a set against the live slugs', () => {
    const facet = row({ field: 'trade_slugs', value: ['a', 'b'], live: null });
    expect(toFieldCorrections([facet], { trade_slugs: ['b', 'a'] })).toHaveLength(1);
    expect(toFieldCorrections([facet], { trade_slugs: ['a'] })).toEqual([]);
  });

  it('fails closed on a facet when the caller loaded no slugs', () => {
    const facet = row({ field: 'trade_slugs', value: [], live: null });
    expect(toFieldCorrections([facet])).toEqual([]);
  });

  it('orders by field, so a cached page is byte-stable', () => {
    const rows = [row({ field: 'name' }), row({ field: 'docs_url' })];
    expect(toFieldCorrections(rows).map((c) => c.field)).toEqual(['docs_url', 'name']);
  });
});

describe('productEditStamps', () => {
  const NOW = '2026-11-05T00:00:00.000Z';
  const values: ProductGroupValues = {
    description: 'Text',
    website: 'https://site.example',
    categories: ['bim', 'erp'],
    usefulness: { audiences: [{ slug: 'a', name: 'A', points: ['p'] }], phases: [] },
    toolIntegrationsUrl: 'https://a.example',
    apiDocsUrl: null,
    trades: ['x', 'y'],
    audiences: [],
    phases: [],
  };

  it('stamps nothing on an unchanged resend, reordered facets and JSON keys included', () => {
    const after = {
      ...values,
      trades: ['y', 'x'],
      categories: ['erp', 'bim'],
      usefulness: { phases: [], audiences: [{ points: ['p'], name: 'A', slug: 'a' }] },
    };
    expect(productEditStamps(values, after, NOW)).toEqual({});
  });

  it.each([
    ['description', { description: 'New' }, 'descriptionEditedAt'],
    ['website', { website: 'https://new.example' }, 'profileEditedAt'],
    ['category', { categories: ['bim'] }, 'profileEditedAt'],
    ['usefulness', { usefulness: null }, 'usefulnessEditedAt'],
    ['a doc URL', { apiDocsUrl: 'https://b.example' }, 'managedEditedAt'],
    ['a facet', { phases: ['design'] }, 'managedEditedAt'],
  ])('stamps only the group a %s change is in', (_label, change, stamp) => {
    expect(productEditStamps(values, { ...values, ...change }, NOW)).toEqual({ [stamp]: NOW });
  });

  it('gives a new product a stamp only for the groups it has content in', () => {
    expect(
      newProductEditStamps(
        {
          description: 'Text',
          website: 'https://site.example',
          categories: [],
          usefulness: null,
          trades: [],
          audiences: [],
          phases: [],
        },
        NOW,
      ),
    ).toEqual({ descriptionEditedAt: NOW, profileEditedAt: NOW });
  });
});

describe('promote never writes a stamp or a mirror', () => {
  it('no promote module names one, so an ingest cannot move a caption', () => {
    const roots = ['routes', 'lib'];
    const modules = roots.flatMap((root) =>
      readdirSync(join(process.cwd(), 'src', root))
        .filter((name) => name.startsWith('promote') && !name.endsWith('.spec.ts'))
        .map((name) => join(process.cwd(), 'src', root, name)),
    );
    expect(modules.some((path) => path.endsWith('routes/promote.ts'))).toBe(true);
    const names = /EditedAt|_edited_at|managedEndedAt|managed_ended_at|planEndedAt|plan_ended_at/;
    for (const path of modules) expect(readFileSync(path, 'utf8'), path).not.toMatch(names);
  });
});
