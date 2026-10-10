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
    expect(block?.r2_buckets).toEqual([
      { binding: 'UPLOADS', bucket_name: `aeci-uploads-${name === 'root' ? 'preview' : name}` },
    ]);
  });

  it('has no env.preview block left (AECI-1268)', () => {
    expect(config.env.preview).toBeUndefined();
  });
});
