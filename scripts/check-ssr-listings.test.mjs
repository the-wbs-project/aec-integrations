/**
 * `scripts/check-ssr-listings.sh`, the AECI-746 crawler-visibility probe that the
 * promote workflows run after their smoke step (AECI-840). Runs under `node --test`
 * from root `pnpm test:scripts`. Every request goes to a local fixture server.
 *
 * The exit code is the contract the workflows read: 0 verified, 1 a real finding,
 * 2 could not check (retried by the caller). Each case below pins one path to it.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const SCRIPT = join(process.cwd(), 'scripts', 'check-ssr-listings.sh');

const LINKS = '<a href="/products/procore">Procore</a><a href="/products/autodesk-build">Build</a>';

/** What the server sends per page path. Each test sets its own. */
let handler = () => ({ status: 200, body: LINKS });
/** The headers on every request the server saw, for the token test. */
let seen = [];

let server;
let port;

before(async () => {
  server = createServer((req, res) => {
    seen.push(req.headers);
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/login') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>Sign in</html>');
      return;
    }
    const { status, body = '', headers = {} } = handler(url.pathname + url.search);
    res.writeHead(status, { 'content-type': 'text/html', ...headers });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(() => new Promise((resolve) => server.close(resolve)));

function run(base, env = {}) {
  return new Promise((resolve) => {
    execFile(
      'bash',
      [SCRIPT, base],
      { env: { PATH: process.env.PATH, ...env }, timeout: 60_000 },
      (error, stdout) => resolve({ code: error ? error.code : 0, stdout }),
    );
  });
}

const base = () => `http://127.0.0.1:${port}`;

test('every page 200 with product links: exit 0', async () => {
  handler = () => ({ status: 200, body: LINKS });
  const { code, stdout } = await run(base());
  assert.equal(code, 0, stdout);
  assert.match(stdout, /RESULT: PASS/);
});

test('one page answers 403: exit 1, a finding not a skip', async () => {
  handler = (p) => (p === '/products' ? { status: 403, body: 'challenge' } : { status: 200, body: LINKS });
  const { code, stdout } = await run(base());
  assert.equal(code, 1, stdout);
  assert.match(stdout, /FAIL \(HTTP 403/);
});

test('a 200 page renders the error branch: exit 1', async () => {
  handler = (p) =>
    p === '/phases/construction' ? { status: 200, body: `${LINKS} Couldn't load products` } : { status: 200, body: LINKS };
  const { code, stdout } = await run(base());
  assert.equal(code, 1, stdout);
  assert.match(stdout, /renders the error message/);
});

test('a 200 page has zero product links: exit 1', async () => {
  handler = (p) => (p.startsWith('/categories/') ? { status: 200, body: '<html></html>' } : { status: 200, body: LINKS });
  const { code, stdout } = await run(base());
  assert.equal(code, 1, stdout);
  assert.match(stdout, /no product links for crawlers/);
});

test('nothing listening: exit 2, could not check', async () => {
  // Port 1 is privileged and never bound in CI, so the connect is refused.
  const { code, stdout } = await run('http://127.0.0.1:1');
  assert.equal(code, 2, stdout);
  assert.match(stdout, /RESULT: COULD NOT CHECK/);
});

test('a redirect to another host (an Access login): exit 1, names the host', async () => {
  // 127.0.0.1 and localhost are different hosts to the script, same server here.
  handler = () => ({ status: 302, headers: { location: `http://localhost:${port}/login` } });
  const { code, stdout } = await run(base());
  assert.equal(code, 1, stdout);
  assert.match(stdout, new RegExp(`redirected off-host to localhost:${port}`));
});

test('a same-host redirect is followed and graded on the final page', async () => {
  handler = (p) =>
    p === '/products' ? { status: 301, headers: { location: '/products?sort=name' } } : { status: 200, body: LINKS };
  const { code, stdout } = await run(base());
  assert.equal(code, 0, stdout);
});

test('Access token headers are sent only when both env vars are set', async () => {
  handler = () => ({ status: 200, body: LINKS });

  seen = [];
  await run(base(), { CF_ACCESS_CLIENT_ID: 'id-123', CF_ACCESS_CLIENT_SECRET: 'secret-456' });
  assert.equal(seen.length, 5);
  for (const h of seen) {
    assert.equal(h['cf-access-client-id'], 'id-123');
    assert.equal(h['cf-access-client-secret'], 'secret-456');
  }

  seen = [];
  await run(base(), { CF_ACCESS_CLIENT_ID: 'id-123' });
  assert.equal(seen.length, 5);
  for (const h of seen) {
    assert.equal(h['cf-access-client-id'], undefined);
    assert.equal(h['cf-access-client-secret'], undefined);
  }
});
