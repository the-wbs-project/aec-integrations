import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1764): the shared field recipe lives in unlayered rules in
 * `styles.css`, so these checks read the source. Every form control moves with
 * these rules, so a regression here moves all of them.
 */
const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

describe('.aec-field-control', () => {
  it('paints the field edge, the 12px radius and the 44px floor, never --border-input', () => {
    const r = rule('.aec-field-control');
    expect(r).toContain('border-color: var(--border-field)');
    expect(r).toContain('border-radius: var(--radius-control)');
    expect(r).toContain('min-height: 2.75rem');
    expect(r).not.toContain('--border-input');
    expect(r).not.toContain('box-shadow');
  });

  it('shows disabled as the sunken tint, never as opacity', () => {
    const r = rule(".aec-field-control:is(:disabled, [aria-disabled='true'])");
    expect(r).toContain('background-color: var(--surface-sunken)');
    expect(r).toContain('color: var(--text-secondary)');
    expect(r).not.toContain('opacity');
  });

  it('shifts the edge to Forest on focus with a 3px ring 3px out', () => {
    const r = rule('.aec-field-control:focus-visible');
    expect(r).toContain('border-color: var(--accent-primary)');
    expect(r).toContain('outline-width: 3px');
    expect(r).toContain('outline-offset: 3px');
  });

  it('draws a 2px error edge that keeps the box size, declared after focus so it wins', () => {
    const r = rule(".aec-field-control[aria-invalid='true']");
    expect(r).toContain('border-color: var(--status-error)');
    expect(r).toContain('border-width: 2px');
    expect(r).toContain('padding-block: calc(0.5rem - 1px)');
    expect(r).toContain('padding-inline-start: calc(1rem - 1px)');
    expect(css.indexOf(".aec-field-control[aria-invalid='true'] {")).toBeGreaterThan(
      css.indexOf('.aec-field-control:focus-visible {'),
    );
  });
});

describe('.aec-field-error', () => {
  it('lays the line out as a flex row in CSS, so hand-copied lines get the glyph box', () => {
    const line = rule('.aec-field-error');
    expect(line).toMatch(/display:\s*flex/);
    expect(line).toMatch(/gap:\s*0\.5rem/);
  });

  it('draws a 16px glyph before the message as a mask', () => {
    const before = rule('.aec-field-error::before');
    expect(before).toContain('mask:');
    expect(before).toContain('width: 1rem');
    expect(before).toContain('height: 1rem');
  });

  it('keeps the glyph visible under forced colours', () => {
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.aec-field-error::before \{[^}]*forced-color-adjust: none;[^}]*background-color: CanvasText/,
    );
  });
});
