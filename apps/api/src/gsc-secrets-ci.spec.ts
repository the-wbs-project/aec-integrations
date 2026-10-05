/**
 * AECI-1236 — the production promote provisions the URL Inspection key, and no
 * other tier receives it.
 *
 * Unlike `LINEAR_API_KEY` (AECI-851) the key is RECOMMENDED, not required: its
 * absent path is loud, because the run emits `aeci.gsc_inspect.run{outcome:skipped}`
 * every day. But the push step is still the only thing that gets the key onto the
 * Worker, and the PR suite never runs the promote workflow, so this file is the
 * gate that keeps the wiring from being deleted silently.
 */

import { readFileSync } from 'node:fs';
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

describe('AECI-1236: GSC_SA_KEY_JSON is provisioned by the production promote', () => {
  it('maps the GH secret into the preflight step and lists it as recommended', () => {
    expect(PROD).toContain('GSC_SA_KEY_JSON_PRODUCTION: ${{ secrets.GSC_SA_KEY_JSON_PRODUCTION }}');
    expect(secretList(PROD, 'RECOMMENDED_SECRETS')).toContain('GSC_SA_KEY_JSON_PRODUCTION');
    expect(secretList(PROD, 'REQUIRED_SECRETS')).not.toContain('GSC_SA_KEY_JSON_PRODUCTION');
  });

  it('pushes it to the production API Worker', () => {
    expect(PROD).toMatch(/wrangler secret put GSC_SA_KEY_JSON --env production/);
  });

  it('creates the chain queue in every deployed tier', () => {
    expect(PROD).toContain('create_queue aeci-gsc-inspect-production');
    expect(readWorkflow('promote-to-demo.yml')).toContain('create_queue aeci-gsc-inspect-demo');
    expect(readWorkflow('deploy.yml')).toContain('create_queue aeci-gsc-inspect-staging');
  });

  it.each(['deploy.yml', 'promote-to-demo.yml', 'pr-preview.yml'])(
    'never pushes the key from %s',
    (name) => {
      expect(readWorkflow(name)).not.toMatch(/secret put GSC_SA_KEY_JSON/);
    },
  );
});
