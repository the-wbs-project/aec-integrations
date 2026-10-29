/**
 * AECI-1457 (ruling 2026-10-29) — every tier's deploy provisions the Turnstile
 * siteverify secret, and fails when it is missing.
 *
 * `TURNSTILE_SECRET_KEY` is REQUIRED on staging, demo and production. Each tier has its
 * own Invisible widget, so the GH secret is suffixed per tier and lands on the API
 * Worker as `TURNSTILE_SECRET_KEY`. Whether Turnstile actually runs on a tier is the web
 * Worker's committed `TURNSTILE_SITE_KEY` (`apps/web/src/turnstile-site-key.spec.ts`).
 *
 * The PR suite never runs the deploy or promote workflows, so dropping a name from
 * `REQUIRED_SECRETS` or turning a push step into a skip is invisible until the next
 * deploy. This file is the gate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');

const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

/** Pull the single-quoted value of a `KEY: '…'` line out of a workflow. */
function secretList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  if (!match) throw new Error(`${key} not found in workflow`);
  return match[1]!.split(/\s+/).filter(Boolean);
}

/** The body of the named step, up to the next step. */
function stepBody(raw: string, name: string): string {
  const start = raw.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`step "${name}" not found`);
  const next = raw.indexOf('\n      - name:', start + 1);
  return raw.slice(start, next < 0 ? undefined : next);
}

const TIERS = [
  { file: 'deploy.yml', env: 'staging', ghSecret: 'TURNSTILE_SECRET_KEY_STAGING' },
  { file: 'promote-to-demo.yml', env: 'demo', ghSecret: 'TURNSTILE_SECRET_KEY_DEMO' },
  {
    file: 'promote-to-prod.yml',
    env: 'production',
    ghSecret: 'TURNSTILE_SECRET_KEY_PRODUCTION',
  },
] as const;

describe.each(TIERS)(
  'AECI-1457: $file provisions TURNSTILE_SECRET_KEY',
  ({ file, env, ghSecret }) => {
    const raw = readWorkflow(file);

    it('maps the GH secret into the preflight step', () => {
      // require-secrets.sh checks the VALUE of an env var, so an unmapped name reads empty.
      expect(raw).toContain(`${ghSecret}: \${{ secrets.${ghSecret} }}`);
    });

    it('is REQUIRED, not recommended', () => {
      expect(secretList(raw, 'REQUIRED_SECRETS')).toContain(ghSecret);
      expect(secretList(raw, 'RECOMMENDED_SECRETS')).not.toContain(ghSecret);
    });

    it('pushes it to the API Worker and fails instead of skipping', () => {
      const body = stepBody(raw, `Push TURNSTILE_SECRET_KEY to API Worker (${env})`);
      expect(body).toContain(`TURNSTILE_SECRET_KEY_VALUE: \${{ secrets.${ghSecret} }}`);
      expect(body).toContain('working-directory: apps/api');
      expect(body).toContain(`wrangler secret put TURNSTILE_SECRET_KEY --env ${env}`);
      expect(body).toContain('exit 1');
      expect(body).not.toContain('exit 0');
    });
  },
);

describe('AECI-1457: the live-Worker postflight asserts the secret landed', () => {
  // promote-to-demo.yml has no verify-worker-secrets step at all, so demo relies on
  // the preflight plus the failing push step.
  it.each(['deploy.yml', 'promote-to-prod.yml'])('%s lists TURNSTILE_SECRET_KEY', (file) => {
    expect(secretList(readWorkflow(file), 'REQUIRED_WORKER_SECRETS')).toContain(
      'TURNSTILE_SECRET_KEY',
    );
  });
});
