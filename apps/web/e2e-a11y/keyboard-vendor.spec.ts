/**
 * AECI-1877: the keyboard checks for the manifest surfaces whose persona is `vendor`.
 * The checks are defined once in `support/keyboard-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.
 */
import { defineKeyboardSuite } from './support/keyboard-suite';

defineKeyboardSuite('Vendor portal', (surface) => surface.persona === 'vendor');
