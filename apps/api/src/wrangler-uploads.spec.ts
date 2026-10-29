import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raw = readFileSync(join(__dirname, '../wrangler.jsonc'), 'utf8');
type Block = { r2_buckets?: { binding: string; bucket_name: string }[] };
const config = JSON.parse(
  raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1'),
) as Block & { env: Record<string, Block> };

describe('R2 environment binding', () => {
  it.each(['root', 'staging', 'demo', 'production'])('binds UPLOADS in %s', (name) => {
    const block = name === 'root' ? config : config.env[name];
    // The root block is the local-dev config. It keeps the retired preview tier's
    // bucket NAME so local R2 state (keyed by bucket name) carries over (AECI-1268).
    expect(block?.r2_buckets?.filter((b) => b.binding === 'UPLOADS')).toEqual([
      { binding: 'UPLOADS', bucket_name: `aeci-uploads-${name === 'root' ? 'preview' : name}` },
    ]);
  });

  // AECI-1228 / ADR 0050. Staging and production only. Production fails closed without
  // it (the prune refuses page_views days), so a lost entry is caught here first.
  it.each(['staging', 'production'])('binds PAGE_VIEWS_ARCHIVE in %s', (name) => {
    expect(config.env[name]?.r2_buckets?.filter((b) => b.binding === 'PAGE_VIEWS_ARCHIVE')).toEqual(
      [{ binding: 'PAGE_VIEWS_ARCHIVE', bucket_name: `aeci-page-views-archive-${name}` }],
    );
  });

  it.each(['root', 'demo'])('binds no PAGE_VIEWS_ARCHIVE in %s', (name) => {
    const block = name === 'root' ? config : config.env[name];
    expect(block?.r2_buckets?.some((b) => b.binding === 'PAGE_VIEWS_ARCHIVE')).toBe(false);
  });

  it('has no env.preview block left (AECI-1268)', () => {
    expect(config.env.preview).toBeUndefined();
  });
});
