#!/usr/bin/env node
//
// snapshot.mjs — capture both WAF rulesets on the aecintegrations.com zone before
// AECI-659 edits them, and run the ordering precondition the issue calls for.
//
// STRICTLY READ-ONLY. Two GETs, one file written next to this script. This snapshot
// is the revert artifact: apply.mjs has no undo, so re-PATCHing each rule's
// `expression` from here is how you back the change out (see README.md → Rollback).
//
// It also answers the question a bare rule list does not: is there a `skip` custom
// rule ABOVE the scraper rule that would match the newly-added hosts? A Skip action
// terminates ruleset evaluation, so one matching `www.` would make the host-set
// extension land and do nothing. Three preserved rules exist on this zone ("Skip WAF
// for stack-test subdomain", "Block scanner probes", "Blocker 2") and the first is
// exactly that shape — hence the check.
//
// USAGE (needs CF_ZONE_ID + CF_WAF_API_TOKEN; Zone WAF: Read is enough):
//   node scripts/ops/2026-09-waf-host-scope/snapshot.mjs
//   node scripts/ops/2026-09-waf-host-scope/snapshot.mjs --out /tmp/waf.json
//
// Exits 0 when the snapshot is written and the ordering check is clean, 1 when a
// blocking `skip` rule is found, 2 on a usage/credential error.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NEW_HOSTS, RULESETS, TARGETS, UsageError, credentials, getRuleset } from './rules.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      args.out = argv[i + 1];
      if (!args.out) throw new UsageError('--out needs a path');
      i += 1;
    } else {
      throw new UsageError(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function printRuleset(name, ruleset) {
  console.log(
    `\n${name} (${ruleset.id}) — ${ruleset.rules?.length ?? 0} rule(s), version ${ruleset.version}`,
  );
  console.log('  #  id                                action             description');
  (ruleset.rules ?? []).forEach((rule, i) => {
    const enabled = rule.enabled === false ? ' [DISABLED]' : '';
    console.log(
      `  ${String(i).padStart(2)}  ${rule.id}  ${String(rule.action).padEnd(17)}  ${truncate(rule.description ?? '', 60)}${enabled}`,
    );
    console.log(`      ${truncate(rule.expression ?? '', 150)}`);
  });
}

/**
 * A `skip` rule above the scraper rule that could match one of the hosts we are about
 * to add. Expression matching is deliberately crude — a substring test for each new
 * host, plus a flag for any skip rule with no host predicate at all (which matches
 * every host by definition). False positives are cheap; a missed one is not.
 */
function orderingCheck(customRuleset) {
  const rules = customRuleset.rules ?? [];
  const scraperIndex = rules.findIndex((r) => (r.expression ?? '').includes(TARGETS[2].marker));
  if (scraperIndex === -1) {
    return {
      ok: false,
      reason: 'scraper rule not found in the custom ruleset — nothing to order against',
    };
  }
  const risky = rules.slice(0, scraperIndex).filter((rule) => {
    if (rule.action !== 'skip' || rule.enabled === false) return false;
    const expr = rule.expression ?? '';
    if (!expr.includes('http.host')) return true;
    return NEW_HOSTS.some((host) => expr.includes(host));
  });
  return { ok: risky.length === 0, scraperIndex, risky };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { zone, token } = credentials();

  const [ratelimit, custom] = await Promise.all([
    getRuleset(token, zone, RULESETS.ratelimit),
    getRuleset(token, zone, RULESETS.custom),
  ]);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = args.out ?? join(HERE, `snapshot-${stamp}.json`);
  writeFileSync(
    out,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), zone, ratelimit, custom }, null, 2)}\n`,
  );

  printRuleset('Rate-limiting ruleset', ratelimit);
  printRuleset('Custom-rules ruleset', custom);

  console.log(`\nSnapshot written to ${out} (gitignored — it carries live rule expressions).`);

  console.log('\nTarget rules (located by marker):');
  for (const target of TARGETS) {
    const ruleset = target.ruleset === 'ratelimit' ? ratelimit : custom;
    const matches = (ruleset.rules ?? []).filter((r) =>
      (r.expression ?? '').includes(target.marker),
    );
    const state =
      matches.length !== 1
        ? `${matches.length} matches — apply.mjs will abort`
        : matches[0].expression === target.after
          ? 'already-current'
          : matches[0].expression === target.before
            ? 'needs migration'
            : 'DRIFTED from docs/waf-rate-limits.md — apply.mjs will abort';
    console.log(
      `  ${target.key.padEnd(8)} ${matches.length === 1 ? matches[0].id : '(unresolved)'.padEnd(32)}  ${state}`,
    );
  }

  const ordering = orderingCheck(custom);
  if (ordering.ok) {
    console.log(
      `\nOrdering check: clean — no enabled \`skip\` rule above the scraper rule (index ${ordering.scraperIndex}) can match the new hosts.`,
    );
    process.exit(0);
  }

  console.error('\nOrdering check: BLOCKED.');
  if (ordering.reason) console.error(`  ${ordering.reason}`);
  for (const rule of ordering.risky ?? []) {
    console.error(`  skip rule ${rule.id} — ${rule.description ?? '(no description)'}`);
    console.error(`    ${rule.expression}`);
  }
  console.error(
    '\nA Skip action terminates ruleset evaluation. Reorder or re-scope these before applying.',
  );
  process.exit(1);
}

main().catch((err) => {
  if (err instanceof UsageError) {
    console.error(`snapshot.mjs: ${err.message}`);
    process.exit(2);
  }
  console.error(err.stack ?? String(err));
  process.exit(2);
});
