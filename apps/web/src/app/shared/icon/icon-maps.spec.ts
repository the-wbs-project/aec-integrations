/**
 * AECI-1753 - the vocabulary maps against their source of truth. A data-object
 * slug added to `docs/data-object-vocabulary.json` with no entry here would
 * silently get no icon; this spec makes that a red test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DATA_OBJECT_ICONS, DATA_OBJECT_SLUGS, FACET_ICONS } from './icon-maps';
import { AEC_ICONS } from './icon-registry';

const mirror = JSON.parse(
  readFileSync(join(process.cwd(), '..', '..', 'docs', 'data-object-vocabulary.json'), 'utf8'),
) as { terms: { slug: string }[] };

describe('icon maps', () => {
  it('list exactly the vocabulary slugs', () => {
    expect([...DATA_OBJECT_SLUGS].sort()).toEqual(mirror.terms.map((t) => t.slug).sort());
  });

  it('give every slug a key, and every non-null icon a registry drawing', () => {
    expect(Object.keys(DATA_OBJECT_ICONS).sort()).toEqual([...DATA_OBJECT_SLUGS].sort());
    for (const icon of [...Object.values(DATA_OBJECT_ICONS), ...Object.values(FACET_ICONS)]) {
      if (icon !== null) expect(Object.keys(AEC_ICONS)).toContain(icon);
    }
  });

  it('do not point two slugs at one drawing', () => {
    const used = Object.values(DATA_OBJECT_ICONS).filter((i) => i !== null);
    expect(new Set(used).size).toBe(used.length);
  });
});
