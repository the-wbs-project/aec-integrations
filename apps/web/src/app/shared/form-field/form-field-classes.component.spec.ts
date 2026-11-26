import { describe, expect, it } from 'vitest';

import {
  CHOICE_CARD_CLASS,
  CHOICE_INPUT_CLASS,
  FIELD_ERROR_CLASS,
  FIELD_INPUT_CLASS,
  FIELD_LABEL_CLASS,
  FIELD_OPTIONAL_CLASS,
} from './form-field-classes';

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
});

describe('FIELD_LABEL_CLASS', () => {
  const tokens = FIELD_LABEL_CLASS.split(/\s+/);

  it('is the Label role: 13px at weight 600, tracking +0.01em (AECI-1850)', () => {
    expect(tokens).toEqual(
      expect.arrayContaining(['block', 'text-t-13', 'font-semibold', 'tracking-[0.01em]']),
    );
  });

  it('is sentence case, not the uppercase overline it used to be', () => {
    expect(tokens).not.toContain('uppercase');
    expect(tokens).not.toContain('text-xs');
    expect(tokens).not.toContain('font-bold');
    expect(tokens).not.toContain('tracking-[0.08em]');
  });

  it('leaves the "(optional)" marker nothing to undo', () => {
    expect(FIELD_OPTIONAL_CLASS).not.toContain('normal-case');
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

// Ported from main (AECI-1984, `form-field-classes.spec.ts`). This module imports the
// `aecButton` directive on the redesign branch, so the plain node runner cannot load it
// and the cases live in this `ng test` spec instead.
// The error look lives in unlayered classes in `styles.css`, keyed off
// `aria-invalid` (DESIGN.md "Inputs / Fields", Error; AECI-1984). axe cannot
// see a missing icon or a border that never turns red, so the recipe is
// pinned here as class assertions.
const classes = (recipe: string) => recipe.split(/\s+/);

describe('form-field error recipe', () => {
  it('a field error carries the alert icon class', () => {
    expect(classes(FIELD_ERROR_CLASS)).toContain('aec-field-error');
  });

  // main's AECI-1984 asserts `--text-primary` here. The redesign's ruled recipe (clash 23,
  // AECI-1764) sets the message in `--status-error`, 6.54:1 on white, so the intent (a
  // full-contrast message, never a dimmed one) is pinned against that token instead.
  it('the error text keeps a full-contrast token, not a dimmed one', () => {
    expect(classes(FIELD_ERROR_CLASS)).toContain('text-(--status-error)');
    expect(FIELD_ERROR_CLASS).not.toMatch(/text-\(--text-(secondary|tertiary)\)/);
  });

  it('a choice card draws its border through the unlayered class', () => {
    expect(classes(CHOICE_CARD_CLASS)).toContain('aec-choice-card');
    // A border-colour utility would lose to the unlayered class, so none is set.
    expect(CHOICE_CARD_CLASS).not.toMatch(/\bborder-\(--/);
  });

  it('a choice input carries the class that outlines it when invalid', () => {
    expect(classes(CHOICE_INPUT_CLASS)).toContain('aec-choice-input');
  });
});
