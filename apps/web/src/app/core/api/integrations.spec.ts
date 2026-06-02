import { registerDetailFetcherSuite } from './detail-fetcher.harness';
import { fetchIntegrationById } from './integrations';

// Shared fetcher cases live in `detail-fetcher.harness.ts` (AECI-113).
registerDetailFetcherSuite({
  describeName: 'fetchIntegrationById',
  fetch: fetchIntegrationById,
  endpointBase: '/api/integrations',
  param: 'i1',
  paramKind: 'id',
  fixture: { id: 'i1', name: 'Revit → Navisworks' },
});
