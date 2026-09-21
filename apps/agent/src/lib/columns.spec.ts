import { describe, expect, it } from 'vitest';

import {
  DENIED_COLUMNS,
  DENIED_TABLES,
  findDeniedKeys,
  isDeniedColumn,
  isDeniedTable,
} from './columns';

describe('column denylist', () => {
  it('matches a denied column in snake_case AND camelCase', () => {
    // Guards: a mapper between D1 and the model can change the key shape, and a
    // denylist that only knew one spelling would miss the other.
    expect(isDeniedColumn('admin_notes')).toBe(true);
    expect(isDeniedColumn('adminNotes')).toBe(true);
    expect(isDeniedColumn('vqs_total')).toBe(true);
    expect(isDeniedColumn('vqsTotal')).toBe(true);
  });

  it('does NOT deny the reader-facing keys that sit next to them', () => {
    // Guards: over-reach. `note` is reader-facing when a VENDOR wrote it —
    // `readerFacingNote()` suppresses it only for source = 'aeci' — while `notes`
    // (plural, on integrations) is curation-internal in every row. Denying
    // `note` would break the legitimate pair payload.
    expect(isDeniedColumn('note')).toBe(false);
    expect(isDeniedColumn('notes')).toBe(true);
    // `maintenance` is a published block (AECI-981), not an internal one.
    expect(isDeniedColumn('maintained_by')).toBe(false);
    expect(isDeniedColumn('last_reviewed_at')).toBe(false);
    for (const key of ['slug', 'name', 'description', 'website', 'product_role']) {
      expect(isDeniedColumn(key), key).toBe(false);
    }
  });

  it('bans the whole-table set', () => {
    expect(isDeniedTable('profiles')).toBe(true);
    expect(isDeniedTable('audit_log')).toBe(true);
    expect(isDeniedTable('page_views')).toBe(true);
    expect(isDeniedTable('vendor_entitlements')).toBe(true);
    expect(isDeniedTable('products')).toBe(false);
    expect(isDeniedTable('connector_evidenced_pairs')).toBe(false);
  });

  it('has no duplicate entries in either list', () => {
    // Guards: a duplicate is a sign two people added the same name for different
    // reasons and one of the comments is now wrong.
    expect(new Set(DENIED_COLUMNS).size).toBe(DENIED_COLUMNS.length);
    expect(new Set(DENIED_TABLES).size).toBe(DENIED_TABLES.length);
  });
});

describe('findDeniedKeys', () => {
  it('finds a denied key nested in objects and arrays, and names its path', () => {
    // Guards: tool output is a tree, not a row. A scan that only checked the top
    // level would miss exactly the case that matters.
    const output = { products: [{ slug: 'zoho', admin_notes: 'internal' }] };
    expect(findDeniedKeys(output)).toEqual(['$.products[0].admin_notes']);
  });

  it('returns nothing for clean output', () => {
    expect(findDeniedKeys({ products: [{ slug: 'zoho', name: 'Zoho' }] })).toEqual([]);
  });

  it('tolerates primitives, null and empty containers', () => {
    expect(findDeniedKeys(null)).toEqual([]);
    expect(findDeniedKeys('a string')).toEqual([]);
    expect(findDeniedKeys(7)).toEqual([]);
    expect(findDeniedKeys([])).toEqual([]);
    expect(findDeniedKeys({})).toEqual([]);
  });
});
