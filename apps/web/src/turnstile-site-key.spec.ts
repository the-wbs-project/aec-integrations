/**
 * AECI-1457 (ruling 2026-10-29) — which tiers ship a Turnstile site key.
 *
 * `TURNSTILE_SITE_KEY` is the public key of a tier's Invisible Turnstile widget. It is
 * a committed web Worker var, and it is the switch: no key, no script, no token. The
 * API secret (`TURNSTILE_SECRET_KEY`) is deploy-required on every tier and pushed by
 * CI, so this file decides where Turnstile actually runs.
 *
 * - staging and demo MUST carry a key. A missing one ships the feature dark without a
 *   word, and the PR suite runs no `wrangler deploy --dry-run`, so this file is the gate.
 * - production must NOT carry one yet. The flip waits on the counsel ruling in
 *   AECI-1458. When it lands, add the key to `env.production.vars` and move
 *   `production` into REQUIRED_TIERS below in the same PR.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

/** Tiers that must ship a site key today. */
const REQUIRED_TIERS = ['staging', 'demo'] as const;

/** Cloudflare Turnstile site keys start `0x`; the test keys start `1x`/`2x`/`3x`. */
const SITE_KEY_RE = /^0x[0-9A-Za-z_-]{10,}$/;

type Vars = Record<string, unknown>;

/**
 * Strip `/* … *\/` blocks, whole-line `//` comments and trailing commas. Sound only
 * while no line carries an inline `//` comment, which the first test asserts.
 */
function parseWrangler(): { vars?: Vars; env: Record<string, { vars?: Vars }> } {
  const stripped = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as ReturnType<typeof parseWrangler>;
}

describe('wrangler.jsonc TURNSTILE_SITE_KEY (AECI-1457)', () => {
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

  const config = parseWrangler();

  it.each(REQUIRED_TIERS)('%s carries a real Turnstile site key', (tier) => {
    const key = config.env[tier]?.vars?.['TURNSTILE_SITE_KEY'];
    expect(key, `env.${tier}.vars.TURNSTILE_SITE_KEY`).toEqual(expect.stringMatching(SITE_KEY_RE));
  });

  it('production carries no site key until the AECI-1458 counsel ruling', () => {
    expect(config.env['production']?.vars?.['TURNSTILE_SITE_KEY']).toBeUndefined();
  });

  it('the base (local) block carries no site key: local dev uses .dev.vars test keys', () => {
    expect(config.vars?.['TURNSTILE_SITE_KEY']).toBeUndefined();
  });

  it('staging and demo use different widgets', () => {
    const keys = REQUIRED_TIERS.map((tier) => config.env[tier]?.vars?.['TURNSTILE_SITE_KEY']);
    expect(new Set(keys).size).toBe(REQUIRED_TIERS.length);
  });
});
