import { afterEach, describe, expect, it, vi } from 'vitest';

import { BROWSER_EVIDENCE_URL } from '@aeci/shared';

import {
  browserEvidenceEnabled,
  cfRayFromServerTiming,
  postBrowserEvidence,
  readLandingCfRay,
} from './browser-evidence-config';

// Plain Node vitest: no `window`; `navigator`, `performance` and `fetch` are stubbed per test.
type G = { __AECI_BROWSER_EVIDENCE__?: unknown };

const RAY = '8f2a1b3c4d5e6f70-SIN';

function stubTiming(serverTiming: unknown): void {
  vi.stubGlobal('performance', {
    getEntriesByType: () => (serverTiming === undefined ? [{}] : [{ serverTiming }]),
  });
}

function turnOn(): void {
  (globalThis as G).__AECI_BROWSER_EVIDENCE__ = { enabled: true };
  vi.stubGlobal('navigator', { doNotTrack: null });
  stubTiming([{ name: 'cfray', description: RAY }]);
}

afterEach(() => {
  delete (globalThis as G).__AECI_BROWSER_EVIDENCE__;
  vi.unstubAllGlobals();
});

describe('browserEvidenceEnabled (AECI-1714)', () => {
  it('sends with the tier flag, no privacy signal and clean timing', () => {
    turnOn();
    expect(browserEvidenceEnabled()).toBe(true);
  });

  it('sends nothing with no flag (the production state until AECI-1715)', () => {
    turnOn();
    delete (globalThis as G).__AECI_BROWSER_EVIDENCE__;
    expect(browserEvidenceEnabled()).toBe(false);
  });

  it.each([null, {}, { enabled: 'true' }, { enabled: 1 }, true])(
    'sends nothing for a malformed flag %j',
    (value) => {
      turnOn();
      (globalThis as G).__AECI_BROWSER_EVIDENCE__ = value;
      expect(browserEvidenceEnabled()).toBe(false);
    },
  );

  it('sends nothing with Do-Not-Track', () => {
    turnOn();
    vi.stubGlobal('navigator', { doNotTrack: '1' });
    expect(browserEvidenceEnabled()).toBe(false);
  });

  it('sends nothing with Global Privacy Control', () => {
    turnOn();
    vi.stubGlobal('navigator', { globalPrivacyControl: true, doNotTrack: null });
    expect(browserEvidenceEnabled()).toBe(false);
  });

  it('sends nothing when the gateway stamped geo=eu (ruling 21)', () => {
    turnOn();
    stubTiming([
      { name: 'cfray', description: RAY },
      { name: 'geo', description: 'eu' },
    ]);
    expect(browserEvidenceEnabled()).toBe(false);
  });

  it('fails closed when the browser exposes no serverTiming', () => {
    turnOn();
    stubTiming(undefined);
    expect(browserEvidenceEnabled()).toBe(false);
  });

  it('fails closed with no performance API', () => {
    turnOn();
    vi.stubGlobal('performance', undefined);
    expect(browserEvidenceEnabled()).toBe(false);
  });

  it('sends with an empty timing list: nothing was stamped', () => {
    turnOn();
    stubTiming([]);
    expect(browserEvidenceEnabled()).toBe(true);
  });
});

describe('readLandingCfRay', () => {
  it('reads the cfray entry', () => {
    stubTiming([{ name: 'cfray', description: RAY }]);
    expect(readLandingCfRay()).toBe(RAY);
  });

  it.each([
    ['no entry', []],
    ['a malformed ray', [{ name: 'cfray', description: 'not-a-ray' }]],
  ])('returns null for %s', (_label, timing) => {
    stubTiming(timing);
    expect(readLandingCfRay()).toBeNull();
  });
});

describe('cfRayFromServerTiming', () => {
  it.each([
    [`cfray;desc="${RAY}"`, RAY],
    [`cfray;desc=${RAY}`, RAY],
    [`app;dur=12, cfray;desc="${RAY}", geo;desc="eu"`, RAY],
    [`cfray ; desc = "${RAY}"`, RAY],
    ['cfray;dur=1', null],
    ['cfray;desc="bad ray"', null],
    [`other;desc="${RAY}"`, null],
    ['', null],
    [null, null],
  ])('%j → %j', (header, expected) => {
    expect(cfRayFromServerTiming(header)).toBe(expected);
  });
});

describe('postBrowserEvidence', () => {
  it('posts { cf_ray, evidence } with keepalive and same-origin credentials', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const fetchMock = vi.fn(() => Promise.resolve({ body: { cancel } }));
    vi.stubGlobal('fetch', fetchMock);
    postBrowserEvidence(RAY, 'interacted');
    expect(fetchMock).toHaveBeenCalledWith(BROWSER_EVIDENCE_URL, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cf_ray: RAY, evidence: 'interacted' }),
    });
    await vi.waitFor(() => expect(cancel).toHaveBeenCalled());
  });

  it('swallows a rejected fetch and a missing fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    expect(() => postBrowserEvidence(RAY, 'ran')).not.toThrow();
    vi.stubGlobal('fetch', undefined);
    expect(() => postBrowserEvidence(RAY, 'ran')).not.toThrow();
    await Promise.resolve();
  });
});
