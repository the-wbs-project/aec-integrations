#!/usr/bin/env node
//
// apply.mjs — extend the three AECI-659 WAF rules to the production host set.
//
// DRY-RUN BY DEFAULT. Nothing is written without --apply.
//
// It rewrites ONLY the `expression` of three existing rules. It never creates,
// deletes, reorders, or re-tunes anything: the action, the ratelimit block (IP
// characteristic, 5 / 60 s, 3600 s mitigation timeout) and the Managed Challenge on
// the scraper rule are carried through verbatim from the live rule. Pro caps the zone
// at 2 rate-limit rules and both slots are already spent, which is why Rule A's path
// predicate is WIDENED to absorb /api/subscribe and /api/feedback rather than a third
// rule being added.
//
// Each rule is updated with its own PATCH /rulesets/{id}/rules/{rule_id} — never a
// whole-ruleset PUT, which would put the three preserved custom rules ("Skip WAF for
// stack-test subdomain", "Block scanner probes", "Blocker 2") and their ORDER at risk.
//
// The expressions are not computed by string surgery on whatever is live. rules.mjs
// declares the exact `before` and `after` forms transcribed from docs/waf-rate-limits.md,
// and a live rule matching neither is treated as drift and aborts the whole run — no
// partial applies, no invented expression. Run snapshot.mjs first; it reports the same
// state non-destructively and is the revert artifact.
//
// USAGE (needs CF_ZONE_ID + CF_WAF_API_TOKEN):
//   node scripts/ops/2026-09-waf-host-scope/apply.mjs            # dry run, Zone WAF: Read
//   node scripts/ops/2026-09-waf-host-scope/apply.mjs --apply    # writes, Zone WAF: Edit
//
// Exits 0 when nothing is left to do (or --apply succeeded), 1 when a dry run found
// changes to make, 2 on a usage/credential/drift error.

import {
  RULESETS,
  TARGETS,
  UsageError,
  cf,
  credentials,
  getRuleset,
  writableRule,
} from './rules.mjs';

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv) {
    if (arg === '--apply') args.apply = true;
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return args;
}

/** Before/after, one line each. The expressions are single-line, so that IS the diff. */
function printExpressionDiff(before, after) {
  console.log(`    - ${before}`);
  console.log(`    + ${after}`);
}

function resolve(ruleset, target) {
  const matches = (ruleset.rules ?? []).filter((rule) =>
    (rule.expression ?? '').includes(target.marker),
  );
  if (matches.length === 0) {
    throw new UsageError(
      `${target.key}: no rule in ruleset ${ruleset.id} matches the marker ${JSON.stringify(target.marker)}.\n` +
        '  Run snapshot.mjs and reconcile docs/waf-rate-limits.md with the live zone before retrying.',
    );
  }
  if (matches.length > 1) {
    throw new UsageError(
      `${target.key}: ${matches.length} rules match the marker ${JSON.stringify(target.marker)} ` +
        `(${matches.map((r) => r.id).join(', ')}). Refusing to guess.`,
    );
  }
  const rule = matches[0];
  if (rule.expression === target.after) return { rule, status: 'already-current' };
  if (rule.expression === target.before) return { rule, status: 'needs-migration' };
  throw new UsageError(
    `${target.key} (rule ${rule.id}): live expression matches neither the documented before nor after form.\n` +
      `  live:   ${rule.expression}\n` +
      `  before: ${target.before}\n` +
      `  after:  ${target.after}\n` +
      '  Someone edited this rule outside docs/waf-rate-limits.md. Reconcile the doc + rules.mjs first — ' +
      'this script will not overwrite an expression it does not recognise.',
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { zone, token } = credentials();

  const [ratelimit, custom] = await Promise.all([
    getRuleset(token, zone, RULESETS.ratelimit),
    getRuleset(token, zone, RULESETS.custom),
  ]);
  const rulesets = { ratelimit, custom };

  // Resolve ALL three before writing ANY, so a drifted third rule cannot leave the
  // zone half-migrated.
  const plan = TARGETS.map((target) => ({ target, ...resolve(rulesets[target.ruleset], target) }));

  const pending = plan.filter((step) => step.status === 'needs-migration');

  console.log(`Zone ${zone} — ${args.apply ? 'APPLY' : 'dry run (pass --apply to write)'}\n`);
  for (const step of plan) {
    console.log(`  ${step.target.key}  ${step.rule.id}  ${step.status}`);
    console.log(`    ${step.target.label}`);
    if (step.status === 'needs-migration') {
      printExpressionDiff(step.rule.expression, step.target.after);
      if (step.target.description && step.target.description !== step.rule.description) {
        console.log('    description:');
        console.log(`    - ${step.rule.description}`);
        console.log(`    + ${step.target.description}`);
      }
    }
    console.log('');
  }

  if (pending.length === 0) {
    console.log('Nothing to do — all three rules already carry the production host set.');
    process.exit(0);
  }

  if (!args.apply) {
    console.log(
      `${pending.length} rule(s) would be updated. Re-run with --apply (needs Zone WAF: Edit).`,
    );
    process.exit(1);
  }

  for (const step of pending) {
    const rulesetId = RULESETS[step.target.ruleset];
    await cf(token, `/zones/${zone}/rulesets/${rulesetId}/rules/${step.rule.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...writableRule(step.rule),
        expression: step.target.after,
        ...(step.target.description ? { description: step.target.description } : {}),
      }),
    });
    console.log(`  applied ${step.target.key} (${step.rule.id})`);
  }

  console.log(
    `\n${pending.length} rule(s) updated. Now run verify.mjs — expect 403/200 on all four hosts — and record the ` +
      'result in docs/waf-rate-limits.md "Deployed state".',
  );
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`apply.mjs: ${err.message}`);
    process.exit(2);
  }
  console.error(err.stack ?? String(err));
  process.exit(2);
});
