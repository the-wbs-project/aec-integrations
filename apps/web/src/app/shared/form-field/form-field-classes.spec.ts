import { describe, expect, it } from 'vitest';

import { CHOICE_CARD_CLASS, CHOICE_INPUT_CLASS, FIELD_ERROR_CLASS } from './form-field-classes';

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
    // A border-colour utility never applies: the unlayered `*` rule wins.
    expect(CHOICE_CARD_CLASS).not.toMatch(/\bborder-\(--/);
  });

  it('a choice input carries the class that outlines it when invalid', () => {
    expect(classes(CHOICE_INPUT_CLASS)).toContain('aec-choice-input');
  });
});
