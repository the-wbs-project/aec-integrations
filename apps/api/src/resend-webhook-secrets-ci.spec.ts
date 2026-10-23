/**
 * AECI-1438 — the production promote must provision the Resend delivery-webhook secret.
 *
 * AECI-1222 shipped `RESEND_WEBHOOK_SECRET_PRODUCTION` as recommended and warn-and-skip,
 * while no Resend endpoint was registered. The GH secret was then never created. Every
 * production promote printed a warning that nobody read, `POST /api/webhooks/resend`
 * would have 401'd every event, and `notification_delivery_events` held 0 rows against
 * 48 sends. `/admin/email` could not say whether the first vendor grant's approval email
 * arrived.
 *
 * The PR suite never runs the promote workflow, so dropping the name from
 * `REQUIRED_SECRETS` or turning the push step back into a skip is invisible until the
 * next production promote. This file is the gate. Staging and demo stay warn-and-skip:
 * their endpoints are not registered.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');

const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

const PROD = readWorkflow('promote-to-prod.yml');

/** Pull the single-quoted value of a `KEY: '…'` line out of a workflow. */
function secretList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  if (!match) throw new Error(`${key} not found in workflow`);
  return match[1].split(/\s+/).filter(Boolean);
}

/** The `run:` body of the named step, up to the next step. */
function stepBody(raw: string, name: string): string {
  const start = raw.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`step "${name}" not found`);
  const next = raw.indexOf('\n      - name:', start + 1);
  return raw.slice(start, next < 0 ? undefined : next);
}

describe('AECI-1438: RESEND_WEBHOOK_SECRET is provisioned by the production promote', () => {
  it('maps the GH secret into the preflight step', () => {
    // require-secrets.sh checks the VALUE of an env var, so an unmapped name reads empty.
    expect(PROD).toContain(
      'RESEND_WEBHOOK_SECRET_PRODUCTION: ${{ secrets.RESEND_WEBHOOK_SECRET_PRODUCTION }}',
    );
  });

  it('is REQUIRED, not recommended', () => {
    expect(secretList(PROD, 'REQUIRED_SECRETS')).toContain('RESEND_WEBHOOK_SECRET_PRODUCTION');
    expect(secretList(PROD, 'RECOMMENDED_SECRETS')).not.toContain(
      'RESEND_WEBHOOK_SECRET_PRODUCTION',
    );
  });

  it('fails the push step instead of skipping it', () => {
    const body = stepBody(PROD, 'Push RESEND_WEBHOOK_SECRET to API Worker (production)');
    expect(body).toContain('wrangler secret put RESEND_WEBHOOK_SECRET --env production');
    expect(body).toContain('exit 1');
    expect(body).not.toContain('exit 0');
  });

  it('re-asserts the secret on the live Worker after deploy', () => {
    expect(secretList(PROD, 'REQUIRED_WORKER_SECRETS')).toContain('RESEND_WEBHOOK_SECRET');
  });
});

describe('AECI-1438: staging and demo stay warn-and-skip', () => {
  it.each([
    ['deploy.yml', 'RESEND_WEBHOOK_SECRET_STAGING'],
    ['promote-to-demo.yml', 'RESEND_WEBHOOK_SECRET_DEMO'],
  ])('%s keeps %s recommended', (file, name) => {
    const raw = readWorkflow(file);
    expect(secretList(raw, 'RECOMMENDED_SECRETS')).toContain(name);
  });
});
