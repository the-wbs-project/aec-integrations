import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1892): `public/_headers` serves `/fonts/*` with a one-year immutable
 * Cache-Control, so a browser that has a font file never asks for it again. A file
 * whose bytes change under the same name would reach new visitors only: everyone
 * else keeps the old file for a year. So each file's bytes are pinned here, and a
 * new font version ships under a new name (`-v16-` for a new Google Fonts version).
 *
 * The pinned files are the Google Fonts subsets, unmodified (checked against
 * fonts.gstatic.com on 2026-11-17).
 */
const here = dirname(fileURLToPath(import.meta.url));
const fontsDir = join(here, '..', 'public', 'fonts');

const PINNED: Record<string, string> = {
  'atkinson-hyperlegible-next-italic-v7-latin-ext.woff2':
    '871436be3c2e0104442463df5eabe7eaef5e0172cb6715a720156ef76f70e1ff',
  'atkinson-hyperlegible-next-italic-v7-latin.woff2':
    '6e221fe2869a755fdce1ba6c3517f392c3a218d642e1d0207ed2826713db7263',
  'atkinson-hyperlegible-next-v7-latin-ext.woff2':
    'ca1969afa9058a41ced4a08bd54f48835cfe79dc6ccf9050dca7da85c9e0a9d9',
  'atkinson-hyperlegible-next-v7-latin.woff2':
    '1e4cea71d75ec427581d6259fc07148a2e60d60d16cabf4b4f5360487b3f9dc3',
  'source-serif-4-v15-cyrillic-ext.woff2':
    '70cc942deab2bfc3eb3cbf9bc9b6b3619940455801ff4e7fb1d1bb6c299952be',
  'source-serif-4-v15-cyrillic.woff2':
    '0d80484ffba8594556f982540b1823dc076eee94896061d94948d37568bb6f51',
  'source-serif-4-v15-greek.woff2':
    '94be9743efdc668b1ff911d7b24909d5fd2b459b3a023eb77411a1fd8f72cbc9',
  'source-serif-4-v15-latin-ext.woff2':
    'c9299a71605a28de5733eca4a2fe18b6c94dd816bf932716a4f042e48c9b3071',
  'source-serif-4-v15-latin.woff2':
    '2a24bad466f09b88b8e9cbc488bf774117c912e66374c57bf4716855849143f8',
  'source-serif-4-v15-vietnamese.woff2':
    '653070ebe149cd3fdb166e00bdee6182296db78a18af75c9a9fecec791872d70',
};

const files = readdirSync(fontsDir).filter((f) => f.endsWith('.woff2'));
const indexHtml = readFileSync(join(here, 'index.html'), 'utf8');
const named = new Set([...indexHtml.matchAll(/url\(\/fonts\/([^)]+\.woff2)\)/g)].map((m) => m[1]));

describe('self-hosted font files (AECI-1892)', () => {
  it('never change under their name: a changed file needs a new name', () => {
    for (const file of files) {
      const sha = createHash('sha256')
        .update(readFileSync(join(fontsDir, file)))
        .digest('hex');
      expect(
        PINNED[file],
        `${file} is not pinned. A new font file needs a new name and an entry here.`,
      ).toBeDefined();
      expect(
        sha,
        `${file} changed under the same name. Browsers cache /fonts/* for a year: ship it under a new name.`,
      ).toBe(PINNED[file]);
    }
  });

  it('carry a version in the name', () => {
    for (const file of files) expect(file, file).toMatch(/-v\d+-[a-z-]+\.woff2$/);
  });

  it('are the files index.html names, no more and no fewer', () => {
    expect([...named].sort()).toEqual([...files].sort());
  });

  it('keep the one-year immutable rule in public/_headers', () => {
    const headers = readFileSync(join(here, '..', 'public', '_headers'), 'utf8');
    expect(headers).toMatch(
      /^\/fonts\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m,
    );
  });
});
