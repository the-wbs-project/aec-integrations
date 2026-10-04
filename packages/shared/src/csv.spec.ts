import { describe, expect, it } from 'vitest';

import { csvCell, toCsv } from './csv';

describe('csvCell', () => {
  it('writes a plain value unquoted', () => {
    expect(csvCell('product.updated')).toBe('product.updated');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(true)).toBe('true');
  });

  it('writes null and undefined as an empty cell', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a comma, a quote, CR and LF, doubling inner quotes (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
  });

  it.each(['=', '+', '-', '@', '\t', '\r'])(
    'prefixes a cell that starts with %j so a spreadsheet reads it as text',
    (lead) => {
      const cell = csvCell(`${lead}SUM(A1:A2)`);
      expect(cell.replace(/^"/, '').startsWith(`'${lead}`)).toBe(true);
    },
  );

  it('guards before quoting, so a formula with a comma is guarded and quoted', () => {
    expect(csvCell('=HYPERLINK("http://x",1)')).toBe('"\'=HYPERLINK(""http://x"",1)"');
  });

  it('leaves a lead character alone when it is not first', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('2026-10-04')).toBe('2026-10-04');
  });
});

describe('toCsv', () => {
  it('writes a header and rows, each ending in CRLF', () => {
    expect(
      toCsv(
        ['id', 'note'],
        [
          ['1', 'plain'],
          ['2', null],
        ],
      ),
    ).toBe('id,note\r\n1,plain\r\n2,\r\n');
  });

  it('writes only the header when there are no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe('a,b\r\n');
  });
});
