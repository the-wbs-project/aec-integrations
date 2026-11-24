import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ZOD_FREE_ROUTES,
  findZodRoutes,
  type ZodCheckMetafile,
} from '../scripts/check-zod-free-routes.mjs';

/**
 * AECI-2033. The build check that keeps zod off the public pages that need none.
 * These cases run on a made-up metafile, so they need no build. The check itself
 * runs against a real build (`pnpm check:zod-free-routes`).
 */
const ZOD = 'chunk-zod.js';
const zodChunk = { inputs: { '../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/index.js': {} } };

function metafile(outputs: ZodCheckMetafile['outputs']): ZodCheckMetafile {
  return { outputs: { [ZOD]: zodChunk, ...outputs } };
}

describe('findZodRoutes', () => {
  it('passes a route whose chunks never import the zod chunk', () => {
    const m = metafile({
      'chunk-home.js': {
        entryPoint: 'src/app/home/home.ts',
        imports: [{ path: 'chunk-shared.js', kind: 'import-statement' }],
        inputs: {},
      },
      'chunk-shared.js': { inputs: {} },
    });
    expect(findZodRoutes(m, ['home/home.ts'])).toEqual({ missing: [], failures: [] });
  });

  it('fails a route that reaches zod through another chunk, and names the path', () => {
    const m = metafile({
      'chunk-home.js': {
        entryPoint: 'src/app/home/home.ts',
        imports: [{ path: 'chunk-schemas.js', kind: 'import-statement' }],
        inputs: {},
      },
      'chunk-schemas.js': { imports: [{ path: ZOD, kind: 'import-statement' }], inputs: {} },
    });
    expect(findZodRoutes(m, ['home/home.ts']).failures).toEqual([
      { route: 'home/home.ts', path: ['chunk-home.js', 'chunk-schemas.js', ZOD] },
    ]);
  });

  it('fails a route that reaches zod code in a chunk without zod/index.js (a zod/v4 import)', () => {
    const m = metafile({
      'chunk-home.js': {
        entryPoint: 'src/app/home/home.ts',
        imports: [{ path: 'chunk-zod-core.js', kind: 'import-statement' }],
        inputs: {},
      },
      'chunk-zod-core.js': {
        inputs: { '../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/core.js': {} },
      },
    });
    expect(findZodRoutes(m, ['home/home.ts']).failures).toEqual([
      { route: 'home/home.ts', path: ['chunk-home.js', 'chunk-zod-core.js'] },
    ]);
  });

  it('fails a route whose own chunk holds zod modules', () => {
    const m = metafile({
      'chunk-home.js': {
        entryPoint: 'src/app/home/home.ts',
        inputs: { '../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/classic/schemas.js': {} },
      },
    });
    expect(findZodRoutes(m, ['home/home.ts']).failures).toEqual([
      { route: 'home/home.ts', path: ['chunk-home.js'] },
    ]);
  });

  it('does not treat a package whose name only starts with zod as zod', () => {
    const m = metafile({
      'chunk-home.js': {
        entryPoint: 'src/app/home/home.ts',
        imports: [{ path: 'chunk-other.js', kind: 'import-statement' }],
        inputs: {},
      },
      'chunk-other.js': {
        inputs: { '../../node_modules/.pnpm/zod-to-x@1.0.0/node_modules/zod-to-x/index.js': {} },
      },
    });
    expect(findZodRoutes(m, ['home/home.ts']).failures).toEqual([]);
  });

  it('ignores a dynamic import, because a lazy load is not fetched while the page hydrates', () => {
    const m = metafile({
      'chunk-home.js': {
        entryPoint: 'src/app/home/home.ts',
        imports: [{ path: ZOD, kind: 'dynamic-import' }],
        inputs: {},
      },
    });
    expect(findZodRoutes(m, ['home/home.ts']).failures).toEqual([]);
  });

  it('reports a listed route that has no chunk, so a renamed file cannot pass silently', () => {
    expect(findZodRoutes(metafile({}), ['home/home.ts']).missing).toEqual(['home/home.ts']);
  });
});

describe('ZOD_FREE_ROUTES', () => {
  it('names only route files that exist', () => {
    for (const route of ZOD_FREE_ROUTES) {
      expect(existsSync(join(process.cwd(), 'src', 'app', route)), route).toBe(true);
    }
  });
});
