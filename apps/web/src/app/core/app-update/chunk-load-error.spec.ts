import { describe, expect, it } from 'vitest';

import { isChunkLoadError } from './chunk-load-error';

describe('isChunkLoadError', () => {
  it.each([
    'Failed to fetch dynamically imported module: https://www.aecintegrations.com/chunk-ABC.js',
    'error loading dynamically imported module: https://www.aecintegrations.com/chunk-ABC.js',
    'Importing a module script failed.',
    'NG0750: Loading dependencies for `@defer` block failed',
    'NG0750',
  ])('matches %s', (message) => {
    expect(isChunkLoadError(new TypeError(message))).toBe(true);
  });

  it('matches a production RuntimeError by its code alone', () => {
    expect(isChunkLoadError(Object.assign(new Error(''), { code: -750 }))).toBe(true);
  });

  it('matches a bare string', () => {
    expect(isChunkLoadError('Importing a module script failed.')).toBe(true);
  });

  it.each([
    null,
    undefined,
    {},
    new Error('Cannot read properties of undefined'),
    new Error('NG07500 is not a code'),
    Object.assign(new Error('x'), { code: -751 }),
  ])('ignores %s', (error) => {
    expect(isChunkLoadError(error)).toBe(false);
  });
});
