/**
 * The §7.1 detectors (AECI-302), against the in-memory D1 harness — real
 * migrations, so the partial unique index and the CHECKs are genuinely enforced
 * while these fixtures are built.
 *
 * Every detector has a **zero-result** case (the §7 AC), because the zero case is
 * the one that runs in production for the epic's first months: nothing in D1
 * carries a vendor attestation yet.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  detectAeciDenied,
  detectOpenConflict,
  detectSilentCounterparty,
  detectStaleVersion,
  loadDetectorClaims,
  runAttestationDetectors,
  OPEN_CONFLICT_DAYS,
  SILENT_COUNTERPARTY_DAYS,
  type DetectorClaim,
} from './attestation-detectors';
import { vendorsForIntegrationSlots } from './attestation-authority';
import {
  attestations,
  claims,
  integrations,
  productVendors,
  productVersions,
  products,
  taxonomyDataObjects,
  vendors,
} from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Procore = endpoint A (owned by ACME), Revit = endpoint B (owned by GLOBEX).
const PROCORE = u(1);
const REVIT = u(2);
const INTEGRATION = u(10);
const RFIS = u(20);
const CLAIM = u(30);
const ACME = u(901);
const GLOBEX = u(902);

/** Fixed clock so every threshold assertion is a pure date comparison. */
const NOW = new Date('2026-08-17T10:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const monthsAgo = (n: number) => new Date(Date.UTC(2026, 7 - n, 17, 10, 0, 0, 0)).toISOString();

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(products).values([
    { id: PROCORE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: REVIT, slug: 'revit', name: 'Revit', promotionStatus: 'promoted' },
  ]);
  await t.db.insert(vendors).values([
    { id: ACME, companyName: 'Acme Software', slug: 'acme-software' },
    { id: GLOBEX, companyName: 'Globex', slug: 'globex' },
  ]);
  await t.db.insert(integrations).values({
    id: INTEGRATION,
    sourceProductId: PROCORE,
    targetProductId: REVIT,
    mechanismKind: 'native',
    mechanismName: 'Procore Connector',
    direction: 'one-way',
  });
  await t.db
    .insert(taxonomyDataObjects)
    .values({ id: RFIS, slug: 'rfis', name: 'RFIs', displayOrder: 110 });
});
afterEach(() => t.dispose());

/** Give each product its vendor, so the inverse slot lookup has someone to nudge. */
async function seedOwnership(opts: { source?: string; target?: string } = {}) {
  const rows = [
    { productId: PROCORE, vendorId: opts.source ?? ACME },
    { productId: REVIT, vendorId: opts.target ?? GLOBEX },
  ];
  await t.db.insert(productVendors).values(rows);
}

interface SeedAttestation {
  source: string;
  asserted: boolean;
  by?: string;
  createdAt?: string;
  retractedAt?: string;
  introducedAt?: string;
  deprecatedAt?: string;
  deprecatedVersionId?: string;
}

async function seedClaim(atts: SeedAttestation[], claimOpts: { origin?: 'aeci' | 'vendor' } = {}) {
  await t.db.insert(claims).values({
    id: CLAIM,
    integrationId: INTEGRATION,
    dataObjectId: RFIS,
    direction: 'a_to_b',
    origin: claimOpts.origin ?? 'aeci',
  });
  for (const a of atts) {
    await t.db.insert(attestations).values({
      id: crypto.randomUUID(),
      claimId: CLAIM,
      source: a.source,
      asserted: a.asserted,
      attestedByVendorId: a.by ?? null,
      retractedAt: a.retractedAt ?? null,
      introducedAt: a.introducedAt ?? null,
      deprecatedAt: a.deprecatedAt ?? null,
      deprecatedVersionId: a.deprecatedVersionId ?? null,
      ...(a.createdAt ? { createdAt: a.createdAt } : {}),
    });
  }
}

async function load(): Promise<DetectorClaim[]> {
  return loadDetectorClaims(t.db);
}

async function slots() {
  return vendorsForIntegrationSlots(t.db, [INTEGRATION]);
}

// ─── The shared read ─────────────────────────────────────────────────────────

describe('loadDetectorClaims', () => {
  it('skips claims with no vendor attestation at all — the launch state', async () => {
    await seedClaim([{ source: 'aeci', asserted: true }]);
    expect(await load()).toHaveLength(0);
  });

  it('skips a claim whose only vendor attestation is retracted', async () => {
    await seedClaim([
      { source: 'aeci', asserted: true },
      { source: 'vendor_a', asserted: true, by: ACME, retractedAt: daysAgo(1) },
    ]);
    expect(await load()).toHaveLength(0);
  });

  it('loads a vendor-attested claim with its live votes only', async () => {
    await seedClaim([
      { source: 'aeci', asserted: true },
      { source: 'vendor_a', asserted: true, by: ACME, retractedAt: daysAgo(1) },
      { source: 'vendor_b', asserted: true, by: GLOBEX },
    ]);
    const rows = await load();
    expect(rows).toHaveLength(1);
    // The AECi seed still loads (the engine ignores it); the retracted row does not.
    expect(rows[0].attestations.map((a) => a.source).sort()).toEqual(['aeci', 'vendor_b']);
    expect(rows[0].integration.sourceProduct.slug).toBe('procore');
    expect(rows[0].dataObject.name).toBe('RFIs');
  });
});

// ─── silent-counterparty ─────────────────────────────────────────────────────

describe('detectSilentCounterparty', () => {
  it('finds nothing when there is nothing to find', async () => {
    expect(detectSilentCounterparty([], new Map(), NOW)).toEqual([]);
  });

  it('nudges the silent slot once the claim has been one-sided past the threshold', async () => {
    await seedOwnership();
    await seedClaim([
      { source: 'aeci', asserted: true },
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS + 1),
      },
    ]);

    const findings = detectSilentCounterparty(await load(), await slots(), NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detector: 'silent-counterparty',
      claimId: CLAIM,
      vendorId: GLOBEX,
    });
    // Recipient-relative: the silent vendor owns Revit, so Revit is the subject.
    expect(findings[0].context.subjectProduct.name).toBe('Revit');
    expect(findings[0].context.counterpartProduct.name).toBe('Procore');
    expect(findings[0].context.mechanismName).toBe('Procore Connector');
  });

  it('stays quiet inside the threshold', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS - 1),
      },
    ]);
    expect(detectSilentCounterparty(await load(), await slots(), NOW)).toEqual([]);
  });

  it('measures age from the OLDEST affirmation, so a re-confirm does not reset the clock', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS + 5),
      },
      // A second live affirmation from the same vendor on the other slot is
      // impossible to read as "the silent side acted", so it must not reset age.
      { source: 'vendor_b', asserted: true, by: ACME, createdAt: daysAgo(1) },
    ]);
    // ...but with ACME holding BOTH slots there is no silent slot to nudge.
    expect(detectSilentCounterparty(await load(), await slots(), NOW)).toEqual([]);
  });

  it('is silent when one company owns both endpoints (§4.5 dedupe, no silent slot)', async () => {
    await seedOwnership({ source: ACME, target: ACME });
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS + 1),
      },
      {
        source: 'vendor_b',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS + 1),
      },
    ]);
    expect(detectSilentCounterparty(await load(), await slots(), NOW)).toEqual([]);
  });

  it('is silent when the silent product has no vendor to nudge', async () => {
    await t.db.insert(productVendors).values({ productId: PROCORE, vendorId: ACME });
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS + 1),
      },
    ]);
    expect(detectSilentCounterparty(await load(), await slots(), NOW)).toEqual([]);
  });
});

// ─── open-conflict ───────────────────────────────────────────────────────────

describe('detectOpenConflict', () => {
  it('finds nothing when there is nothing to find', async () => {
    expect(detectOpenConflict([], NOW)).toEqual([]);
  });

  it('nudges both disputants and raises one ops finding', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(OPEN_CONFLICT_DAYS + 3),
      },
      {
        source: 'vendor_b',
        asserted: false,
        by: GLOBEX,
        createdAt: daysAgo(OPEN_CONFLICT_DAYS + 1),
      },
    ]);

    const findings = detectOpenConflict(await load(), NOW);
    expect(findings.map((f) => f.vendorId)).toEqual([ACME, GLOBEX, null]);
    expect(new Set(findings.map((f) => f.detector))).toEqual(new Set(['open-conflict']));
    // Each disputant is addressed in the slot it actually attested on.
    expect(findings[0].context.subjectProduct.name).toBe('Procore');
    expect(findings[1].context.subjectProduct.name).toBe('Revit');
  });

  it('measures age from the NEWEST vote — the moment the disagreement began', async () => {
    await seedOwnership();
    await seedClaim([
      { source: 'vendor_a', asserted: true, by: ACME, createdAt: daysAgo(90) },
      {
        source: 'vendor_b',
        asserted: false,
        by: GLOBEX,
        createdAt: daysAgo(OPEN_CONFLICT_DAYS - 1),
      },
    ]);
    expect(detectOpenConflict(await load(), NOW)).toEqual([]);
  });

  it('still raises ops when a disputant vendor row was deleted (orphaned vote)', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(OPEN_CONFLICT_DAYS + 1),
      },
      {
        source: 'vendor_b',
        asserted: false,
        by: GLOBEX,
        createdAt: daysAgo(OPEN_CONFLICT_DAYS + 1),
      },
    ]);
    // ON DELETE SET NULL leaves the vote live with no identity to notify.
    await t.raw
      .prepare(`UPDATE attestations SET attested_by_vendor_id = NULL WHERE source = 'vendor_b'`)
      .run();

    const findings = detectOpenConflict(await load(), NOW);
    expect(findings.map((f) => f.vendorId)).toEqual([ACME, null]);
  });
});

// ─── stale-version ───────────────────────────────────────────────────────────

describe('detectStaleVersion', () => {
  it('finds nothing when there is nothing to find', async () => {
    expect(detectStaleVersion([], NOW)).toEqual([]);
  });

  it('nudges the attesting vendor once a stampless attestation passes a year', async () => {
    await seedOwnership();
    await seedClaim([{ source: 'vendor_a', asserted: true, by: ACME, createdAt: monthsAgo(13) }]);

    const findings = detectStaleVersion(await load(), NOW);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ detector: 'stale-version', vendorId: ACME });
  });

  it('leaves an old attestation alone when it DOES carry version data', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: monthsAgo(13),
        introducedAt: '2024-01-01',
      },
    ]);
    expect(detectStaleVersion(await load(), NOW)).toEqual([]);
  });

  it('leaves a recent stampless attestation alone', async () => {
    await seedOwnership();
    await seedClaim([{ source: 'vendor_a', asserted: true, by: ACME, createdAt: monthsAgo(2) }]);
    expect(detectStaleVersion(await load(), NOW)).toEqual([]);
  });

  it('fires with no age threshold once the deprecated version has sunset', async () => {
    await seedOwnership();
    const versionId = u(40);
    await t.db.insert(productVersions).values({
      id: versionId,
      productId: PROCORE,
      label: '2025.1',
      sunsetAt: '2026-01-01',
      sortKey: 1,
    });
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(3),
        deprecatedVersionId: versionId,
      },
    ]);
    expect(detectStaleVersion(await load(), NOW)).toHaveLength(1);
  });

  it('does not chase a DENIAL of a flow that has ended', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: false,
        by: ACME,
        createdAt: daysAgo(3),
        deprecatedAt: '2020-01-01',
      },
    ]);
    expect(detectStaleVersion(await load(), NOW)).toEqual([]);
  });

  it('does not chase an aged, stampless DENIAL — the re-confirm copy assumes an affirmation', async () => {
    await seedOwnership();
    await seedClaim([{ source: 'vendor_a', asserted: false, by: ACME, createdAt: monthsAgo(13) }]);
    expect(detectStaleVersion(await load(), NOW)).toEqual([]);
  });

  it('yields ONE finding per vendor even when it holds two stale slots', async () => {
    await seedOwnership({ source: ACME, target: ACME });
    await seedClaim([
      { source: 'vendor_a', asserted: true, by: ACME, createdAt: monthsAgo(14) },
      { source: 'vendor_b', asserted: true, by: ACME, createdAt: monthsAgo(15) },
    ]);
    expect(detectStaleVersion(await load(), NOW)).toHaveLength(1);
  });
});

// ─── aeci-denied ─────────────────────────────────────────────────────────────

describe('detectAeciDenied', () => {
  it('finds nothing when there is nothing to find', async () => {
    expect(detectAeciDenied([])).toEqual([]);
  });

  it('raises ops when every vendor voter denies an AECi-seeded claim', async () => {
    await seedOwnership();
    await seedClaim([
      { source: 'aeci', asserted: true },
      { source: 'vendor_b', asserted: false, by: GLOBEX },
    ]);

    const findings = detectAeciDenied(await load());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      detector: 'aeci-denied',
      claimId: CLAIM,
      vendorId: null,
    });
  });

  it('ignores a denied claim the VENDOR created — that is a self-correction', async () => {
    await seedOwnership();
    await seedClaim([{ source: 'vendor_b', asserted: false, by: GLOBEX }], { origin: 'vendor' });
    expect(detectAeciDenied(await load())).toEqual([]);
  });

  it('ignores a claim with an affirmation, however one-sided', async () => {
    await seedOwnership();
    await seedClaim([{ source: 'vendor_a', asserted: true, by: ACME }]);
    expect(detectAeciDenied(await load())).toEqual([]);
  });
});

// ─── The registry ────────────────────────────────────────────────────────────

describe('runAttestationDetectors', () => {
  it('reports every detector, with zero findings, on a catalog nobody has attested', async () => {
    await seedOwnership();
    await seedClaim([{ source: 'aeci', asserted: true }]);

    const results = await runAttestationDetectors({ db: t.db, now: NOW });
    expect(results.map((r) => r.detector)).toEqual([
      'silent-counterparty',
      'open-conflict',
      'stale-version',
      'aeci-denied',
    ]);
    expect(results.every((r) => r.findings.length === 0 && !r.error)).toBe(true);
  });

  it('runs every detector over one shared read', async () => {
    await seedOwnership();
    await seedClaim([
      {
        source: 'vendor_a',
        asserted: true,
        by: ACME,
        createdAt: daysAgo(SILENT_COUNTERPARTY_DAYS + 2),
      },
    ]);

    const results = await runAttestationDetectors({ db: t.db, now: NOW });
    const byDetector = new Map(results.map((r) => [r.detector, r.findings.length]));
    expect(byDetector.get('silent-counterparty')).toBe(1);
    expect(byDetector.get('open-conflict')).toBe(0);
    expect(byDetector.get('aeci-denied')).toBe(0);
  });
});
