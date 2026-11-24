/**
 * AECI-1879: the ARIA checks for the manifest surfaces whose persona is `anonymous`.
 * The checks are defined once in `support/aria-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.3.
 */
import { defineAriaSuite } from './support/aria-suite';

defineAriaSuite('Public pages, signed out', (surface) => surface.persona === 'anonymous');
