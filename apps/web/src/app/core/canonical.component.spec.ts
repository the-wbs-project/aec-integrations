/**
 * Unit coverage for the canonical-URL helper (AECI-147 / ADR 0011). Named
 * `.component.spec.ts` so it runs under the TestBed (`ng test`) runner — the
 * helper calls `inject()` and must execute in an injection context.
 */
import { DOCUMENT } from '@angular/common';
import { REQUEST, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalUrl, servingOrigin } from './canonical';

/** Run `fn` in an injection context configured with `providers`. */
function inContext<T>(providers: Provider[], fn: () => T): T {
  TestBed.configureTestingModule({ providers });
  return TestBed.runInInjectionContext(fn);
}

/** A minimal DOCUMENT stub exposing only the `defaultView.location.origin` the helper reads. */
function docWithOrigin(origin: string | null): Provider {
  return {
    provide: DOCUMENT,
    useValue: { defaultView: origin === null ? null : { location: { origin } } },
  };
}

describe('canonicalUrl / servingOrigin', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('uses the SSR REQUEST origin when present (server render)', () => {
    const origin = inContext(
      [
        {
          provide: REQUEST,
          useValue: new Request('https://demo.aecintegrations.com/anything?x=1'),
        },
      ],
      () => servingOrigin(),
    );
    expect(origin).toBe('https://demo.aecintegrations.com');
  });

  it('builds an absolute canonical from the REQUEST origin', () => {
    const url = inContext(
      [{ provide: REQUEST, useValue: new Request('https://staging.aecintegrations.com/x') }],
      () => canonicalUrl('/products'),
    );
    expect(url).toBe('https://staging.aecintegrations.com/products');
  });

  it('falls back to the DOM location.origin when REQUEST is absent (client/hydration)', () => {
    const url = inContext(
      [{ provide: REQUEST, useValue: null }, docWithOrigin('https://demo.aecintegrations.com')],
      () => canonicalUrl('/audiences'),
    );
    expect(url).toBe('https://demo.aecintegrations.com/audiences');
  });

  it('falls back to the production apex when neither REQUEST nor a DOM location exists (prerender)', () => {
    const url = inContext([{ provide: REQUEST, useValue: null }, docWithOrigin(null)], () =>
      canonicalUrl('/categories'),
    );
    expect(url).toBe('https://aecintegrations.com/categories');
  });

  it('tolerates a path with no leading slash', () => {
    const url = inContext([{ provide: REQUEST, useValue: new Request('https://x.test/y') }], () =>
      canonicalUrl('phases'),
    );
    expect(url).toBe('https://x.test/phases');
  });
});
