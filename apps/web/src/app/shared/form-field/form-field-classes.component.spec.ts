import { describe, expect, it } from 'vitest';

import { SUSPENSION_INPUT } from '../../admin/vendors/vendor-suspension-model';
import { FIELD_ERROR_CLASS, FIELD_INPUT_CLASS } from './form-field-classes';

/**
 * The shared field recipe's class strings (AECI-1764). The CSS half, the unlayered
 * `.aec-field-control` and `.aec-field-error` rules, is read by
 * `src/field-recipe-css.guard.spec.ts`. The computed result is asserted by
 * `e2e/field-recipe.spec.ts`.
 */
describe('FIELD_INPUT_CLASS', () => {
  const tokens = FIELD_INPUT_CLASS.split(/\s+/);

  it('carries the unlayered control class and the control radius', () => {
    expect(tokens).toContain('aec-field-control');
    expect(tokens).toContain('rounded-control');
    expect(tokens).not.toContain('rounded-(--radius-md)');
  });

  it('has no shadow, no border colour utility and no opacity-based disabled look', () => {
    expect(tokens.some((t) => /(^|:)shadow/.test(t))).toBe(false);
    expect(tokens.some((t) => /^border-\(/.test(t))).toBe(false);
    expect(FIELD_INPUT_CLASS).not.toContain('opacity');
  });

  it('draws the 3px focus ring at a 3px offset', () => {
    expect(tokens).toContain('focus-visible:outline-3');
    expect(tokens).toContain('focus-visible:outline-offset-3');
  });

  it('is the one recipe the suspension inputs use', () => {
    expect(SUSPENSION_INPUT).toContain(FIELD_INPUT_CLASS);
  });
});

describe('FIELD_ERROR_CLASS', () => {
  it('is 14px at weight 600 in the error colour, with the icon rule and the icon gap', () => {
    expect(FIELD_ERROR_CLASS.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'aec-field-error',
        'flex',
        'gap-2',
        'text-t-14',
        'font-semibold',
        'text-(--status-error)',
      ]),
    );
  });
});
