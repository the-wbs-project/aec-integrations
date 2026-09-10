/**
 * AECI-851 — the production promote must provision the form→Linear pipeline.
 *
 * `LINEAR_API_KEY` is fail-open at runtime by design: with no key,
 * `createLinearIssueForRequest()` returns before its first metric, so a failed
 * pipeline emits **nothing**. No `aeci.linear.issue{outcome:failed}` point, no
 * log line, no alert. The `aeci.linear.reconcile.persistent_failure` email is
 * the only signal, and it arrives 60 minutes after the fact, once per stuck row.
 *
 * That combination is why the gap survived: nothing referenced `LINEAR_API_KEY`
 * in `.github/workflows/`, nothing listed it in `docs/environments.md` §Secrets,
 * and nothing listed it in the launch-cutover checklist. Production therefore ran
 * from the 2026-07 apex cutover to 2026-09-10 with no key at all, and the first
 * real vendor claim (Procore, request `943e4502-…`) returned its 201 and routed
 * to nobody.
 *
 * Nothing else catches a regression here. The PR suite never runs the promote
 * workflow, so deleting the push step or dropping the name from `REQUIRED_SECRETS`
 * is invisible until the next production promote — or, worse, until the promote
 * passes and a claim is silently lost. This file is the gate.
 *
 * The second assertion is the inverse: the key must NOT be pushed to any non-prod
 * tier. The Linear board constants in `lib/linear.ts` are hardcoded to the one
 * live "Vendor Requests" project, so a staging/demo/preview Worker holding this
 * key files fixture claims as real AECi issues. `AECI-638` ("Claim: Fixture
 * Procore (product)") is what that looks like.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WORKFLOWS = join(__dirname, '..', '..', '..', '.github', 'workflows');

const readWorkflow = (name: string): string => readFileSync(join(WORKFLOWS, name), 'utf8');

const PROD = readWorkflow('promote-to-prod.yml');

/** Workflows that must never push `LINEAR_API_KEY` — every non-production tier. */
const NON_PROD_WORKFLOWS = ['deploy.yml', 'promote-to-demo.yml', 'pr-preview.yml'] as const;

/** Pull the single-quoted value of a `KEY: '…'` line out of a workflow. */
function secretList(raw: string, key: string): string[] {
  const match = raw.match(new RegExp(`^\\s*${key}:\\s*'([^']*)'`, 'm'));
  if (!match) throw new Error(`${key} not found in workflow`);
  return match[1].split(/\s+/).filter(Boolean);
}

describe('AECI-851: LINEAR_API_KEY is provisioned by the production promote', () => {
  it('maps the GH secret into the preflight step', () => {
    // require-secrets.sh checks the VALUE of an env var, so a name in
    // REQUIRED_SECRETS that is never mapped reads empty and fails every promote.
    expect(PROD).toContain('LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}');
  });

  it('is REQUIRED, not recommended — the absent-key path is silent', () => {
    expect(secretList(PROD, 'REQUIRED_SECRETS')).toContain('LINEAR_API_KEY');
    expect(secretList(PROD, 'RECOMMENDED_SECRETS')).not.toContain('LINEAR_API_KEY');
  });

  it('pushes the key to the production API Worker', () => {
    expect(PROD).toContain('wrangler secret put LINEAR_API_KEY --env production');
  });

  it('re-asserts the key on the live Worker after deploy', () => {
    // The only check that reads the deployed Worker rather than the GH secret,
    // so it is the only one that catches a push that silently no-op'd.
    expect(secretList(PROD, 'REQUIRED_WORKER_SECRETS')).toContain('LINEAR_API_KEY');
  });
});

describe('AECI-851: LINEAR_WEBHOOK_SIGNING_SECRET is pushed, but never required', () => {
  it('maps the GH secret into the preflight step', () => {
    expect(PROD).toContain(
      'LINEAR_WEBHOOK_SIGNING_SECRET: ${{ secrets.LINEAR_WEBHOOK_SIGNING_SECRET }}',
    );
  });

  it('is recommended rather than required — it fails CLOSED and alerts on its own', () => {
    expect(secretList(PROD, 'RECOMMENDED_SECRETS')).toContain('LINEAR_WEBHOOK_SIGNING_SECRET');
    expect(secretList(PROD, 'REQUIRED_SECRETS')).not.toContain('LINEAR_WEBHOOK_SIGNING_SECRET');
    expect(secretList(PROD, 'REQUIRED_WORKER_SECRETS')).not.toContain(
      'LINEAR_WEBHOOK_SIGNING_SECRET',
    );
  });

  it('pushes the secret to the production API Worker', () => {
    expect(PROD).toContain('wrangler secret put LINEAR_WEBHOOK_SIGNING_SECRET --env production');
  });
});

describe('AECI-851: no non-production tier may hold LINEAR_API_KEY', () => {
  // The board constants in lib/linear.ts point at the one live "Vendor Requests"
  // project. A non-prod Worker with this key files fixture claims as real issues.
  // Lift this only when non-prod has its own Linear project AND those constants
  // become env-configurable.
  it.each(NON_PROD_WORKFLOWS)('%s does not push LINEAR_API_KEY', (name) => {
    expect(readWorkflow(name)).not.toContain('wrangler secret put LINEAR_API_KEY');
  });
});
