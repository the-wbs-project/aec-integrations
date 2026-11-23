import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NO_LOCAL_STACK_COMMAND, resolveWebServer } from './web-server';

// AECI-1955: Playwright must never boot `dev:bound` on an agent port, because its
// API Worker would take the reserved 8787. These pin every webServer branch.
describe('resolveWebServer', () => {
  it('boots dev:bound on the default port and reuses a running stack locally', () => {
    const server = resolveWebServer({});
    expect(server).toMatchObject({
      command: 'pnpm dev:bound',
      url: 'http://localhost:8788/api/health',
      reuseExistingServer: true,
    });
  });

  it('treats an explicit 8788 as the default port', () => {
    expect(resolveWebServer({ AECI_WEB_PORT: '8788' })).toMatchObject({
      command: 'pnpm dev:bound',
    });
  });

  it('never boots dev:bound on an agent port; reuses a healthy stack or fails fast', () => {
    const server = resolveWebServer({ AECI_WEB_PORT: '8790' });
    expect(server).toMatchObject({
      command: NO_LOCAL_STACK_COMMAND,
      url: 'http://localhost:8790/api/health',
      // The guard runs only when nothing answers on `url`; a live dev:agent stack is reused.
      reuseExistingServer: true,
    });
  });

  it('skips the webServer when PLAYWRIGHT_BASE_URL is set, whatever the port', () => {
    expect(resolveWebServer({ PLAYWRIGHT_BASE_URL: 'http://localhost:8788' })).toBeUndefined();
    expect(
      resolveWebServer({ PLAYWRIGHT_BASE_URL: 'https://staging.example', AECI_WEB_PORT: '8790' }),
    ).toBeUndefined();
  });

  it('does not reuse a server in CI', () => {
    expect(resolveWebServer({ CI: 'true' })).toMatchObject({ reuseExistingServer: false });
  });
});

describe('the fail-fast guard script', () => {
  it('exits 1 and tells the agent how to boot its stack', () => {
    const repoRoot = resolve(__dirname, '../../..');
    const [bin, script] = NO_LOCAL_STACK_COMMAND.split(' ');
    const run = spawnSync(bin, [script], {
      cwd: repoRoot,
      env: { ...process.env, AECI_WEB_PORT: '8790' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('http://localhost:8790/api/health');
    expect(run.stderr).toContain('pnpm dev:agent');
  });
});
