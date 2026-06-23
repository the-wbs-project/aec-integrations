/**
 * Tests for `analyticsDimensions()` (AECI-239). `.component.spec.ts` so it runs
 * under `ng test` where a DOM (`<html>`) exists. Verifies the locale/theme reads
 * and the shipping defaults.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { analyticsDimensions } from './analytics-dimensions';

afterEach(() => {
  document.documentElement.lang = '';
  delete document.documentElement.dataset['theme'];
});

describe('analyticsDimensions', () => {
  it('defaults to en-US + light when <html> carries no lang/data-theme', () => {
    document.documentElement.lang = '';
    delete document.documentElement.dataset['theme'];
    expect(analyticsDimensions()).toEqual({ locale: 'en-US', theme: 'light' });
  });

  it('reads the live <html lang> when present', () => {
    document.documentElement.lang = 'de-DE';
    expect(analyticsDimensions().locale).toBe('de-DE');
  });

  it('reads data-theme when present (forward-compatible with dark)', () => {
    document.documentElement.dataset['theme'] = 'dark';
    expect(analyticsDimensions().theme).toBe('dark');
  });
});
