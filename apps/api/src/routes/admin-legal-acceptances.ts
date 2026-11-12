/**
 * `GET /api/admin/legal-acceptances` (AECI-1677; `ADMIN_PANEL_SPEC.md` §5.22a,
 * `API_CONTRACTS.md` §6.10 "Legal acceptances"): for every FINAL version of each agreement
 * (in force, dated in code, or published), how many companies have accepted it and which
 * have not. The effective-date change reads it to list who the acceptance screen will
 * block (ruling 24).
 *
 * `requireAdmin()` only. A read, so never rate-limited, no audit row.
 *
 * ── WHO IS COUNTED ──────────────────────────────────────────────────────────────
 * Vendor Terms: every vendor with at least one seat (`claimed`), suspended ones included.
 * Managed plan agreement: the vendors holding a live monthly card subscription
 * (`monthly_card`), the only companies the screen asks (counsel Q3). A company counts as
 * accepted when it holds an acceptance of a final version at or after this one, the rule
 * the screen uses (`acceptanceCovers` in `lib/legal-acceptance.ts`). An acceptance of a
 * draft never counts. Draft versions are not listed, so the list is empty while no
 * version is final, which is today.
 */

import {
  AdminLegalAcceptancesResponseSchema,
  LEGAL_AGREEMENT_DOCUMENTS,
  type AdminLegalAcceptanceCompany,
  type AdminLegalAcceptanceVersion,
  type AdminLegalAcceptancesResponse,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { and, eq, exists, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { agreementAcceptances, billingAccounts, licenses, profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import { json } from '../http';
import type { AuthzVariables } from '../lib/authz';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import {
  acceptanceCovers,
  finalVersions,
  liveMonthlyCardWhere,
  publishedVersionsSelect,
  type AcceptedVersionLite,
} from '../lib/legal-acceptance';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

export function createAdminLegalAcceptancesHandler(
  dbFor: DbFactory = getDb,
  now: () => Date = () => new Date(),
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const nowMs = now().getTime();
    const [published, claimed, accepted, monthly] = await db.batch([
      publishedVersionsSelect(db),
      db
        .select({ id: vendors.id, slug: vendors.slug, companyName: vendors.companyName })
        .from(vendors)
        .where(
          exists(
            db
              .select({ one: sql`1` })
              .from(profiles)
              .where(and(eq(profiles.vendorId, vendors.id), eq(profiles.role, VENDOR_ADMIN_ROLE))),
          ),
        ),
      // An acceptance names its vendor, or only a billing account of it (a checkout row
      // written before the vendor id was known): `acceptancesOfVendor`, for every vendor.
      db
        .select({
          vendorId: sql<
            string | null
          >`coalesce(${agreementAcceptances.vendorId}, ${billingAccounts.vendorId})`,
          document: agreementAcceptances.document,
          version: agreementAcceptances.version,
        })
        .from(agreementAcceptances)
        .leftJoin(billingAccounts, eq(billingAccounts.id, agreementAcceptances.billingAccountId)),
      db
        .selectDistinct({ vendorId: billingAccounts.vendorId })
        .from(licenses)
        .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
        .where(liveMonthlyCardWhere()),
    ]);

    const byVendor = new Map<string, AcceptedVersionLite[]>();
    for (const row of accepted) {
      if (!row.vendorId) continue;
      const list = byVendor.get(row.vendorId) ?? [];
      list.push({ document: row.document, version: row.version });
      byVendor.set(row.vendorId, list);
    }
    const monthlyIds = new Set(monthly.map((r) => r.vendorId));
    const company = (v: (typeof claimed)[number]): AdminLegalAcceptanceCompany => ({
      vendor_id: v.id,
      slug: v.slug,
      company_name: v.companyName,
    });
    const byName = (a: AdminLegalAcceptanceCompany, b: AdminLegalAcceptanceCompany) =>
      compareText(a.company_name, b.company_name) || compareText(a.vendor_id, b.vendor_id);

    const versions: AdminLegalAcceptanceVersion[] = [];
    for (const document of LEGAL_AGREEMENT_DOCUMENTS) {
      const audience = document === 'vendor_terms' ? 'claimed' : 'monthly_card';
      const companies =
        audience === 'claimed' ? claimed : claimed.filter((v) => monthlyIds.has(v.id));
      for (const final of finalVersions(document, published)) {
        const row = published.find((r) => r.document === document && r.version === final.version);
        const notYet = companies
          .filter(
            (v) => !acceptanceCovers(document, final.version, byVendor.get(v.id) ?? [], published),
          )
          .map(company)
          .sort(byName);
        versions.push({
          document,
          version: final.version,
          effective_at: new Date(final.effectiveAt).toISOString(),
          in_force: final.effectiveAt <= nowMs,
          published: row !== undefined,
          requires_acceptance: row ? row.requiresAcceptance : null,
          audience,
          accepted_count: companies.length - notYet.length,
          not_yet_count: notYet.length,
          not_yet: notYet,
        });
      }
    }

    const body: AdminLegalAcceptancesResponse = { versions };
    validateResponseInDev(c.env, () => AdminLegalAcceptancesResponseSchema.parse(body));
    return json(body);
  };
}
