/**
 * AECI-1499 (epic AECI-1339): every deployed tier pushes both Stripe secrets, and none
 * of them can block a deploy.
 *
 * `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are recommended and warn-and-skip on
 * staging, demo AND production, by the 2026-10-28 ruling. Production is gated by the
 * `STRIPE_CHECKOUT_ENABLED` var instead, which ships `"false"` there until the switch-on.
 * An absent key leaves checkout answering 503, and an absent webhook secret leaves the
 * webhook failing closed, so neither is a reason to stop a promote.
 *
 * The PR suite never runs a deploy or promote workflow, so a dropped mapping, a
 * missing push step or a name moved into `REQUIRED_SECRETS` stays invisible until the
 * next deploy. This file is the gate, modelled on `resend-webhook-secrets-ci.spec.ts`.
 * It also pins the per-tier wrangler vars, because they are not inherited into a named
 * env and a missing one reads as "checkout off" with no error.
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
  return match[1].split(/\s+/).filter(Boolean);
}

/** The `run:` body of the named step, up to the next step. */
function stepBody(raw: string, name: string): string {
  const start = raw.indexOf(`- name: ${name}`);
  if (start < 0) throw new Error(`step "${name}" not found`);
  const next = raw.indexOf('\n      - name:', start + 1);
  return raw.slice(start, next < 0 ? undefined : next);
}

const TIERS = [
  { file: 'deploy.yml', suffix: 'STAGING', env: 'staging' },
  { file: 'promote-to-demo.yml', suffix: 'DEMO', env: 'demo' },
  { file: 'promote-to-prod.yml', suffix: 'PRODUCTION', env: 'production' },
] as const;

const SECRETS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] as const;

const CASES = TIERS.flatMap((tier) => SECRETS.map((secret) => ({ ...tier, secret })));

describe('AECI-1499: Stripe secrets are pushed, warn-and-skip, on every tier', () => {
  it.each(CASES)(
    '$file maps $secret ($suffix) into the preflight step',
    ({ file, secret, suffix }) => {
      // require-secrets.sh checks the VALUE of an env var, so an unmapped name reads empty.
      expect(readWorkflow(file)).toContain(
        `${secret}_${suffix}: \${{ secrets.${secret}_${suffix} }}`,
      );
    },
  );

  it.each(CASES)(
    '$file keeps $secret ($suffix) recommended, never required',
    ({ file, secret, suffix }) => {
      const raw = readWorkflow(file);
      expect(secretList(raw, 'RECOMMENDED_SECRETS')).toContain(`${secret}_${suffix}`);
      expect(secretList(raw, 'REQUIRED_SECRETS')).not.toContain(`${secret}_${suffix}`);
    },
  );

  it.each(CASES)(
    '$file pushes $secret and skips when it is unset',
    ({ file, secret, suffix, env }) => {
      const body = stepBody(readWorkflow(file), `Push ${secret} to API Worker (${env})`);
      expect(body).toContain(`\${{ secrets.${secret}_${suffix} }}`);
      expect(body).toContain(`wrangler secret put ${secret} --env ${env}`);
      expect(body).toContain('::warning::');
      expect(body).toContain('exit 0');
      expect(body).not.toContain('exit 1');
    },
  );

  it('never re-asserts a Stripe secret on the live production Worker', () => {
    // REQUIRED_WORKER_SECRETS fails the promote when a name is absent, which would make a
    // recommended secret required by the back door.
    const required = secretList(readWorkflow('promote-to-prod.yml'), 'REQUIRED_WORKER_SECRETS');
    for (const secret of SECRETS) expect(required).not.toContain(secret);
  });
});

// ─── Wrangler vars ───────────────────────────────────────────────────────────

const RAW = readFileSync(join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

/** Whole-line comments and trailing commas only, as `wrangler-ratelimits.spec.ts`. */
const config = JSON.parse(
  RAW.split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/,(\s*[}\]])/g, '$1'),
) as {
  vars?: Record<string, string>;
  env: Record<string, { vars?: Record<string, string> }>;
};

/** The staging sandbox serves local dev and staging; demo and live have their own. */
const STAGING_SANDBOX = {
  annual: 'bpc_1USUHUQn1Dn3MGrP1bksUZFx',
  monthly: 'bpc_1USUHpQn1Dn3MGrPnsBlzugb',
};

const VAR_BLOCKS = [
  { label: 'base (local dev)', vars: config.vars, portal: STAGING_SANDBOX, enabled: 'true' },
  {
    label: 'staging',
    vars: config.env.staging?.vars,
    portal: STAGING_SANDBOX,
    enabled: 'true',
  },
  {
    label: 'demo',
    vars: config.env.demo?.vars,
    portal: { annual: 'bpc_1USXyuH3zp7gNZbr7U8MuNJB', monthly: 'bpc_1USXzYH3zp7gNZbrSE9UwOrt' },
    enabled: 'true',
  },
  {
    label: 'production',
    vars: config.env.production?.vars,
    portal: { annual: 'bpc_1UV5f6QjYyilC49gRYsZF57S', monthly: 'bpc_1UV5fMQjYyilC49gtxqN3ggH' },
    enabled: 'false',
  },
];

describe('AECI-1499: Stripe vars in every wrangler block', () => {
  it.each(VAR_BLOCKS)('$label carries its Stripe account portal configs', ({ vars, portal }) => {
    expect(vars?.STRIPE_PORTAL_CONFIG_ANNUAL).toBe(portal.annual);
    expect(vars?.STRIPE_PORTAL_CONFIG_MONTHLY).toBe(portal.monthly);
  });

  it.each(VAR_BLOCKS)('$label sets STRIPE_CHECKOUT_ENABLED to "$enabled"', ({ vars, enabled }) => {
    expect(vars?.STRIPE_CHECKOUT_ENABLED).toBe(enabled);
  });

  it('never commits a Stripe secret as a var', () => {
    expect(RAW).not.toMatch(/\b(sk|rk)_(test|live)_[A-Za-z0-9]/);
    expect(RAW).not.toMatch(/whsec_[A-Za-z0-9]/);
  });
});
