/**
 * Argument handling for the Algolia watermark-reset ops script (AECI-880, extended by
 * AECI-636 to take `products` and `vendors`).
 *
 * ─── WHY THIS FILE IS HERE AND NOT NEXT TO THE SCRIPT ────────────────────────
 *
 * `scripts/ops/**` has no test harness of its own. Same arrangement as
 * `strand-classify.spec.ts`: `args.mjs` is a pure function of argv that touches no
 * network, no wrangler and no clock, and the unit lane already runs
 * `environment: 'node'`, so it is imported by relative path. Nothing here reaches D1.
 *
 * The rules under test are the ones that stop a wrong production write: the entity
 * is required and singular, a dry run is the default, and a production write needs a
 * second explicit flag.
 */

import { describe, expect, it } from 'vitest';

import {
  D1_ENVS,
  INDEX_ENTITIES,
  parseArgs,
  // @ts-expect-error — plain-ESM ops module, deliberately untyped; see the header.
} from '../../../../scripts/ops/2026-09-algolia-integration-watermark-reset/args.mjs';

import { INDEX_ENTITIES as SHARED_INDEX_ENTITIES } from '@aeci/shared/algolia';

type Parsed =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; envName: string; target: { db: string }; entity: string; apply: boolean };

const parse = (...argv: string[]) => parseArgs(argv) as Parsed;

describe('watermark-reset args: entity', () => {
  it.each(['products', 'vendors', 'integrations'])('accepts --entity %s', (entity) => {
    const result = parse('--env', 'staging', '--entity', entity);
    expect(result).toMatchObject({ kind: 'run', entity, envName: 'staging' });
  });

  it('accepts the --flag=value form', () => {
    expect(parse('--env=demo', '--entity=vendors')).toMatchObject({
      kind: 'run',
      envName: 'demo',
      entity: 'vendors',
    });
  });

  it('REQUIRES --entity, so an old AECI-880 command cannot silently reset integrations', () => {
    const result = parse('--env', 'staging');
    expect(result.kind).toBe('error');
    expect((result as { message: string }).message).toMatch(/--entity must be one of/);
  });

  it.each(['integration', 'product', 'Products', 'all', 'pairs'])(
    'rejects --entity %s (only the plural keys the sync reads)',
    (entity) => {
      expect(parse('--env', 'staging', '--entity', entity).kind).toBe('error');
    },
  );

  it('rejects a second --entity, so one run resets one field', () => {
    const result = parse('--env', 'staging', '--entity', 'products', '--entity', 'vendors');
    expect(result).toEqual({ kind: 'error', message: '--entity was given more than once.' });
  });

  it('rejects --entity with no value', () => {
    expect(parse('--env', 'staging', '--entity').kind).toBe('error');
    expect(parse('--env', 'staging', '--entity', '--apply').kind).toBe('error');
  });

  it('keeps its entity list in step with @aeci/shared INDEX_ENTITIES', () => {
    expect(INDEX_ENTITIES).toEqual([...SHARED_INDEX_ENTITIES]);
  });
});

describe('watermark-reset args: env', () => {
  it('requires --env', () => {
    expect(parse('--entity', 'products').kind).toBe('error');
  });

  it('rejects an unknown env', () => {
    expect(parse('--env', 'prod', '--entity', 'products').kind).toBe('error');
  });

  it('maps each env to its own D1 database', () => {
    for (const envName of Object.keys(D1_ENVS)) {
      const result = parse('--env', envName, '--entity', 'products');
      expect(result).toMatchObject({ kind: 'run', target: { db: `aeci-app-${envName}` } });
    }
  });
});

describe('watermark-reset args: dry run and the production guard', () => {
  it('is a dry run unless --apply is passed', () => {
    expect(parse('--env', 'staging', '--entity', 'products')).toMatchObject({ apply: false });
    expect(parse('--env', 'staging', '--entity', 'products', '--apply')).toMatchObject({
      apply: true,
    });
  });

  it('allows a production DRY RUN, which only reads', () => {
    expect(parse('--env', 'production', '--entity', 'products')).toMatchObject({
      kind: 'run',
      apply: false,
    });
  });

  it('refuses a production write without --allow-production', () => {
    expect(parse('--env', 'production', '--entity', 'products', '--apply')).toEqual({
      kind: 'error',
      message: 'Refusing to write PRODUCTION without --allow-production.',
    });
  });

  it('allows a production write with --allow-production', () => {
    expect(
      parse('--env', 'production', '--entity', 'vendors', '--apply', '--allow-production'),
    ).toMatchObject({ kind: 'run', envName: 'production', entity: 'vendors', apply: true });
  });

  it('does not need --allow-production for a non-production write', () => {
    expect(parse('--env', 'demo', '--entity', 'products', '--apply')).toMatchObject({
      kind: 'run',
      apply: true,
    });
  });
});

describe('watermark-reset args: everything else', () => {
  it('refuses an unknown flag instead of ignoring it', () => {
    expect(parse('--env', 'staging', '--entity', 'products', '--aply')).toEqual({
      kind: 'error',
      message: 'Unknown argument: --aply',
    });
  });

  it('answers --help and -h before validating anything', () => {
    expect(parse('--help')).toEqual({ kind: 'help' });
    expect(parse('-h', '--env', 'nowhere')).toEqual({ kind: 'help' });
  });
});
