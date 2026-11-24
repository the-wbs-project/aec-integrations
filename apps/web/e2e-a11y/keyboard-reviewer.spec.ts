/**
 * AECI-1877: the keyboard checks for the manifest surfaces whose persona is `reviewer`.
 * The checks are defined once in `support/keyboard-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.
 */
import { defineKeyboardSuite } from './support/keyboard-suite';

defineKeyboardSuite('Reviewer pages, signed in', (surface) => surface.persona === 'reviewer');
