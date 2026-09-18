import { describe, expect, it } from 'vitest';

import {
  buildCacheTagsForVendor,
  buildVendorAuditInsert,
  buildVendorDeleteStatements,
  buildVendorFootprintSql,
  buildVendorLookupSql,
  buildVendorLookupSqlForIds,
  checkConfirmCount,
  classifyVendorRetraction,
  escapeSqlLiteral,
  formatVendorFootprintReport,
  parseVendorFootprint,
  RETRACT_VENDOR_ISSUE,
  RETRACT_VENDOR_REASON,
  RETRACT_VENDOR_TOOL_PATH,
  type RawVendorFootprintRow,
  type VendorFootprint,
  type VendorRow,
} from './retract-vendor';

/** A vendor that owns nothing but has been visited and has authored curation. */
const RAW_CLEAN: RawVendorFootprintRow = {
  products: 0,
  integrations: 0,
  evidenced_pairs: 0,
  profiles: 0,
  entitlements: 0,
  seat_invites: 0,
  claims: 3,
  attestations: 2,
  page_views: 41,
};

const VENDOR: VendorRow = {
  id: '2db3274e-e4e4-465d-9b7a-aa09faa3626b',
  slug: 'skyway-consulting',
  company_name: 'Skyway Consulting',
  promotion_status: 'promoted',
  verified: 0,
};

const AUDIT_ARGS = {
  vendor: VENDOR,
  footprint: parseVendorFootprint(RAW_CLEAN),
  auditId: '00000000-0000-4000-8000-000000000001',
  now: '2026-09-18T12:00:00.000Z',
};

describe('escapeSqlLiteral', () => {
  it("doubles single quotes so a value can't break the literal", () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("O''Brien");
  });
});

describe('buildVendorLookupSql', () => {
  it('matches by slug', () => {
    expect(buildVendorLookupSql({ slug: 'skyway-consulting' })).toContain(
      `"slug" = 'skyway-consulting'`,
    );
  });
  it('matches by id and escapes it', () => {
    expect(buildVendorLookupSql({ id: "x'y" })).toContain(`"id" = 'x''y'`);
  });
});

describe('buildVendorLookupSqlForIds', () => {
  it('reads the whole cohort in one ordered statement, escaping each id', () => {
    const sql = buildVendorLookupSqlForIds(['a', "b'c"]);
    expect(sql).toContain(`"id" IN ('a', 'b''c')`);
    expect(sql).toContain('ORDER BY "id"');
  });
});

describe('buildVendorFootprintSql', () => {
  it('escapes the id and counts every one of the nine referencing tables', () => {
    const sql = buildVendorFootprintSql("a'b");
    expect(sql).toContain(`'a''b'`);
    for (const t of [
      '"product_vendors"',
      '"integrations"',
      '"connector_evidenced_pairs"',
      '"profiles"',
      '"vendor_entitlements"',
      '"vendor_seat_invites"',
      '"claims"',
      '"attestations"',
      '"page_views"',
    ]) {
      expect(sql).toContain(t);
    }
  });

  it('counts BOTH edge tables separately — the AECI-721 two-table rule', () => {
    const sql = buildVendorFootprintSql('v1');
    expect(sql).toContain(`FROM "integrations" WHERE "built_by_vendor_id" = 'v1'`);
    expect(sql).toContain(`FROM "connector_evidenced_pairs" WHERE "built_by_vendor_id" = 'v1'`);
  });
});

describe('classifyVendorRetraction', () => {
  const clean = parseVendorFootprint(RAW_CLEAN);

  it('allows a vendor that owns nothing, and reports the detach counts', () => {
    const c = classifyVendorRetraction(clean);
    expect(c.safe).toBe(true);
    expect(c.blockers).toEqual([]);
    expect(clean.claims).toBe(3);
    expect(clean.attestations).toBe(2);
    expect(clean.pageViews).toBe(41);
  });

  const refusalCases: Array<[keyof VendorFootprint, string]> = [
    ['products', 'product'],
    ['integrations', 'integration'],
    ['evidencedPairs', 'connector-evidenced pair'],
    ['profiles', 'profile'],
    ['entitlements', 'entitlement'],
    ['seatInvites', 'seat invite'],
  ];

  for (const [field, needle] of refusalCases) {
    it(`refuses on ${field}`, () => {
      const c = classifyVendorRetraction({ ...clean, [field]: 1 });
      expect(c.safe).toBe(false);
      expect(c.blockers).toHaveLength(1);
      expect(c.blockers[0]).toContain(needle);
    });
  }

  it('refuses on an evidenced-pair edge even when the integrations table is clean', () => {
    const c = classifyVendorRetraction({ ...clean, integrations: 0, evidencedPairs: 4 });
    expect(c.safe).toBe(false);
    expect(c.blockers.join(' ')).toContain('connector-evidenced pair');
  });

  it('lists every blocker rather than stopping at the first', () => {
    const c = classifyVendorRetraction({
      ...clean,
      products: 2,
      integrations: 1,
      evidencedPairs: 1,
      profiles: 1,
      entitlements: 1,
      seatInvites: 1,
    });
    expect(c.blockers).toHaveLength(6);
  });
});

describe('buildVendorDeleteStatements', () => {
  const stmts = buildVendorDeleteStatements(AUDIT_ARGS);
  const idx = (needle: string) => stmts.findIndex((s) => s.includes(needle));

  it('detaches every child before deleting the parent vendor row', () => {
    expect(idx('UPDATE "page_views"')).toBeLessThan(idx('DELETE FROM "vendors"'));
    expect(idx('UPDATE "claims"')).toBeLessThan(idx('DELETE FROM "vendors"'));
    expect(idx('UPDATE "attestations"')).toBeLessThan(idx('DELETE FROM "vendors"'));
  });

  it('NULLs page_views.vendor_id and never deletes a page_views row', () => {
    expect(stmts[0]).toBe(
      `UPDATE "page_views" SET "vendor_id" = NULL WHERE "vendor_id" = '${VENDOR.id}';`,
    );
    expect(stmts.some((s) => s.includes('DELETE FROM "page_views"'))).toBe(false);
  });

  it('puts the audit INSERT in the same batch, last, after the delete', () => {
    expect(idx('INSERT INTO "audit_log"')).toBeGreaterThan(idx('DELETE FROM "vendors"'));
    expect(stmts.at(-1)).toContain('INSERT INTO "audit_log"');
  });

  it('touches no table the classification would have refused on', () => {
    const joined = stmts.join('\n');
    for (const t of [
      '"product_vendors"',
      '"connector_evidenced_pairs"',
      '"profiles"',
      '"vendor_entitlements"',
      '"vendor_seat_invites"',
    ]) {
      expect(joined).not.toContain(t);
    }
  });

  it('escapes the id in every statement', () => {
    const escaped = buildVendorDeleteStatements({
      ...AUDIT_ARGS,
      vendor: { ...VENDOR, id: "a'b" },
    });
    for (const s of escaped) expect(s).toContain(`a''b`);
  });
});

describe('buildVendorAuditInsert', () => {
  const sql = buildVendorAuditInsert(AUDIT_ARGS);

  it('matches the consume.mjs column list and shape', () => {
    expect(sql).toContain(
      'INSERT INTO "audit_log" ("id","actor_id","actor_type","action","entity_type","entity_id","before_state","metadata","created_at")',
    );
    // actor_id is NULL — a CLI run has no profile row.
    expect(sql).toContain(`,NULL,'system','vendor.deleted','vendor','${VENDOR.id}',`);
  });

  it('carries the tool, the issue and the ruling in metadata', () => {
    expect(sql).toContain(RETRACT_VENDOR_TOOL_PATH);
    expect(sql).toContain(RETRACT_VENDOR_ISSUE);
    expect(sql).toContain(RETRACT_VENDOR_REASON);
  });

  it('records the vendor row and the detach counts in before_state', () => {
    const json = sql.slice(sql.indexOf(`'{`), sql.lastIndexOf(`'`));
    expect(json).toContain('Skyway Consulting');
    expect(json).toContain('page_views');
  });

  it('escapes a quote inside the JSON payload rather than breaking the literal', () => {
    const quoted = buildVendorAuditInsert({
      ...AUDIT_ARGS,
      vendor: { ...VENDOR, company_name: "O'Brien Co" },
    });
    expect(quoted).toContain("O''Brien Co");
  });
});

describe('buildCacheTagsForVendor', () => {
  it('purges the vendor detail tag; there is no /vendors index page', () => {
    expect(buildCacheTagsForVendor('skyway-consulting')).toEqual(['vendor:skyway-consulting']);
  });
});

describe('checkConfirmCount', () => {
  it('requires the flag to apply', () => {
    const r = checkConfirmCount(undefined, 8);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('8');
  });

  it('refuses a mismatch', () => {
    const r = checkConfirmCount('7', 8);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('does not match');
  });

  it('refuses a non-integer', () => {
    expect(checkConfirmCount('eight', 8).ok).toBe(false);
    expect(checkConfirmCount('8.5', 8).ok).toBe(false);
  });

  it('accepts an exact match', () => {
    expect(checkConfirmCount('8', 8)).toEqual({ ok: true });
  });
});

describe('formatVendorFootprintReport', () => {
  it('shows the identity, the Algolia state and every footprint row', () => {
    const report = formatVendorFootprintReport({
      vendor: VENDOR,
      footprint: parseVendorFootprint(RAW_CLEAN),
      classification: classifyVendorRetraction(parseVendorFootprint(RAW_CLEAN)),
      inAlgolia: true,
    });
    expect(report).toContain('Skyway Consulting');
    expect(report).toContain(VENDOR.id);
    expect(report).toContain('Algolia:  yes');
    expect(report).toContain('connector-evidenced pairs built');
    expect(report).toContain('page_views → vendor_id NULLed');
    expect(report).not.toContain('REFUSED');
  });

  it('prints the refusal reason per vendor', () => {
    const footprint = { ...parseVendorFootprint(RAW_CLEAN), products: 2 };
    const report = formatVendorFootprintReport({
      vendor: VENDOR,
      footprint,
      classification: classifyVendorRetraction(footprint),
    });
    expect(report).toContain('REFUSED');
    expect(report).toContain('owns 2 product(s)');
    expect(report).toContain('Algolia:  not checked');
  });
});
