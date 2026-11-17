/**
 * AECI-1714 — which tiers send the browser report.
 *
 * `BROWSER_EVIDENCE_ENABLED` is a committed web Worker var, and it is the switch:
 * `"true"` injects `window.__AECI_BROWSER_EVIDENCE__`, anything else ships the
 * report dark. Production stays `"false"` until Privacy Policy 1.1 is in force, which
 * is the promise this file holds. AECI-1715 changes the production expectation in
 * the same PR that flips the var.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

type Vars = Record<string, unknown>;

/** Same stripping as `turnstile-site-key.spec.ts`, which also asserts no inline comments. */
function parseWrangler(): { vars?: Vars; env: Record<string, { vars?: Vars }> } {
  const stripped = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(stripped) as ReturnType<typeof parseWrangler>;
}

describe('wrangler.jsonc BROWSER_EVIDENCE_ENABLED (AECI-1714)', () => {
  const config = parseWrangler();

  it('local (the top-level block) has it on', () => {
    expect(config.vars?.['BROWSER_EVIDENCE_ENABLED']).toBe('true');
  });

  it.each(['staging', 'demo'] as const)('%s has it on', (tier) => {
    expect(config.env[tier]?.vars?.['BROWSER_EVIDENCE_ENABLED']).toBe('true');
  });

  it('production has it off until Privacy Policy 1.1 is in force (AECI-1715)', () => {
    expect(config.env['production']?.vars?.['BROWSER_EVIDENCE_ENABLED']).toBe('false');
  });

  it('every env block declares it, because vars are not inherited across wrangler envs', () => {
    expect(Object.keys(config.env).sort()).toEqual(['demo', 'production', 'staging']);
  });
});
