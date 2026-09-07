# 2026-09 WAF `prod.` host removal (AECI-807)

Drop **`prod.aecintegrations.com`** from the host set of the three Cloudflare WAF rules
on the `aecintegrations.com` zone, because AECI-807 retires that hostname.

`docs/waf-rate-limits.md` is the source of truth for the rule definitions. This
directory is the mechanism that gets them onto the zone — nothing here invents a rule.

This is the **second** migration of these same three rules. The first is
[`../2026-09-waf-host-scope/`](../2026-09-waf-host-scope/README.md) (AECI-659), which
widened them from `staging.` + `demo.` to also cover `www.` and `prod.`. Its
`before`/`after` pair is the historical record of that operation and is deliberately
left untouched; **this directory's `before` is that directory's `after`.** Run them in
order. `apply.mjs` here aborts on a rule still carrying the pre-AECI-659 two-host form
rather than skipping a generation.

## What changes

The host set, on all three rules:

```
- {"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com" "prod.aecintegrations.com"}
+ {"staging.aecintegrations.com" "demo.aecintegrations.com" "www.aecintegrations.com"}
```

Nothing else. Not the paths, not the UA list, not the action, not the thresholds, not
the descriptions. AECI-659 rewrote Rule A's description because folding in the
lead-capture endpoints made its old label false; narrowing a host set makes no label
false — none of the three names a host — so `rules.mjs` declares no `description` here
and a run leaves all three exactly as they are.

## Why bother, if the host is gone anyway

A dead host in a rule expression matches nothing, so this is not a coverage fix. It is
a staleness fix, and it is the same defect AECI-659 existed to close, read from the
other direction: that issue happened because nobody updated the expressions when
production **moved to** `www.`. An expression listing a hostname that no longer exists
costs the next person auditing coverage a round of "is this term load-bearing?" — and
the honest answer requires checking DNS, not the repo.

Run it **after** the `prod.` Custom Domain is actually gone. Running it first is
harmless but leaves a window where the hostname resolves and has no rules, which is
strictly worse than either end state.

## Credentials

Identical to the AECI-659 directory — the same zone, the same two rulesets, the same
token scopes. See [its README](../2026-09-waf-host-scope/README.md#credentials) for how
to mint `CF_WAF_API_TOKEN` and resolve `CF_ZONE_ID`; it is not repeated here because
two copies of a credentials procedure drift.

```
CF_ZONE_ID          the aecintegrations.com zone id
CF_WAF_API_TOKEN    Zone WAF: Read for snapshot.mjs, Zone WAF: Edit for apply.mjs --apply
```

`verify.mjs` needs no Cloudflare token — it makes ordinary public requests. It does
need `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` to reach `staging.`, which sits
behind Cloudflare Access (`docs/access.md`); without them that host is skipped.

## Run it

```bash
node scripts/ops/2026-09-waf-prod-host-removal/verify.mjs
node scripts/ops/2026-09-waf-prod-host-removal/snapshot.mjs
node scripts/ops/2026-09-waf-prod-host-removal/apply.mjs
node scripts/ops/2026-09-waf-prod-host-removal/apply.mjs --apply
node scripts/ops/2026-09-waf-prod-host-removal/verify.mjs
```

1. **`verify.mjs`** first, to capture the before state.
2. **`snapshot.mjs`** — read-only. Writes `snapshot-<UTC>.json` next to the script
   (gitignored: it carries the live expressions of every rule on the zone) and prints
   both rulesets, the resolved id and migration state of each target rule, and the
   ordering check.
3. **`apply.mjs`** with no flags — a dry run. Prints a before/after expression pair per
   rule and writes nothing.
4. **`apply.mjs --apply`** — the write.
5. **`verify.mjs`** again.

### The pass condition is an UNCHANGED table

This is the one way this operation reads differently from AECI-659. There, the point
was that `www.` flipped from `200/200` to `403/200`. Here, the three remaining hosts
must behave **exactly as before**:

```
HOST                               scraperUA  browserUA
staging.aecintegrations.com        403        200
demo.aecintegrations.com           403        200
www.aecintegrations.com            403        200
```

A row that flips to `200/200` means the narrowing overshot — revert from the snapshot.

`prod.aecintegrations.com` is deliberately not probed. AECI-807 retires the hostname,
so its response says nothing about the rules; check separately that it no longer
resolves to an AECi Worker.

Then update the "Deployed state" section of `docs/waf-rate-limits.md` with the dated
result.

### Exit codes

| Script | 0 | 1 | 2 |
|---|---|---|---|
| `snapshot.mjs` | snapshot written, ordering clean | a blocking `skip` rule was found | usage / credentials |
| `apply.mjs` | nothing left to do, or `--apply` succeeded | dry run found changes to make | usage / credentials / drift |
| `verify.mjs` | every probed host behaves | a host does not | usage |

## Rollback

There is no `--revert`. Re-PATCH each rule's `expression` back to the value in
`snapshot-<UTC>.json` — that file is the revert artifact, which is why step 2 runs
before step 4. Only `expression` changes in this operation, on all three rules, so
unlike the AECI-659 rollback there is no `description` to restore alongside it.

Re-widening to include `prod.` would only make sense if the hostname came back, and
`apps/web/wrangler.jsonc` `env.production` is where that decision actually lives.
