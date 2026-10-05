# Move the production D1 from APAC to ENAM (AECI-839)

**Status: prepared and rehearsed 2026-10-05. Cutover not run.** Production still reads and writes `aeci-app-production` in APAC.

The 2026-10-04 account move created `aeci-app-production` without a location hint. It landed in APAC. Most traffic is US (IAD, ORD, LAX), so every D1 query from a US request crosses the Pacific and back. Detail renders got slower.

D1 cannot be relocated. So this move creates a second database in ENAM, copies the data, and points the production bindings at it. Only production moves. Demo, staging and preview stay in APAC on purpose (Chris, 2026-10-05).

| | Old | New |
|---|---|---|
| Cloudflare name | `aeci-app-production` | `aeci-app-production-us` |
| id | `3bbbd4ca-4907-41c1-9f76-7d7241ca2b8f` | `1f4378db-dabb-4724-b5b8-d0a9ab6c6a3b` |
| `running_in_region` | `APAC` | `ENAM` |
| Created | 2026-09-30 | 2026-10-05, `wrangler d1 create aeci-app-production-us --location=enam` |

Account: The WBS Project, `004dc1af737b22a8aa83b3550fa9b9d3`.

## The binding keeps the old name

The production blocks in `apps/api`, `apps/agent` and `apps/datatool` keep `database_name: "aeci-app-production"` and carry the new `database_id`. This is deliberate.

- Wrangler resolves `wrangler d1 … NAME --env production` against the config first. A matching `database_name` or `binding` returns the configured id.
- When nothing in the config matches, wrangler looks the name up through the API. That finds the old database, which still exists.
- Many callers build the name as `aeci-app-${env}` and pass `--env production`. They include `scripts/d1-apply-migrations.sh` (the promote's migration step), `reconcile-product-counts.ts` (a scheduled CI job), the `retract-*` and `backfill-*` scripts, the strand audit and several ops scripts.
- If the config said `aeci-app-production-us`, every one of those would silently reach the old APAC database. Keeping the old name in the config makes all of them reach the new one with no code change.

Tested 2026-10-05: a scratch config with the old name and the new id ran `d1 execute aeci-app-production --env production` on `1f4378db…`, `served_by_region: ENAM`. `d1 migrations list` against it reported only the migrations that are genuinely pending.

**The trap that remains:** outside a wrangler config, for example from `/tmp`, `aeci-app-production` reaches the old database. Use `aeci-app-production-us` there. Once the old database is deleted, that mistake fails loudly instead.

**No later rename.** D1 has no rename. The config name and the Cloudflare name stay different for good. `docs/environments.md` "Topology" records it.

## The script

`move.sh` runs one step per invocation. It pins the WBS account, runs wrangler from an empty directory, and unsets `CLOUDFLARE_API_TOKEN` (that token reaches only the old AEC account). It uses Chris's wrangler OAuth login. Output goes to `.context/d1-us-move/`, which git ignores.

| Step | Touches | What it does |
|---|---|---|
| `ids` | read | Confirms both names resolve to the pinned ids, and prints each region |
| `export` | read old | `d1 export`, then the three prep scripts from `scripts/ops/2026-09-wbs-account-move/`. Proves the prepared file loads under strict foreign keys and matches the raw export. Writes the expected row counts |
| `import` | write new | Restores the new database to its empty bookmark if it has tables, imports, compares every table's count to the dump |
| `verify` | read both | Row count of every table old vs new. `d1_migrations` contents, schema text and `sqlite_sequence` old vs new. `PRAGMA foreign_key_check` on new |
| `verify --strict` | read both | The same, but any old-vs-new difference fails. Use it only while writes are frozen |
| `latency` | read both | Times one read through the D1 REST API from this machine |
| `region` | read | Today's D1 analytics per database: `servedByRegion`, reads, writes |
| `pause-crons` | prod Worker | Saves, then empties, the cron schedules of `aeci-api-production`. Cutover only |
| `resume-crons` | prod Worker | Puts the saved schedules back. Only needed if the cutover is abandoned. The promote's `wrangler deploy` restores them anyway |
| `checklist` | none | Prints the cutover order |

**The empty bookmark expires.** `import` resets through a time-travel bookmark taken at creation. D1 keeps 30 days of time travel, so it stops working around 2026-11-04. Cut over before then, or change the reset step.

**Guard on `import`.** Once the new database is live, a reset would destroy production. So `import` refuses to reset when the new database holds a `job_runs` or `page_views` id above the dump's. Live crons and visitors write both.

**What the export holds.** 53 tables and their indexes. No views, triggers or virtual tables. `wrangler d1 export` leaves out D1's internal `_cf_KV`. The script stops if any of those ever appear. The `d1_migrations` ledger is a plain table, so it travels with the data. Verify compares it row for row.

**Migrations ledger.** The new database carries all 59 rows, `0000` to `0058`. `wrangler d1 migrations list` against it shows only `0059` to `0062` pending on this branch, the same as the old database. `main` adds `0063`. So the next `promote-to-prod` applies exactly what it would have applied anyway.

## Rehearsal result (2026-10-05)

| Step | Time |
|---|---|
| Remote export (`d1 export`) | 26 s |
| Local prep and proof (three prep scripts, two SQLite loads, dump compare) | 240 s |
| **Export total** | **266 s** |
| Reset to empty bookmark (second run) | 3 s |
| Remote import | 49 s first run, 26 s second run |
| **Import total** (includes the count check) | **58 s / 38 s** |
| **Verify** | **14 s of queries, about 20 s total** |

- The dump was 173 MB: 264,978 lines, 3 oversized statements split.
- Import: `all 53 tables match the dump`. The import ran on `served_by_region: ENAM`, colo `EWR`.
- Region, from the GraphQL `d1AnalyticsAdaptiveGroups` dataset (`move.sh region`): old `APAC`, 9,340 reads today. New `ENAM`, 19 reads. `wrangler d1 info` agrees.
- Verify: `VERIFY CLEAN`. `d1_migrations` identical (59 rows). Schema identical. `foreign_key_check` clean.
- Old vs new differed in two tables, because production kept taking writes during the rehearsal: `job_runs` +1, `page_views` +6. That is what `--strict` catches at the cutover.

**The export blocks the database.** Wrangler warns: "your D1 database will be unavailable to serve queries". The remote export took 26 s. On 2026-10-05 production was unavailable for up to that long, from about 05:26:10 UTC. Plan for that pause at the cutover too.

**Latency from this machine is not the answer.** The machine is in Jakarta (`colo=CGK`). From here APAC is closer, so the result is inverted:

| Database | HTTP round trip from CGK, 6 runs | SQL time inside D1 |
|---|---|---|
| old, APAC | 165 to 291 ms | 0.14 to 0.58 ms |
| new, ENAM | 399 to 485 ms | 0.14 to 0.29 ms |

The SQL time is the same in both. The difference is distance. A US colo will see the reverse. The real check is the PostHog detail p95 after the cutover.

## Cutover plan

### Facts the plan rests on

- **There is no maintenance or read-only switch.** Nothing in `apps/api` can refuse writes. The freeze is people plus paused crons.
- **Production deploys only through `promote-to-prod`, by SHA.** It refuses unless demo is at that SHA. `promote-to-demo` refuses unless staging is at it. Staging deploys from `main`. So the rebind commit must be on `main` first.
- **Demo is not affected.** Its `env.demo` block is unchanged. Promoting the SHA to demo only satisfies the gate.
- **`promote-to-prod` applies pending migrations** to whatever the binding points at, through the config name. After the rebind that is the new database.
- **`promote-to-prod` auto-rolls back both Workers if the smoke fails.** The previous Worker version binds the old database. An auto-rollback therefore sends traffic back to APAC. Any writes the new database took in between stay only there.
- **Production is at `cc3e921a`. `main` is 12 commits and five migrations (`0059` to `0063`) ahead.** None of the five is a table recreate.
- **`apps/agent` and `apps/datatool` are hand-deployed.** They keep the old id until someone redeploys them. The agent only reads. The datatool can write production.

### D1-writing crons on `aeci-api-production`

Every cron writes a `job_runs` row. Some jobs run through a queue consumer and some run inline (ADR 0013). Read from `apps/api/wrangler.jsonc` and `apps/api/src/lib/cron-schedules.ts`.

| Cron (UTC) | Job | Writes beyond `job_runs` |
|---|---|---|
| `*/15 * * * *` | request to Linear reconcile | request rows it reconciles |
| `0 * * * *` | WAF firewall-event poll | |
| `25 */6 * * *` | claim-staleness check | |
| `5 0 * * *` | IndexNow drain | `indexnow_queue`, submission log |
| `15 0 * * *` | `metrics_daily` snapshot | `metrics_daily` |
| `30 0 * * *` | vendor snapshot | `vendor_activity_daily` |
| `0 2 * * 2` | ASN registry (Mondays, per Cloudflare's 1 = Sunday) | `asn_registry` |
| `0 3 * * *` | retention prune | deletes from `page_views`, `job_runs` |
| `0 4 * * *` | data-quality suite | |
| `0 5 * * *` | analytics digest | |
| `0 6 * * *` | moderation snapshot | |
| `0 7 * * *` | home stats | `stats_cache` |
| `0 8 * * *` | Algolia sync | Algolia watermark |
| `0 9 * * *` | Algolia drift | |
| `0 10 * * *` | attestation detectors | `notification_sends` |
| `0 11 * * *` | entitlement expiry | entitlement notice stamp, `notification_sends` |
| `0 12 * * *` | protest reply reminder | `notification_sends` |

**Best window: 00:35 to 01:55 UTC.** Only the `*/15` and hourly crons fire there. That is 07:35 to 08:55 in Jakarta and 8:35 to 9:55 pm US Eastern. A paused cron skips its tick. It does not run late. Pausing during 04:00 to 12:00 UTC would skip a daily job for a day.

### Writes lost during the window

Everything written to the old database after the export starts and before production runs on the new code is lost. The window is about 11 minutes: export 4.5, import 1, verify 0.5, promote about 5.

| Writer | Stopped by | If it writes anyway |
|---|---|---|
| Review-app promotes | Chris tells the curator to hold | Catalog rows and `promote_jobs` lost. Re-run the promote after |
| Admin edits in `/admin` | Chris does not edit | Lost with their `audit_log` rows |
| `apps/datatool` copy, seed, prune | Not run; redeployed after | Writes the old database |
| Crons | `move.sh pause-crons` | Their rows land on old and are lost |
| Queue messages already enqueued | Drain in seconds; check before export | Lost |
| Visitors: `page_views`, `user_activity_daily` | Cannot be stopped | Lost. About 3.5 page views a minute, mostly bots. Chris dropped the same class in the account move (AECI-1166) |
| Forms: subscribe, feedback, requests, reviews | Cannot be stopped | Lost. Rare. Check the old database after and re-enter by hand if any |
| Sign-in profile ensure | Cannot be stopped | Self-heals on the next `GET /api/account` |
| Vendor portal | Dark: 0 entitlements, 0 vendor profiles in the dump | |

`verify --strict` shows any of these as a row-count difference.

### Order

Before the day, no freeze needed:

1. **Chris:** promote `main` to production the normal way. Then the five pending migrations land on the old database and travel with the copy. The move's own promote then carries only the rebind.

On the day:

2. **Chris:** open the PR from this branch and squash-merge it. Wait for the staging deploy to go green.
3. **Chris:** run `promote-to-demo` on the merge SHA.
4. **Chris:** freeze. No promotes, no admin edits, no datatool.
5. **Agent, with Chris's go:** `move.sh pause-crons`, right after a `:00`, `:15`, `:30` or `:45` tick.
6. **Agent:** `move.sh export`, then `move.sh import`, then `move.sh verify --strict`. It must print `VERIFY CLEAN`. If not, stop, run `move.sh resume-crons`, and unfreeze. Nothing has changed for visitors.
7. **Chris:** run `promote-to-prod` on the merge SHA and approve it. Its deploy restores the crons. If it fails or is cancelled before its deploy step, nothing restores them. Run `move.sh resume-crons` then.
8. **Agent:** confirm, below.
9. **Chris or agent:** redeploy the datatool, and the agent Worker if it is deployed: `pnpm --filter @aeci/datatool deploy`, `pnpm --filter @aeci/agent deploy:production`.
10. **Chris:** unfreeze.

**Do not merge the PR early.** Once the rebind is on `main`, any `promote-to-prod` points production at the new database. Before step 6 that database holds the stale rehearsal copy. Production would serve it and drop every write since.

### Confirm

- `https://www.aecintegrations.com/api/version` and `/_version` report the merge SHA.
- A product page and a pair page return 200 with data.
- `wrangler d1 info aeci-app-production-us` (from `/tmp`, OAuth): `running_in_region: ENAM`, `read_queries_24h` rising.
- `wrangler d1 info aeci-app-production`: `write_queries_24h` stops rising.
- A fresh `page_views` row lands on the new database within a minute.
- `move.sh region`: the new database's reads climb under `ENAM`. The old one's stop.
- The next `*/15` tick writes a `job_runs` row on the new database. A new cron trigger can miss its first tick for up to 15 minutes, so allow one missed tick.
- Over the next day, the PostHog detail p95 drops.

### Rollback

- **Fast:** `wrangler rollback --env production` in `apps/web`, then in `apps/api`. The previous API version binds the old database. This is what the promote's auto-rollback does.
- **Then:** revert the rebind commit on `main`, or the next promote re-points production at the new database.
- **Data:** writes taken by the new database after step 7 are not on the old one. Compare with `move.sh verify` and copy any domain rows back by hand.
- **Keep the old database untouched for 7 days.** Deleting it is Chris's call, after that.

## Not done in this phase

No write to `aeci-app-production` or any other existing database. No deploy, no secret, no read-replication change, no PR, no push.
