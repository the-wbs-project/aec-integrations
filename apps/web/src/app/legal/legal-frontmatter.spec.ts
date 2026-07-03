import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from './legal-frontmatter';

describe('parseFrontmatter', () => {
  it('parses scalar key/value pairs and separates the body', () => {
    const raw = `---
title: Terms of Service
version: 1.0
last_updated: 23 June 2026
---

Body starts here.

## A heading
`;
    const { data, body } = parseFrontmatter(raw);
    expect(data['title']).toBe('Terms of Service');
    expect(data['version']).toBe('1.0');
    expect(data['last_updated']).toBe('23 June 2026');
    expect(body.startsWith('Body starts here.')).toBe(true);
    expect(body).toContain('## A heading');
  });

  it('parses a blank value as an empty string (unapproved-draft frontmatter)', () => {
    const raw = `---
title: Privacy Policy
effective_date:
counsel_approved_by:
---
Body.`;
    const { data } = parseFrontmatter(raw);
    expect(data['effective_date']).toBe('');
    expect(data['counsel_approved_by']).toBe('');
  });

  it('keeps colons in the value — only the first colon is the separator', () => {
    const raw = `---
note: see https://example.com/x: details
---
B`;
    expect(parseFrontmatter(raw).data['note']).toBe('see https://example.com/x: details');
  });

  it('returns the whole input as the body when there is no frontmatter fence', () => {
    const raw = '# No frontmatter\n\nJust body.';
    const { data, body } = parseFrontmatter(raw);
    expect(data).toEqual({});
    expect(body).toBe(raw);
  });

  it('tolerates CRLF line endings', () => {
    const { data, body } = parseFrontmatter('---\r\ntitle: X\r\nversion: 2.0\r\n---\r\nBody');
    expect(data['title']).toBe('X');
    expect(data['version']).toBe('2.0');
    expect(body).toBe('Body');
  });
});
