/**
 * Tests for `ConsentService` (AECI-239). `.component.spec.ts` so it runs under
 * `ng test` — needs Angular DI (`PLATFORM_ID`) and the DOM (`localStorage`,
 * `navigator.doNotTrack`). State is read in the constructor, so each test
 * arranges storage / DNT BEFORE injecting the service.
 */
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONSENT_STORAGE_KEY, ConsentService } from './consent';

function inject(platform: 'browser' | 'server' = 'browser'): ConsentService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [{ provide: PLATFORM_ID, useValue: platform }],
  });
  return TestBed.inject(ConsentService);
}

function setDnt(value: string | undefined): void {
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value });
}

beforeEach(() => {
  localStorage.clear();
  setDnt(undefined);
});

afterEach(() => {
  localStorage.clear();
  setDnt(undefined);
});

describe('ConsentService', () => {
  it('is "unknown" with no stored decision and no DNT', () => {
    expect(inject().state()).toBe('unknown');
  });

  it('reads a stored "granted" decision', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    expect(inject().state()).toBe('granted');
  });

  it('reads a stored "denied" decision', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'denied');
    expect(inject().state()).toBe('denied');
  });

  it('treats DNT as a hard "denied", overriding stored consent', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    setDnt('1');
    expect(inject().state()).toBe('denied');
  });

  it('grant() persists and flips the signal', () => {
    const consent = inject();
    consent.grant();
    expect(consent.state()).toBe('granted');
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('granted');
  });

  it('deny() persists and flips the signal', () => {
    const consent = inject();
    consent.deny();
    expect(consent.state()).toBe('denied');
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('denied');
  });

  it('is "unknown" on the server and never touches localStorage', () => {
    localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    const consent = inject('server');
    expect(consent.state()).toBe('unknown');
    consent.grant();
    // Signal flips in-memory, but no write happens on the server.
    expect(consent.state()).toBe('granted');
    expect(localStorage.getItem(CONSENT_STORAGE_KEY)).toBe('granted'); // unchanged by deny path
  });
});
