/**
 * Every deployed wrangler block must carry the Cloudflare Access vars that
 * `src/access.ts` reads.
 *
 * Without BOTH `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN`, `requireAccess()` skips
 * JWT verification entirely, so a user who has signed in through Access still
 * gets a 403. Every other spec injects `env` by hand, which is exactly why the
 * first deploy shipped without them and the suite stayed green. `vars` is not
 * inherited into a named environment, so the base block and `env.production`
 * are checked separately.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

type Vars = Record<string, string | undefined>;

/** Strip whole-line `//` comments and trailing commas. Sound only while no
 *  comment shares a line with code, which the first test asserts. */
function parseWrangler(): { vars?: Vars; env: Record<string, { vars?: Vars }> } {
  const stripped = RAW.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as ReturnType<typeof parseWrangler>;
}

const config = parseWrangler();

const BLOCKS: { label: string; vars: Vars }[] = [
  { label: 'base (preview)', vars: config.vars ?? {} },
  { label: 'production', vars: config.env['production']?.vars ?? {} },
];

describe('wrangler.jsonc Access vars', () => {
  it('has no inline comments, so the parser above is sound', () => {
    const offenders = RAW.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const idx = line.indexOf('//');
        if (idx <= 0) return false;
        if (line.slice(Math.max(0, idx - 1), idx + 2) === '://') return false;
        return line.slice(0, idx).trim().length > 0;
      });
    expect(offenders.map((o) => o.n)).toEqual([]);
  });

  it.each(BLOCKS)('$label sets a real ACCESS_AUD', ({ vars }) => {
    expect(vars['ACCESS_AUD']).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(BLOCKS)('$label sets a real ACCESS_TEAM_DOMAIN', ({ vars }) => {
    expect(vars['ACCESS_TEAM_DOMAIN']).toMatch(/^[a-z0-9-]+\.cloudflareaccess\.com$/);
  });
});
