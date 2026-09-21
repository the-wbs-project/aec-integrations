// args.mjs — argument handling for reset-watermark.mjs, kept pure so it can be tested.
//
// `scripts/ops/**` has no test harness of its own. Like the strand audit's
// `classify.mjs`, this module touches no network, no wrangler and no clock, so
// `apps/api/src/test/watermark-reset-args.spec.ts` imports it by relative path.
//
// The rules it enforces:
//
//   - `--entity` is REQUIRED and names exactly one entity. The script resets one
//     field of one row per run. Two entities means two runs, which keeps each
//     compare-and-swap about one field. There is no default, so a command copied
//     from the AECI-880 run cannot silently reset `integrations` again.
//   - `--env` is required.
//   - Dry run unless `--apply`.
//   - `--apply` on `--env production` is refused without `--allow-production`.
//     A production DRY RUN is allowed: it only reads.
//   - Unknown flags are refused, so a typo such as `--entitiy` fails loudly
//     instead of being ignored.

/** Must match `INDEX_ENTITIES` in `packages/shared/src/algolia.ts`. */
export const INDEX_ENTITIES = ['products', 'vendors', 'integrations'];

/** The D1 databases this script may target, with the wrangler flags for each. */
export const D1_ENVS = {
  preview: { db: 'aeci-app-preview', flags: ['--env', 'preview'] },
  staging: { db: 'aeci-app-staging', flags: ['--env', 'staging'] },
  demo: { db: 'aeci-app-demo', flags: ['--env', 'demo'] },
  production: { db: 'aeci-app-production', flags: ['--env', 'production'] },
};

const VALUE_FLAGS = ['--env', '--entity'];
const BOOLEAN_FLAGS = ['--apply', '--allow-production', '--help', '-h'];

/**
 * Parse argv (without the node and script paths).
 *
 * Returns one of:
 *   { kind: 'help' }
 *   { kind: 'error', message }
 *   { kind: 'run', envName, target, entity, apply }
 */
export function parseArgs(argv) {
  const values = {};
  const booleans = new Set();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);

    if (VALUE_FLAGS.includes(name)) {
      let value;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else {
        value = argv[i + 1];
        i += 1;
      }
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { kind: 'error', message: `${name} needs a value.` };
      }
      if (name in values) {
        return { kind: 'error', message: `${name} was given more than once.` };
      }
      values[name] = value.trim();
      continue;
    }

    if (BOOLEAN_FLAGS.includes(arg)) {
      booleans.add(arg);
      continue;
    }

    return { kind: 'error', message: `Unknown argument: ${arg}` };
  }

  if (booleans.has('--help') || booleans.has('-h')) return { kind: 'help' };

  const envName = values['--env'];
  const target = envName === undefined ? undefined : D1_ENVS[envName];
  if (!target) {
    return {
      kind: 'error',
      message: `--env must be one of: ${Object.keys(D1_ENVS).join(', ')}. Got: ${envName ?? '(unset)'}`,
    };
  }

  const entity = values['--entity'];
  if (!INDEX_ENTITIES.includes(entity)) {
    return {
      kind: 'error',
      message: `--entity must be one of: ${INDEX_ENTITIES.join(', ')}. Got: ${entity ?? '(unset)'}`,
    };
  }

  const apply = booleans.has('--apply');
  if (apply && envName === 'production' && !booleans.has('--allow-production')) {
    return { kind: 'error', message: 'Refusing to write PRODUCTION without --allow-production.' };
  }

  return { kind: 'run', envName, target, entity, apply };
}
