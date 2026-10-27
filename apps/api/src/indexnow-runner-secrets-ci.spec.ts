/**
 * AECI-1476 — the production promote provisions the IndexNow runner's token, the
 * send workflow presents the same GitHub secret, and no other tier receives it.
 *
 * Recommended, not required: without the token both internal routes 401, the
 * `indexnow-send` run goes red and the `aeci.indexnow.batch` heartbeat stops, so
 * the absence is loud. But the push step is the only thing that gets the token onto
 * the Worker, and the PR suite never runs the promote workflow, so this file is the
 * gate that keeps the wiring from being deleted silently.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');
const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');
const PROD = readWorkflow('promote-to-prod.yml');

function secretList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  if (!match) throw new Error(`${key} not found in workflow`);
  return match[1]!.split(/\s+/).filter(Boolean);
}

describe('AECI-1476: INDEXNOW_RUNNER_TOKEN is provisioned by the production promote', () => {
  it('maps the GH secret into the preflight step and lists it as recommended', () => {
    expect(PROD).toContain(
      'INDEXNOW_RUNNER_TOKEN_PRODUCTION: ${{ secrets.INDEXNOW_RUNNER_TOKEN_PRODUCTION }}',
    );
    expect(secretList(PROD, 'RECOMMENDED_SECRETS')).toContain('INDEXNOW_RUNNER_TOKEN_PRODUCTION');
    expect(secretList(PROD, 'REQUIRED_SECRETS')).not.toContain('INDEXNOW_RUNNER_TOKEN_PRODUCTION');
  });

  it('pushes it to the production API Worker', () => {
    expect(PROD).toMatch(/wrangler secret put INDEXNOW_RUNNER_TOKEN --env production/);
  });

  it.each(['deploy.yml', 'promote-to-demo.yml'])('never pushes the token from %s', (name) => {
    expect(readWorkflow(name)).not.toMatch(/secret put INDEXNOW_RUNNER_TOKEN/);
  });

  it('the send workflow presents the same secret to the runner script, against production', () => {
    const send = readWorkflow('indexnow-send.yml');
    expect(send).toContain(
      'INDEXNOW_RUNNER_TOKEN: ${{ secrets.INDEXNOW_RUNNER_TOKEN_PRODUCTION }}',
    );
    expect(send).toContain('ops:indexnow-runner -- --site https://www.aecintegrations.com');
    expect(send).toMatch(/cron: '20 0 \* \* \*'/);
  });

  it('the one-shot probe is gone', () => {
    expect(existsSync(join(WORKFLOWS, 'indexnow-probe.yml'))).toBe(false);
  });
});
