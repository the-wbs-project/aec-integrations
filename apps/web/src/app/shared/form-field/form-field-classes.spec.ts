import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SUSPENSION_INPUT } from '../../admin/vendors/vendor-suspension-model';
import { FIELD_ERROR_CLASS, FIELD_INPUT_CLASS } from './form-field-classes';

/**
 * The shared field recipe (AECI-1764). The edge, radius, height and error look
 * live in the unlayered `.aec-field-control` and `.aec-field-error` rules, so
 * these checks read `styles.css` as well as the class strings.
 */
const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../styles.css'),
  'utf8',
);

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

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
    expect(tokens).toContain('disabled:bg-(--surface-sunken)');
  });

  it('draws the 3px focus ring at a 3px offset', () => {
    expect(tokens).toContain('focus-visible:outline-3');
    expect(tokens).toContain('focus-visible:outline-offset-3');
  });

  it('is the one recipe the suspension inputs use', () => {
    expect(SUSPENSION_INPUT).toContain(FIELD_INPUT_CLASS);
  });
});

describe('.aec-field-control', () => {
  it('paints the field edge, the 12px radius, the 44px floor and no shadow', () => {
    const r = rule('.aec-field-control');
    expect(r).toContain('border-color: var(--border-field)');
    expect(r).toContain('border-radius: var(--radius-control)');
    expect(r).toContain('min-height: 2.75rem');
    expect(r).toContain('box-shadow: none');
    expect(r).not.toContain('--border-input');
  });

  it('shifts the edge to Forest on focus with a 3px ring 3px out', () => {
    const r = rule('.aec-field-control:focus-visible');
    expect(r).toContain('border-color: var(--accent-primary)');
    expect(r).toContain('outline-width: 3px');
    expect(r).toContain('outline-offset: 3px');
  });

  it('thickens the edge to 2px in the error colour, declared after focus so it wins', () => {
    const r = rule(".aec-field-control[aria-invalid='true']");
    expect(r).toContain('border-color: var(--status-error)');
    expect(r).toContain('border-width: 2px');
    expect(css.indexOf(".aec-field-control[aria-invalid='true'] {")).toBeGreaterThan(
      css.indexOf('.aec-field-control:focus-visible {'),
    );
  });
});

describe('FIELD_ERROR_CLASS', () => {
  it('is 14px at weight 600 in the error colour, with the icon rule attached', () => {
    expect(FIELD_ERROR_CLASS.split(/\s+/)).toEqual(
      expect.arrayContaining([
        'aec-field-error',
        'text-t-14',
        'font-semibold',
        'text-(--status-error)',
      ]),
    );
    const before = rule('.aec-field-error::before');
    expect(before).toContain('mask:');
    expect(before).toContain('width: 1rem');
    expect(rule('.aec-field-error')).toContain('gap: 0.5rem');
  });
});
