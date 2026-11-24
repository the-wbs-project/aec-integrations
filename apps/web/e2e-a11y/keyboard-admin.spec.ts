/**
 * AECI-1877: the keyboard checks for the manifest surfaces whose persona is `admin`.
 * The checks are defined once in `support/keyboard-suite.ts`. `docs/TESTING_STRATEGY.md` §8.4.
 */
import { defineKeyboardSuite } from './support/keyboard-suite';

defineKeyboardSuite('Admin console', (surface) => surface.persona === 'admin');
