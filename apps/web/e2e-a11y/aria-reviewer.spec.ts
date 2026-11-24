/**
 * AECI-1879: the ARIA checks for the manifest surfaces whose persona is `reviewer`.
 * The checks are defined once in `support/aria-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.3.
 */
import { defineAriaSuite } from './support/aria-suite';

defineAriaSuite('Reviewer pages, signed in', (surface) => surface.persona === 'reviewer');
