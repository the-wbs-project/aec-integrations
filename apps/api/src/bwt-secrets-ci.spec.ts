/**
 * AECI-821: the production promote provisions the Bing Webmaster Tools key, and no
 * other tier receives it.
 *
 * The key is RECOMMENDED, not required: absent, the search ingest's Bing lane is
 * skipped and says so on its heartbeat. But the push step is the only thing that
 * gets the key onto the Worker, and the PR suite never runs the promote workflow,
 * so this file keeps the wiring from being deleted silently. It also pins the
 * secret's name, `BWT_API_KEY_PRODUCTION`, which the operator creates by hand.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..');
const WORKFLOWS = join(ROOT, '.github', 'workflows');
const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');
const PROD = readWorkflow('promote-to-prod.yml');

function secretList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  if (!match) throw new Error(`${key} not found in workflow`);
  return match[1]!.split(/\s+/).filter(Boolean);
}

describe('AECI-821: BWT_API_KEY is provisioned by the production promote', () => {
  it('maps the GH secret into the preflight step and lists it as recommended', () => {
    expect(PROD).toContain('BWT_API_KEY_PRODUCTION: ${{ secrets.BWT_API_KEY_PRODUCTION }}');
    expect(secretList(PROD, 'RECOMMENDED_SECRETS')).toContain('BWT_API_KEY_PRODUCTION');
    expect(secretList(PROD, 'REQUIRED_SECRETS')).not.toContain('BWT_API_KEY_PRODUCTION');
  });

  it('pushes it to the production API Worker, and skips with a warning when empty', () => {
    expect(PROD).toMatch(/wrangler secret put BWT_API_KEY --env production/);
    expect(PROD).toContain('BWT_API_KEY_VALUE: ${{ secrets.BWT_API_KEY_PRODUCTION }}');
    expect(PROD).toMatch(
      /if \[ -z "\$BWT_API_KEY_VALUE" \]; then\s+echo "::warning::BWT_API_KEY_PRODUCTION not set[^\n]*"\s+exit 0/,
    );
  });

  it.each(['deploy.yml', 'promote-to-demo.yml'])('never pushes the key from %s', (name) => {
    expect(readWorkflow(name)).not.toMatch(/BWT_API_KEY/);
  });

  it('documents the key in .dev.vars.example, empty', () => {
    const example = readFileSync(join(ROOT, 'apps', 'api', '.dev.vars.example'), 'utf8');
    expect(example).toMatch(/^BWT_API_KEY=$/m);
  });
});

/**
 * AECI-2075: the key travels in the request URL as `?apikey=`. A staging read on
 * 2026-11-26 showed that `redact_query_string` strips the query string from an
 * outbound fetch span too (`url.full` without it, `url.query` empty). That setting
 * is the only thing keeping the key out of Cloudflare's stored traces, so every
 * observability block in the API Worker's config must keep it.
 */
describe('AECI-2075: every API observability block redacts query strings', () => {
  const wrangler = readFileSync(join(ROOT, 'apps', 'api', 'wrangler.jsonc'), 'utf8');
  const blocks = wrangler.match(/"observability":\s*\{/g) ?? [];
  const redacted = wrangler.match(/"redact_query_string":\s*true/g) ?? [];

  it('has one block per tier, top level plus staging, demo and production', () => {
    expect(blocks).toHaveLength(4);
  });

  it('sets redact_query_string: true in each block', () => {
    expect(redacted).toHaveLength(blocks.length);
    expect(wrangler).not.toMatch(/"redact_query_string":\s*false/);
  });
});
