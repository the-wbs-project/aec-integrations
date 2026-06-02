import { registerDetailFetcherSuite } from './detail-fetcher.harness';
import { fetchProductBySlug } from './products';

// Shared fetcher cases live in `detail-fetcher.harness.ts` (AECI-113).
registerDetailFetcherSuite({
  describeName: 'fetchProductBySlug',
  fetch: fetchProductBySlug,
  endpointBase: '/api/products',
  param: 'procore',
  paramKind: 'slug',
  fixture: { id: 'p1', slug: 'procore', name: 'Procore' },
});
