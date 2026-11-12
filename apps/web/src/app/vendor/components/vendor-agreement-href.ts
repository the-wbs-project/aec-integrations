import { LEGAL_AGREEMENT_CURRENT_VERSIONS, isKnownPlansPageVersion } from '@aeci/shared';

import { plansArchivePath } from '../../docs/plans-versions';
import {
  LEGAL_ARCHIVES,
  legalArchivePath,
  legalPath,
  type LegalSlug,
} from '../../legal/legal-manifest';

/** `agreement_acceptances.document` to its public `/legal/*` slug. */
const DOCUMENT_SLUG: Readonly<Record<string, LegalSlug>> = {
  vendor_terms: 'vendor-terms',
  managed_plan: 'managed-plan-agreement',
};

/**
 * Where one version of an agreement can be read. The current version lives at
 * `/legal/<slug>`; a superseded one at `/legal/<slug>/v<version>` only once it is
 * archived (`legal-manifest.ts`). Anything else has no page, so no link.
 *
 * The Billing tab's acceptances table links each accepted version through this, and
 * the pending-grant card (AECI-1615) links the version a grant pins.
 */
export function acceptanceHref(document: string, version: string): string | null {
  const slug = DOCUMENT_SLUG[document];
  if (!slug) return null;
  const current = (LEGAL_AGREEMENT_CURRENT_VERSIONS as Readonly<Record<string, string>>)[document];
  if (current === version) return legalPath(slug);
  return LEGAL_ARCHIVES.some((a) => a.slug === slug && a.version === version)
    ? legalArchivePath(slug, version)
    : null;
}

/**
 * Where one recorded version of the Plans page can be read (AECI-1619): its snapshot
 * page, `/docs/vendors/plans/v<version>`, for any known version, the current one
 * included. `null` for a NULL column (a row older than the column, or a claim) or a
 * version this build has no snapshot for.
 *
 * The owner's and the operator's Billing acceptance tables link a checkout or grant
 * row's `plans_page_version` through this.
 */
export function plansSnapshotHref(version: string | null): string | null {
  if (version === null || !isKnownPlansPageVersion(version)) return null;
  return plansArchivePath(version);
}
