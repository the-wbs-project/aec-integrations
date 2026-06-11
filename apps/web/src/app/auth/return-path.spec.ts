import { describe, expect, it } from 'vitest';

import { safeReturnPath } from './return-path';

// The open-redirect acceptance criterion (AECI-194): every hostile shape an
// attacker could place in `/auth/login?return=…` must collapse to `/`, and
// honest same-origin paths must survive untouched.
describe('safeReturnPath', () => {
  // ── Rejected → '/' ────────────────────────────────────────────────────────
  it.each([
    [null, 'null (param absent)'],
    [undefined, 'undefined'],
    ['', 'empty string'],
    ['//evil.example', 'protocol-relative URL'],
    ['//evil.example/products', 'protocol-relative URL with path'],
    ['/\\evil.example', 'backslash protocol-relative (browser-normalized)'],
    ['\\/evil.example', 'leading backslash'],
    ['/products\\..\\x', 'embedded backslash'],
    ['https://evil.example', 'absolute https URL'],
    ['http://evil.example', 'absolute http URL'],
    ['javascript:alert(1)', 'javascript: scheme'],
    ['JavaScript:alert(1)', 'javascript: scheme (mixed case)'],
    ['data:text/html,x', 'data: scheme'],
    ['products/procore', 'relative path (no leading slash)'],
    ['  /products', 'leading whitespace'],
    ['\t/products', 'leading tab'],
    ['/products\nSet-Cookie: x', 'embedded newline'],
    ['/products\u0000', 'embedded NUL'],
    ['/products\u007f', 'embedded DEL'],
  ])('rejects %s (%s)', (raw, _label) => {
    expect(safeReturnPath(raw as string | null | undefined)).toBe('/');
  });

  // ── Accepted verbatim ────────────────────────────────────────────────────
  it.each([
    ['/', 'root'],
    ['/products', 'simple path'],
    ['/products/procore', 'nested path'],
    ['/products/x?y=1#z', 'path with query and fragment'],
    ['/search?q=revit%20worksharing', 'encoded query'],
    ['/categories/estimating-takeoff', 'hyphenated slug'],
  ])('preserves %s (%s)', (raw, _label) => {
    expect(safeReturnPath(raw)).toBe(raw);
  });
});
