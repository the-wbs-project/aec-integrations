/**
 * The agreement-acceptance writer (AECI-1362, E2.4 of `docs/VENDOR_SIGNUP_PROCESS.md`
 * §4) on the in-memory D1 harness.
 *
 * The matrix: a current version returns the INSERT plus its `agreement.accepted` audit
 * row and never runs a batch itself; a stale or unknown version, document or source
 * throws `VALIDATION_FAILED` before any statement exists; a claim records IP and a
 * truncated user agent, a checkout records neither; a repeated Stripe session id fails
 * the second batch whole.
 */

import {
  AGREEMENT_CHECKBOX_LABELS,
  ApiErrorCode,
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_AGREEMENT_KNOWN_VERSIONS,
  LEGAL_POLICY_CURRENT_VERSIONS,
  PLANS_PAGE_CURRENT_VERSION,
  plansPageSha256,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  agreementAcceptances,
  auditLog,
  billingAccounts,
  listingRequests,
  profiles,
  vendorRequests,
  vendors,
} from '../db/schema';
import { ApiError } from '../errors';
import { makeTestDb, type TestDb } from '../test/d1';
import type { BatchTuple } from './audit';
import {
  AGREEMENT_ACCEPTANCE_ENTITY_TYPE,
  AGREEMENT_ACCEPTED_ACTION,
  AGREEMENT_LINKED_ACTION,
  USER_AGENT_MAX_LENGTH,
  acceptanceRequestEvidence,
  agreementAcceptanceStatements,
  loadCheckoutSigner,
  linkClaimAcceptanceStatements,
  listVendorAcceptances,
  loadClaimAcceptanceIds,
  truncateUserAgent,
  claimBoxFor,
  currentPolicyVersions,
  storedPolicyVersions,
  uncheckedBoxFor,
  type AgreementAcceptanceParams,
} from './agreement-acceptances';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const OTHER_VENDOR = u(2);
const ACCOUNT = u(10);
const NOW = '2026-10-15T09:00:00.000Z';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    { id: VENDOR, slug: 'procore', companyName: 'Procore' },
    { id: OTHER_VENDOR, slug: 'bentley', companyName: 'Bentley' },
  ]);
  await t.db.insert(billingAccounts).values({ id: ACCOUNT, vendorId: VENDOR, name: 'Procore' });
});
afterEach(() => t.dispose());

const claimHeaders = (ua = 'Mozilla/5.0 (Macintosh)') =>
  new Headers({ 'cf-connecting-ip': '203.0.113.7', 'user-agent': ua });

const claim = (over: Partial<AgreementAcceptanceParams> = {}): AgreementAcceptanceParams => ({
  document: 'vendor_terms',
  version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
  source: 'claim',
  email: 'ada@procore.com',
  vendorId: VENDOR,
  acceptedAt: NOW,
  requestHeaders: claimHeaders(),
  actorType: 'user',
  ...over,
});

const checkout = (over: Partial<AgreementAcceptanceParams> = {}): AgreementAcceptanceParams => ({
  document: 'managed_plan',
  version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
  source: 'checkout',
  email: 'billing@procore.com',
  vendorId: VENDOR,
  billingAccountId: ACCOUNT,
  stripeCheckoutSessionId: 'cs_test_123',
  acceptedAt: NOW,
  actorType: 'system',
  ...over,
});

function expectValidationFailed(fn: () => unknown, field: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect((error as ApiError).field).toBe(field);
    return;
  }
  throw new Error('expected VALIDATION_FAILED');
}

describe('agreementAcceptanceStatements', () => {
  it('returns the INSERT plus its audit row and never runs a batch itself', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    const out = agreementAcceptanceStatements(t.db, claim());
    expect(out.stmts).toHaveLength(2);
    expect(batchSpy).not.toHaveBeenCalled();
    expect(await t.db.select().from(agreementAcceptances)).toEqual([]);

    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({
      id: out.acceptanceId,
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
      source: 'claim',
      email: 'ada@procore.com',
      profileId: null,
      vendorId: VENDOR,
      billingAccountId: null,
      vendorRequestId: null,
      listingRequestId: null,
      stripeCheckoutSessionId: null,
      acceptedAt: NOW,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });

    const audits = await t.db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      id: out.auditEntry.id,
      action: AGREEMENT_ACCEPTED_ACTION,
      actorType: 'user',
      actorId: null,
      entityType: AGREEMENT_ACCEPTANCE_ENTITY_TYPE,
      entityId: out.acceptanceId,
      vendorId: VENDOR,
    });
  });

  it('keeps email, IP and user agent out of the forwarded audit entry', () => {
    const { auditEntry } = agreementAcceptanceStatements(t.db, claim());
    const serialized = JSON.stringify(auditEntry);
    expect(serialized).not.toContain('ada@procore.com');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('Mozilla');
    expect(auditEntry.afterState).toMatchObject({
      document: 'vendor_terms',
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms,
    });
  });

  it('stores the signer on the row and keeps it out of the forwarded audit entry (AECI-1617)', async () => {
    const { stmts, auditEntry } = agreementAcceptanceStatements(
      t.db,
      claim({
        signer: { name: 'Ada Lane', title: 'VP Product', companyLegalName: 'Procore, Inc.' },
      }),
    );
    await t.db.batch(stmts as never);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({
      signerName: 'Ada Lane',
      signerTitle: 'VP Product',
      companyLegalName: 'Procore, Inc.',
    });
    const serialized = JSON.stringify(auditEntry);
    expect(serialized).not.toContain('Ada Lane');
    expect(serialized).not.toContain('VP Product');
    expect(serialized).not.toContain('Procore, Inc.');
  });

  it('leaves the signer columns NULL when none is passed, as a checkout does (AECI-1617)', async () => {
    const { stmts } = agreementAcceptanceStatements(t.db, claim());
    await t.db.batch(stmts as never);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ signerName: null, signerTitle: null, companyLegalName: null });
  });

  describe('the checkbox shown (AECI-1615 ruling 16)', () => {
    it("stores the label's hash and that the box started unticked", async () => {
      const { stmts } = agreementAcceptanceStatements(
        t.db,
        claim({ checkbox: uncheckedBoxFor('vendor_terms') }),
      );
      await t.db.batch(stmts as never);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({
        checkboxLabelSha256: AGREEMENT_CHECKBOX_LABELS.vendor_terms.sha256,
        checkboxDefaultUnticked: true,
        // AECI-1619: the label text itself, beside its hash.
        checkboxLabel: AGREEMENT_CHECKBOX_LABELS.vendor_terms.text,
      });
    });

    it('leaves all three NULL when no box is passed, as a signed deal does', async () => {
      const { stmts } = agreementAcceptanceStatements(t.db, claim());
      await t.db.batch(stmts as never);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({
        checkboxLabelSha256: null,
        checkboxDefaultUnticked: null,
        checkboxLabel: null,
      });
    });

    // AECI-1619: the label text on each source that shows a box.
    it('stores the Managed plan label text on a checkout and on a portal grant accept', async () => {
      const box = uncheckedBoxFor('managed_plan');
      await t.db.batch(
        agreementAcceptanceStatements(t.db, checkout({ checkbox: box })).stmts as BatchTuple,
      );
      await t.db.batch(
        agreementAcceptanceStatements(
          t.db,
          checkout({
            source: 'grant',
            stripeCheckoutSessionId: null,
            version: '1.0',
            checkbox: box,
            grant: {
              licenseGrantId: 'g-label',
              grantEndsAt: '2027-06-30T00:00:00.000Z',
              pinnedVersion: '1.0',
              method: 'portal_checkbox',
              textSha256: null,
              seatRole: 'owner',
            },
          }),
        ).stmts as BatchTuple,
      );
      const rows = await t.db.select().from(agreementAcceptances);
      expect(rows.map((r) => [r.source, r.checkboxLabel]).sort()).toEqual([
        ['checkout', AGREEMENT_CHECKBOX_LABELS.managed_plan.text],
        ['grant', AGREEMENT_CHECKBOX_LABELS.managed_plan.text],
      ]);
      // The label stays out of the forwarded audit entry: the hash names it.
      const { auditEntry } = agreementAcceptanceStatements(
        t.db,
        checkout({ stripeCheckoutSessionId: 'cs_audit', checkbox: box }),
      );
      expect(JSON.stringify(auditEntry)).not.toContain(AGREEMENT_CHECKBOX_LABELS.managed_plan.text);
    });

    it('claimBoxFor knows only the current vendor terms label', () => {
      expect(claimBoxFor(LEGAL_AGREEMENT_CURRENT_VERSIONS.vendor_terms)).toEqual(
        uncheckedBoxFor('vendor_terms'),
      );
      // A confirm carrying an older submit's version may have shown an older label.
      expect(claimBoxFor('1.0')).toBeNull();
    });

    it("uncheckedBoxFor names each document's own label", () => {
      expect(uncheckedBoxFor('managed_plan')).toEqual({
        labelText: AGREEMENT_CHECKBOX_LABELS.managed_plan.text,
        labelSha256: AGREEMENT_CHECKBOX_LABELS.managed_plan.sha256,
        defaultUnticked: true,
      });
      expect(uncheckedBoxFor('vendor_terms').labelSha256).not.toBe(
        uncheckedBoxFor('managed_plan').labelSha256,
      );
    });
  });

  describe('loadCheckoutSigner (AECI-1617)', () => {
    const SEAT = '00000000-0000-4000-8000-00000000a001';
    const OTHER = '00000000-0000-4000-8000-00000000a002';
    const seedClaim = async (
      profileId: string,
      acceptedAt: string,
      signer: { name: string; title: string; companyLegalName: string | null },
    ) => {
      const { stmts } = agreementAcceptanceStatements(
        t.db,
        claim({ profileId, vendorId: VENDOR, acceptedAt, signer }),
      );
      await t.db.batch(stmts as never);
    };

    it("takes the seat's own title and the newest legal name, and prefers the profile's name", async () => {
      await t.db.insert(profiles).values({ id: SEAT, displayName: 'Ada L.' });
      await seedClaim(SEAT, '2026-11-01T00:00:00.000Z', {
        name: 'Ada Lane',
        title: 'VP Product',
        companyLegalName: 'Procore, Inc.',
      });
      await seedClaim(OTHER, '2026-11-02T00:00:00.000Z', {
        name: 'Bo Ray',
        title: 'CEO',
        companyLegalName: 'Procore Technologies, Inc.',
      });
      expect(await loadCheckoutSigner(t.db, SEAT, VENDOR)).toEqual({
        name: 'Ada L.',
        title: 'VP Product',
        companyLegalName: 'Procore Technologies, Inc.',
      });
    });

    it('an invited seat has no title, and still gets the legal name', async () => {
      await t.db.insert(profiles).values({ id: SEAT, displayName: 'Ada L.' });
      await seedClaim(OTHER, '2026-11-02T00:00:00.000Z', {
        name: 'Bo Ray',
        title: 'CEO',
        companyLegalName: 'Procore, Inc.',
      });
      expect(await loadCheckoutSigner(t.db, SEAT, VENDOR)).toEqual({
        name: 'Ada L.',
        title: null,
        companyLegalName: 'Procore, Inc.',
      });
    });

    it('a vendor with no claim on record gives nothing, never company_name or the account name', async () => {
      // The fixture's vendor is "Procore" and its billing account is named "Procore".
      // Neither is a legal name (AECI-1625).
      await t.db.insert(profiles).values({ id: SEAT });
      expect(await loadCheckoutSigner(t.db, SEAT, VENDOR)).toEqual({
        name: null,
        title: null,
        companyLegalName: null,
      });
    });

    it('reads vendors.legal_name before any claim (AECI-1625)', async () => {
      await t.db.insert(profiles).values({ id: SEAT });
      await t.db
        .update(vendors)
        .set({ legalName: 'Procore Technologies, Inc.' })
        .where(eq(vendors.id, VENDOR));
      await seedClaim(OTHER, '2026-11-02T00:00:00.000Z', {
        name: 'Bo Ray',
        title: 'CEO',
        companyLegalName: 'Procore Inc',
      });
      expect((await loadCheckoutSigner(t.db, SEAT, VENDOR)).companyLegalName).toBe(
        'Procore Technologies, Inc.',
      );
    });

    it('a vendor whose only claims predate AECI-1617 still gets its stored legal name', async () => {
      await t.db.insert(profiles).values({ id: SEAT });
      await t.db.update(vendors).set({ legalName: 'Procore, Inc.' }).where(eq(vendors.id, VENDOR));
      expect((await loadCheckoutSigner(t.db, SEAT, VENDOR)).companyLegalName).toBe('Procore, Inc.');
    });

    it("the typed title wins over the seat's claim title, and gives an invited seat one", async () => {
      await t.db.insert(profiles).values({ id: SEAT, displayName: 'Ada L.' });
      await seedClaim(SEAT, '2026-11-01T00:00:00.000Z', {
        name: 'Ada Lane',
        title: 'VP Product',
        companyLegalName: null,
      });
      expect((await loadCheckoutSigner(t.db, SEAT, VENDOR, '  COO  ')).title).toBe('COO');
      expect((await loadCheckoutSigner(t.db, OTHER, VENDOR, 'Head of Sales')).title).toBe(
        'Head of Sales',
      );
      expect((await loadCheckoutSigner(t.db, SEAT, VENDOR, '   ')).title).toBe('VP Product');
    });
  });

  it.each([
    ['a stale version', { version: '1.0' }, 'version'],
    ['an unknown version', { version: '2.0' }, 'version'],
    ['a blank version', { version: '' }, 'version'],
    ['an unknown document', { document: 'privacy_policy' }, 'document'],
    ['an unknown source', { source: 'email' }, 'source'],
    ['a blank email', { email: '   ' }, 'email'],
    ['an unparseable time', { acceptedAt: 'yesterday' }, 'accepted_at'],
  ] as const)('refuses %s with VALIDATION_FAILED', (_label, over, field) => {
    expectValidationFailed(() => agreementAcceptanceStatements(t.db, claim(over)), field);
  });

  it('checks the version against the document it names', () => {
    // Both are '1.1' today. A bump to one must not let the other's version through.
    expect(() => agreementAcceptanceStatements(t.db, checkout())).not.toThrow();
    expectValidationFailed(
      () => agreementAcceptanceStatements(t.db, checkout({ version: '1.0' })),
      'version',
    );
    expectValidationFailed(
      () => agreementAcceptanceStatements(t.db, checkout({ version: '1.2' })),
      'version',
    );
  });

  // AECI-1500, ruling R1: the checkout webhook records the version the Checkout page showed.
  describe('allowSupersededVersion', () => {
    const known = LEGAL_AGREEMENT_KNOWN_VERSIONS.managed_plan as unknown as string[];
    const current = LEGAL_AGREEMENT_CURRENT_VERSIONS as unknown as Record<string, string>;
    beforeEach(() => {
      // Simulate a bump to 1.1 after the vendor accepted 1.0.
      known.push('1.1');
      current.managed_plan = '1.1';
    });
    afterEach(() => {
      known.pop();
      current.managed_plan = '1.0';
    });

    it('records a superseded but published version on a checkout', async () => {
      expectValidationFailed(
        () => agreementAcceptanceStatements(t.db, checkout({ version: '1.0' })),
        'version',
      );
      const out = agreementAcceptanceStatements(
        t.db,
        checkout({ version: '1.0', allowSupersededVersion: true }),
      );
      await t.db.batch(out.stmts as BatchTuple);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({ version: '1.0', source: 'checkout' });
    });

    it('still refuses a version that was never published', () => {
      expectValidationFailed(
        () =>
          agreementAcceptanceStatements(
            t.db,
            checkout({ version: '0.9', allowSupersededVersion: true }),
          ),
        'version',
      );
    });

    it('is refused on any source but checkout', () => {
      expectValidationFailed(
        () =>
          agreementAcceptanceStatements(
            t.db,
            claim({
              document: 'managed_plan',
              version: '1.0',
              allowSupersededVersion: true,
            }),
          ),
        'source',
      );
    });
  });

  // AECI-1615: the grant source.
  describe('policy versions (AECI-1619, counsel Q14)', () => {
    it('stores the policy versions on a claim and names them in the audit entry', async () => {
      const out = agreementAcceptanceStatements(
        t.db,
        claim({ policyVersions: currentPolicyVersions() }),
      );
      await t.db.batch(out.stmts as BatchTuple);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({
        listingAccuracyVersion: LEGAL_POLICY_CURRENT_VERSIONS.listing_accuracy,
        reviewGuidelinesVersion: LEGAL_POLICY_CURRENT_VERSIONS.review_guidelines,
        plansPageVersion: null,
        plansPageSha256: null,
      });
      expect(out.auditEntry.afterState).toMatchObject({
        listing_accuracy_version: LEGAL_POLICY_CURRENT_VERSIONS.listing_accuracy,
        review_guidelines_version: LEGAL_POLICY_CURRENT_VERSIONS.review_guidelines,
        plans_page_version: null,
      });
    });

    it('writes NULL when none is passed, as a legacy pending claim does', async () => {
      const { stmts } = agreementAcceptanceStatements(t.db, claim({ policyVersions: null }));
      await t.db.batch(stmts as never);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({ listingAccuracyVersion: null, reviewGuidelinesVersion: null });
    });

    it('is refused on any source but claim', () => {
      expectValidationFailed(
        () =>
          agreementAcceptanceStatements(
            t.db,
            checkout({ policyVersions: currentPolicyVersions() }),
          ),
        'policy_versions',
      );
    });

    it('refuses a version that was never published', () => {
      expectValidationFailed(
        () =>
          agreementAcceptanceStatements(
            t.db,
            claim({ policyVersions: { listingAccuracy: '9.9', reviewGuidelines: '1.0' } }),
          ),
        'listing_accuracy_version',
      );
      expectValidationFailed(
        () =>
          agreementAcceptanceStatements(
            t.db,
            claim({ policyVersions: { listingAccuracy: '1.0', reviewGuidelines: '9.9' } }),
          ),
        'review_guidelines_version',
      );
    });

    it('storedPolicyVersions reads a pending row, and gives null for a legacy one', () => {
      expect(
        storedPolicyVersions({ listingAccuracyVersion: '1.0', reviewGuidelinesVersion: '1.0' }),
      ).toEqual({ listingAccuracy: '1.0', reviewGuidelines: '1.0' });
      expect(
        storedPolicyVersions({ listingAccuracyVersion: null, reviewGuidelinesVersion: null }),
      ).toBeNull();
    });
  });

  describe('the Plans page version (AECI-1619, ruling 16)', () => {
    it('stores the version and stamps its snapshot hash on a checkout', async () => {
      const out = agreementAcceptanceStatements(
        t.db,
        checkout({ plansVersion: PLANS_PAGE_CURRENT_VERSION }),
      );
      await t.db.batch(out.stmts as BatchTuple);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({
        plansPageVersion: PLANS_PAGE_CURRENT_VERSION,
        plansPageSha256: plansPageSha256(PLANS_PAGE_CURRENT_VERSION),
        listingAccuracyVersion: null,
        reviewGuidelinesVersion: null,
      });
      expect(row!.plansPageSha256).not.toBeNull();
      expect(out.auditEntry.afterState).toMatchObject({
        plans_page_version: PLANS_PAGE_CURRENT_VERSION,
      });
    });

    it('writes NULL to both when none is passed, as a legacy checkout session does', async () => {
      const { stmts } = agreementAcceptanceStatements(t.db, checkout());
      await t.db.batch(stmts as never);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({ plansPageVersion: null, plansPageSha256: null });
    });

    it('is refused on a claim', () => {
      expectValidationFailed(
        () =>
          agreementAcceptanceStatements(t.db, claim({ plansVersion: PLANS_PAGE_CURRENT_VERSION })),
        'plans_version',
      );
    });

    it('refuses a version that was never published', () => {
      expectValidationFailed(
        () => agreementAcceptanceStatements(t.db, checkout({ plansVersion: '9.9' })),
        'plans_version',
      );
    });
  });

  describe('a grant acceptance', () => {
    const grantFields = (over: Record<string, unknown> = {}) => ({
      licenseGrantId: 'g-1',
      grantEndsAt: '2027-06-30T00:00:00.000Z',
      pinnedVersion: '1.0',
      method: 'portal_checkbox' as const,
      textSha256: 'abc',
      seatRole: 'owner',
      ...over,
    });
    const grantAcceptance = (over: Partial<AgreementAcceptanceParams> = {}) =>
      checkout({
        source: 'grant',
        stripeCheckoutSessionId: null,
        version: '1.0',
        requestHeaders: claimHeaders(),
        grant: grantFields(),
        ...over,
      });

    it('records the pinned version even when superseded, with IP, user agent and the grant columns', async () => {
      const out = agreementAcceptanceStatements(t.db, grantAcceptance());
      await t.db.batch(out.stmts as BatchTuple);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({
        source: 'grant',
        version: '1.0',
        method: 'portal_checkbox',
        licenseGrantId: 'g-1',
        grantEndsAt: '2027-06-30T00:00:00.000Z',
        textSha256: 'abc',
        seatRole: 'owner',
        ip: '203.0.113.7',
        userAgent: 'Mozilla/5.0 (Macintosh)',
      });
      expect(out.auditEntry.afterState).toMatchObject({ license_grant_id: 'g-1' });
      expect(JSON.stringify(out.auditEntry)).not.toContain('203.0.113.7');
    });

    it('stores the Plans version and hash on a grant (AECI-1619)', async () => {
      const out = agreementAcceptanceStatements(
        t.db,
        grantAcceptance({ plansVersion: PLANS_PAGE_CURRENT_VERSION }),
      );
      await t.db.batch(out.stmts as BatchTuple);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({
        plansPageVersion: PLANS_PAGE_CURRENT_VERSION,
        plansPageSha256: plansPageSha256(PLANS_PAGE_CURRENT_VERSION),
      });
    });

    it('refuses a version other than the pinned one', () => {
      expectValidationFailed(
        () => agreementAcceptanceStatements(t.db, grantAcceptance({ version: '1.1' })),
        'version',
      );
    });

    it('stores no IP or user agent on a signed deal', async () => {
      const out = agreementAcceptanceStatements(
        t.db,
        grantAcceptance({
          grant: grantFields({ method: 'signed_deal', seatRole: null, dealReference: 'MSA-1' }),
        }),
      );
      await t.db.batch(out.stmts as BatchTuple);
      const [row] = await t.db.select().from(agreementAcceptances);
      expect(row).toMatchObject({ ip: null, userAgent: null, dealReference: 'MSA-1' });
    });

    it('refuses grant fields on another source, and a grant source without them', () => {
      expectValidationFailed(
        () => agreementAcceptanceStatements(t.db, checkout({ grant: grantFields() })),
        'source',
      );
      expectValidationFailed(
        () => agreementAcceptanceStatements(t.db, grantAcceptance({ grant: null })),
        'source',
      );
    });
  });

  it('stores no IP or user agent on a checkout, even when headers are passed', async () => {
    const out = agreementAcceptanceStatements(
      t.db,
      checkout({ requestHeaders: claimHeaders('Stripe/1.0') }),
    );
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ ip: null, userAgent: null, billingAccountId: ACCOUNT });
  });

  it('allows the request context to be absent', async () => {
    const out = agreementAcceptanceStatements(t.db, claim({ requestHeaders: undefined }));
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ ip: null, userAgent: null });
  });

  it('truncates a long user agent to 512 characters', async () => {
    const out = agreementAcceptanceStatements(
      t.db,
      claim({ requestHeaders: claimHeaders('x'.repeat(2000)) }),
    );
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row!.userAgent).toHaveLength(USER_AGENT_MAX_LENGTH);
  });

  it('fails the whole batch on a repeated Stripe session id rather than writing twice', async () => {
    const first = agreementAcceptanceStatements(t.db, checkout());
    await t.db.batch(first.stmts as BatchTuple);
    const replay = agreementAcceptanceStatements(t.db, checkout());
    await expect(t.db.batch(replay.stmts as BatchTuple)).rejects.toThrow(/UNIQUE/);

    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(1);
    // The replay's audit row rolled back with it.
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.entityId, replay.acceptanceId)),
    ).toEqual([]);
  });

  // AECI-1366: the typed-in listing path has no claim row to name.
  it('records an acceptance against a listing request, and the audit row names it', async () => {
    const LISTING = u(40);
    await t.db.insert(listingRequests).values({
      id: LISTING,
      listingName: 'Site Diary Pro',
      website: 'https://sitediary.example.com',
      submitterEmail: 'pat@sitediary.example.com',
    });
    const out = agreementAcceptanceStatements(
      t.db,
      claim({ vendorId: null, listingRequestId: LISTING }),
    );
    await t.db.batch(out.stmts as BatchTuple);
    const [row] = await t.db.select().from(agreementAcceptances);
    expect(row).toMatchObject({ listingRequestId: LISTING, vendorRequestId: null });
    expect(out.auditEntry.afterState).toMatchObject({ listing_request_id: LISTING });

    // ON DELETE SET NULL: deleting the request leaves the evidence standing.
    await t.db.delete(listingRequests).where(eq(listingRequests.id, LISTING));
    const [after] = await t.db.select().from(agreementAcceptances);
    expect(after).toMatchObject({ id: out.acceptanceId, listingRequestId: null });
  });

  it('lets many acceptances carry no Stripe session id', async () => {
    for (let i = 0; i < 2; i++) {
      const out = agreementAcceptanceStatements(t.db, claim());
      await t.db.batch(out.stmts as BatchTuple);
    }
    expect(await t.db.select().from(agreementAcceptances)).toHaveLength(2);
  });
});

describe('listVendorAcceptances', () => {
  it('finds rows by vendor id or by the vendor’s billing account, newest first', async () => {
    const byVendor = agreementAcceptanceStatements(
      t.db,
      claim({ acceptedAt: '2026-10-01T00:00:00.000Z' }),
    );
    const byAccountOnly = agreementAcceptanceStatements(t.db, checkout({ vendorId: null }));
    const foreign = agreementAcceptanceStatements(t.db, claim({ vendorId: OTHER_VENDOR }));
    await t.db.batch([...byVendor.stmts, ...byAccountOnly.stmts, ...foreign.stmts] as BatchTuple);

    const rows = await listVendorAcceptances(t.db, VENDOR);
    expect(rows.map((r) => r.id)).toEqual([byAccountOnly.acceptanceId, byVendor.acceptanceId]);
    expect((await listVendorAcceptances(t.db, OTHER_VENDOR)).map((r) => r.id)).toEqual([
      foreign.acceptanceId,
    ]);
  });
});

describe('request evidence helpers', () => {
  it('reads CF-Connecting-IP and the user agent', () => {
    expect(acceptanceRequestEvidence(claimHeaders())).toEqual({
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });
    expect(acceptanceRequestEvidence(null)).toEqual({ ip: null, userAgent: null });
    expect(acceptanceRequestEvidence(new Headers())).toEqual({ ip: null, userAgent: null });
  });

  it('maps a blank user agent to null', () => {
    expect(truncateUserAgent('   ')).toBeNull();
    expect(truncateUserAgent(undefined)).toBeNull();
    expect(truncateUserAgent(' curl/8 ')).toBe('curl/8');
  });
});

// ─── AECI-1367: the approval links the claim's acceptances ───────────────────

describe('linkClaimAcceptanceStatements', () => {
  const CLAIM = u(20);
  const OTHER_CLAIM = u(21);
  const SEAT = u(30);
  const ADMIN = u(31);

  beforeEach(async () => {
    // `audit_log.actor_id` references `profiles`.
    await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
    await t.db.insert(vendorRequests).values(
      [CLAIM, OTHER_CLAIM].map((id) => ({
        id,
        kind: 'claim',
        status: 'open',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'ada@procore.com',
        body: 'We build this.',
      })),
    );
  });

  const linkArgs = (acceptanceIds: readonly string[]) => ({
    vendorRequestId: CLAIM,
    acceptanceIds,
    profileId: SEAT,
    vendorId: VENDOR,
    billingAccountId: ACCOUNT,
    actorId: ADMIN,
    actorType: 'admin' as const,
    vendorPlan: { tier: 'none', status: 'none' as const },
    source: 'admin-moderation',
  });

  /** A claim-time acceptance: the email and the claim, nothing else. */
  async function acceptOn(vendorRequestId: string): Promise<string> {
    const batch = agreementAcceptanceStatements(t.db, claim({ vendorId: null, vendorRequestId }));
    await t.db.batch(batch.stmts as BatchTuple);
    return batch.acceptanceId;
  }

  it('loads the claim’s acceptance ids and nothing else', async () => {
    const mine = await acceptOn(CLAIM);
    await acceptOn(OTHER_CLAIM);
    expect(await loadClaimAcceptanceIds(t.db, CLAIM)).toEqual([mine]);
    expect(await loadClaimAcceptanceIds(t.db, u(99))).toEqual([]);
  });

  it('is a no-op with no statement and no audit row when the claim has no acceptances', () => {
    const link = linkClaimAcceptanceStatements(t.db, linkArgs([]));
    expect(link.stmts).toEqual([]);
    expect(link.auditEntry).toBeNull();
  });

  it('fills profile, vendor and billing account on this claim’s rows only, with one audit row', async () => {
    const mine = await acceptOn(CLAIM);
    const theirs = await acceptOn(OTHER_CLAIM);

    const link = linkClaimAcceptanceStatements(t.db, linkArgs([mine]));
    expect(link.stmts).toHaveLength(2);
    await t.db.batch(link.stmts as BatchTuple);

    const rows = await t.db.select().from(agreementAcceptances);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(mine)).toMatchObject({
      profileId: SEAT,
      vendorId: VENDOR,
      billingAccountId: ACCOUNT,
      // The evidence is untouched.
      email: 'ada@procore.com',
      ip: '203.0.113.7',
    });
    expect(byId.get(theirs)).toMatchObject({
      profileId: null,
      vendorId: null,
      billingAccountId: null,
    });

    const audits = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, AGREEMENT_LINKED_ACTION));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'vendor_request',
      entityId: CLAIM,
      vendorId: VENDOR,
    });
    expect(link.auditEntry!.afterState).toMatchObject({
      acceptance_ids: [mine],
      profile_id: SEAT,
      billing_account_id: ACCOUNT,
    });
  });
});
