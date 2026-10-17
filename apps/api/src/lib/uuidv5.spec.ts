/** `uuidv5`, moved out of the deleted license back-fill (AECI-1358). */

import { describe, expect, it } from 'vitest';

import { uuidv5 } from './uuidv5';

describe('uuidv5', () => {
  it('matches the RFC 9562 test vector', async () => {
    const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(await uuidv5('www.example.com', DNS)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('mints the same id every run', async () => {
    const NS = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
    expect(await uuidv5('a', NS)).toBe(await uuidv5('a', NS));
    expect(await uuidv5('a', NS)).not.toBe(await uuidv5('b', NS));
  });

  it('rejects a namespace that is not a UUID', async () => {
    await expect(uuidv5('x', 'nope')).rejects.toThrow(RangeError);
  });
});
