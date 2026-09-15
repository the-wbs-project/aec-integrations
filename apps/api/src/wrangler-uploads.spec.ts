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
  it.each(['root', 'preview', 'staging', 'demo', 'production'])('binds UPLOADS in %s', (name) => {
    const block = name === 'root' ? config : config.env[name];
    expect(block?.r2_buckets).toEqual([
      { binding: 'UPLOADS', bucket_name: `aeci-uploads-${name === 'root' ? 'preview' : name}` },
    ]);
  });
});
