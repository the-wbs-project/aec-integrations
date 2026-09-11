/**
 * `lib/request-links.ts` (AECI-860/861) — the deployment host and the admin deep
 * link that the Linear description, the operator email and the staleness digest
 * all read from one place.
 *
 * The cases that matter are the degenerate ones. Every function has to survive an
 * unset or malformed `PUBLIC_SITE_URL` by returning `null`, because all three
 * callers run inside fail-open paths: a bad var must cost a description row, never
 * an issue.
 */

import { describe, expect, it } from 'vitest';

import {
  NOTIFIED_REQUEST_KINDS,
  adminRequestUrl,
  environmentHost,
  siteBaseUrl,
} from './request-links';
import type { Env } from '../env';

const envWith = (url?: string) => ({ PUBLIC_SITE_URL: url }) as unknown as Env;

describe('siteBaseUrl', () => {
  it('trims whitespace and a trailing slash', () => {
    expect(siteBaseUrl(envWith('  https://demo.aecintegrations.com/  '))).toBe(
      'https://demo.aecintegrations.com',
    );
  });

  it('is null when PUBLIC_SITE_URL is unset or blank', () => {
    expect(siteBaseUrl(envWith(undefined))).toBeNull();
    expect(siteBaseUrl(envWith('   '))).toBeNull();
  });
});

describe('environmentHost', () => {
  it.each([
    ['https://demo.aecintegrations.com', 'demo.aecintegrations.com'],
    ['https://www.aecintegrations.com', 'www.aecintegrations.com'],
    ['https://staging.aecintegrations.com', 'staging.aecintegrations.com'],
  ])('reads the host out of %s', (url, host) => {
    expect(environmentHost(envWith(url))).toBe(host);
  });

  it('strips a path but keeps a port', () => {
    expect(environmentHost(envWith('http://localhost:8788/some/path'))).toBe('localhost:8788');
  });

  it('is null rather than throwing on a malformed URL', () => {
    // The whole point: a fat-fingered wrangler var must not take issue creation
    // down, it must cost one row in the description.
    expect(environmentHost(envWith('not a url'))).toBeNull();
  });

  it('is null when PUBLIC_SITE_URL is unset', () => {
    expect(environmentHost(envWith(undefined))).toBeNull();
  });
});

describe('adminRequestUrl', () => {
  it('points a claim at the AECI-739 detail page, keyed on the request id', () => {
    expect(adminRequestUrl(envWith('https://www.aecintegrations.com'), 'claim', 'req-1')).toBe(
      'https://www.aecintegrations.com/admin/claims/req-1',
    );
  });

  it('points a correction at the queue, because it has no detail route', () => {
    // Linking a correction to /admin/claims/:id would 404 — worse than the queue.
    expect(adminRequestUrl(envWith('https://www.aecintegrations.com'), 'correction', 'req-1')).toBe(
      'https://www.aecintegrations.com/admin/requests',
    );
  });

  it('is null when PUBLIC_SITE_URL is unset', () => {
    expect(adminRequestUrl(envWith(undefined), 'claim', 'req-1')).toBeNull();
  });
});

describe('NOTIFIED_REQUEST_KINDS', () => {
  it('is claims only, and corrections stay out', () => {
    // Guards the AECI-861 scope decision. Widening this is a deliberate act, so
    // it should break a test rather than slip through unnoticed.
    expect([...NOTIFIED_REQUEST_KINDS]).toEqual(['claim']);
    expect(NOTIFIED_REQUEST_KINDS.has('correction')).toBe(false);
  });
});
