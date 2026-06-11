/**
 * Hand-curated approved-review fixtures (AECI-199 / Phase 5.8). Shaped to the
 * `publicReviewSelect` row (no PII / moderation columns), used to exercise the
 * public reviews list and the `ProductDetail.reviews` embed.
 */

import type { RawPublicReviewRow } from '../../lib/prisma-helpers';

export const approvedReviewRow: RawPublicReviewRow = {
  id: '00000000-0000-4000-8000-000000060001',
  ratingOverall: 5,
  ratingOnboarding: 4,
  title: 'Rolled out across two studios',
  body: 'Onboarding took about a day. Stable since, and the field team actually uses it.',
  roleAtCompany: 'practitioner',
  yearsUsing: 3,
  wouldRecommend: 'yes',
  verifiedWorkEmail: true,
  createdAt: new Date('2024-06-10T00:00:00Z'),
};

export const approvedReviewRowMinimal: RawPublicReviewRow = {
  id: '00000000-0000-4000-8000-000000060002',
  ratingOverall: 3,
  ratingOnboarding: 2,
  title: 'Mixed bag',
  body: 'Core features are solid but the setup wizard fought us for a week before it clicked.',
  roleAtCompany: null,
  yearsUsing: null,
  wouldRecommend: null,
  verifiedWorkEmail: false,
  createdAt: new Date('2024-05-01T00:00:00Z'),
};

/** Two approved reviews, newest-first. */
export const approvedReviewRows: RawPublicReviewRow[] = [
  approvedReviewRow,
  approvedReviewRowMinimal,
];
