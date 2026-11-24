/**
 * AECI-1877: the keyboard checks for the manifest surfaces whose persona is `anonymous`.
 * The checks are defined once in `support/keyboard-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.
 */
import { defineKeyboardSuite } from './support/keyboard-suite';

defineKeyboardSuite('Public pages, signed out', (surface) => surface.persona === 'anonymous');
