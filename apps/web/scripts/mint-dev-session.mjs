#!/usr/bin/env node
/**
 * Mint a real Supabase session for local auth testing (AECI-193).
 *
 * Signs in the shared-dev test user with the password grant and prints:
 *   - the decoded access-token JWT header (the ES256-vs-HS256 signing gate),
 *   - sub / email / exp,
 *   - the raw access token (for `Authorization: Bearer …` against the API Worker),
 *   - a ready-to-paste `Cookie:` header (for `GET /auth/whoami` on the SSR Worker).
 *
 * The cookie jar is capture-only: `createServerClient`'s own storage adapter
 * does the encoding and chunking (`sb-<ref>-auth-token[.0/.1]`, `base64-`
 * prefix), so what we print is byte-for-byte what a browser would send back.
 *
 * Usage (from apps/web; Node 24's --env-file reads .dev.vars):
 *   node --env-file=.dev.vars scripts/mint-dev-session.mjs
 *
 * Required env: SUPABASE_URL, SUPABASE_ANON_KEY,
 *               SUPABASE_TEST_USER_EMAIL, SUPABASE_TEST_USER_PASSWORD.
 * See .dev.vars.example. This is a kept dev tool, not throwaway — the 200-path
 * smoke for /auth/whoami needs it until real login UI lands (Phase 5.3).
 */

import { createServerClient } from '@supabase/ssr';

const required = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_TEST_USER_EMAIL',
  'SUPABASE_TEST_USER_PASSWORD',
];
const missing = required.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`Missing env: ${missing.join(', ')}`);
  console.error('Run from apps/web as: node --env-file=.dev.vars scripts/mint-dev-session.mjs');
  process.exit(1);
}

/** Capture-only cookie jar — lets the library's encoder/chunker produce the cookies. */
const jar = new Map();

const supabase = createServerClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  cookies: {
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    setAll: (cookies) => {
      for (const { name, value } of cookies) jar.set(name, value);
    },
  },
});

const { data, error } = await supabase.auth.signInWithPassword({
  email: process.env.SUPABASE_TEST_USER_EMAIL,
  password: process.env.SUPABASE_TEST_USER_PASSWORD,
});

if (error || !data.session) {
  console.error('Sign-in failed:', error?.message ?? 'no session returned');
  process.exit(1);
}

const { access_token: accessToken, expires_at: expiresAt } = data.session;
const [rawHeader, rawPayload] = accessToken.split('.');
const header = JSON.parse(Buffer.from(rawHeader, 'base64url').toString('utf8'));
const payload = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8'));

console.log('── JWT header (the ES256 gate) ─────────────────────────────');
console.log(JSON.stringify(header, null, 2));
console.log('');
console.log('── Claims ──────────────────────────────────────────────────');
console.log(`sub:   ${payload.sub}`);
console.log(`email: ${payload.email}`);
console.log(`exp:   ${payload.exp} (${new Date(payload.exp * 1000).toISOString()})`);
console.log(`iss:   ${payload.iss}`);
console.log(`aud:   ${payload.aud}`);
console.log('');
console.log('── Access token (Authorization: Bearer …) ──────────────────');
console.log(accessToken);
console.log('');
console.log('── Cookie header (paste into curl) ─────────────────────────');
console.log([...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '));
console.log('');
console.log(`Session expires at ${new Date((expiresAt ?? 0) * 1000).toISOString()}`);
