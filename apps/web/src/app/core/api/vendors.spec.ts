import { registerDetailFetcherSuite } from './detail-fetcher.harness';
import { fetchVendorBySlug } from './vendors';

// Shared fetcher cases live in `detail-fetcher.harness.ts` (AECI-113).
registerDetailFetcherSuite({
  describeName: 'fetchVendorBySlug',
  fetch: fetchVendorBySlug,
  endpointBase: '/api/vendors',
  param: 'procore',
  paramKind: 'slug',
  fixture: { id: 'v1', slug: 'procore', company_name: 'Procore Technologies' },
});
