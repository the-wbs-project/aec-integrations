import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AECI-1688 — `LEGAL_PUBLISH_ENABLED`, the legal publish switch. Wrangler vars are not
 * inherited across environments, so a block that loses the var silently reads as off
 * (or, worse, a later edit copies "true" into production). This pins the value per block.
 *
 * AECI-1677 turned demo and production on: they were held "false" until the portal's
 * acceptance screen existed, so a published version that needs acceptance always has
 * somewhere to be accepted. Publishing still needs an upcoming version committed in code.
 */
const raw = readFileSync(join(__dirname, '../wrangler.jsonc'), 'utf8');
type Block = { vars?: Record<string, string> };
const config = JSON.parse(
  raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1'),
) as Block & { env: Record<string, Block> };

const EXPECTED = {
  root: 'true',
  staging: 'true',
  demo: 'true',
  production: 'true',
} as const;

describe('LEGAL_PUBLISH_ENABLED in every wrangler block', () => {
  it.each(Object.entries(EXPECTED))('is %s → "%s"', (name, value) => {
    const block = name === 'root' ? config : config.env[name];
    expect(block?.vars?.LEGAL_PUBLISH_ENABLED).toBe(value);
  });

  it('has no other environment block that could miss it', () => {
    expect(Object.keys(config.env).sort()).toEqual(['demo', 'production', 'staging']);
  });
});
