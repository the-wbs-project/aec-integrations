# Spec Anchor — plan check (step 4.5)

Loaded on demand from `SKILL.md` step 4.5. Steps 1–4, the n/a ladder (4.5a) and the hand-off (5) live in `SKILL.md`. This half is split out so an anchor-only session does not carry it. Load it only once a plan exists.

Runs once a plan exists — after step 4, before any file is edited. If there's no plan yet, skip silently and come back when there is. Re-run per plan, not per anchor: a revised plan gets a fresh check.

## Resolve authority first — the precedence chain

The docs in this repo are not uniformly current. Resolve which source actually governs, in this order, before judging anything:

1. **`CLAUDE.md` §"Constraints that aren't negotiable"** — the live constraint list.
2. **`docs/adr/`** — the dated decision record, including reversals (ADR 0020 reverses ADR 0028's mechanism; ADR 0016 retires Prisma).
3. **The superseding doc named in the `CLAUDE.md` source-of-truth table** — the phase specs, `STAGE_1_5_SPEC.md`, `STAGE_2_VENDOR_PORTAL_SPEC.md`, `CACHE_STRATEGY.md`.
4. **The companion doc for its topic** (the spec's own §1a rule).
5. **`docs/STAGE_1_SPEC.md` §X.Y — last**, and only where nothing above contradicts it.

**Supersession pre-check.** Scan the loaded slice for `Supersed` / `stale` / `~~strikethrough~~` markers and cross-check the source-of-truth table. `STAGE_1_SPEC.md` carries fifteen such markers. If the anchor lands in a superseded block, **re-anchor to the superseding doc and say so in the header** — don't review the plan against a section the repo has already retired.

Known traps: §9.1 / §9.2 / §9.3 → `CACHE_STRATEGY.md` · §16 Phase 2/5/6 → the phase specs · §3.1 route row, §4.4, §7.5 → `STAGE_1_5_SPEC.md` · §12 / §18.1 n8n → `STAGE_1_PHASE_6_SPEC.md` (n8n dropped, no Slack) · §18 Stage 2 forward-compat → `STAGE_2_SPEC.md`.

`STAGE_2_SPEC.md` is itself a kickoff draft, not a build contract, and **four of its sections have been superseded by build specs**: §2.1 → `STAGE_2_VENDOR_PORTAL_SPEC.md` · §2.2 + the first two §8.2 open items → `STAGE_2_PAID_TIERS_SPEC.md` · §2.3 + the third §8.2 open item → `STAGE_2_REALTIME_SPEC.md` (which also **corrects** §4(5) and the §7 epic table — they say "Durable Objects"; ADR 0023 declined them) · §2.4 → `STAGE_2_ATTESTATIONS_SPEC.md`. An anchor into `STAGE_2_SPEC.md` §2.x is a superseded-anchor finding unless it is §2.5 or later.

## Verify before you flag

**Every finding must cite two things: a doc (`doc.md:line` or `§X.Y`) *and* a code artifact** — a `path.ts:line`, a workflow-YAML line, a schema or migration line, or a proven absence established with `Grep`.

A finding that can only cite the doc is **not a plan defect**. It is a stale-doc finding, and it is reported as MINOR in the shape *"the spec says X, the code says Y, the plan follows Y and is correct."* This rule is load-bearing: `appendAuditLog()` appeared in seventeen doc locations and in zero lines of code (AECI-599 purged the live ones; it survives only in dated ADR text and completion records) (the real API is `auditInsert` / `workflowTransitionInsert` in `apps/api/src/lib/audit.ts`), and `invalidateForEntity()` was never built at all. Without this rule the reviewer would flag correct plans for not matching wrong docs — which is the exact failure this step exists to prevent.

**Carve-out: category-1 doc-invalidation findings.** There the doc is correct *today* and the plan is about to make it wrong, so demanding a code artifact would silently demote the highest-yield category to MINOR — the plan's code doesn't exist yet. The code citation for these is the **current** line the plan removes or replaces (`apps/web/src/server/routes/admin-purge.ts:104` — the `callCloudflarePurge` call this plan deletes), never the code the plan will write. That is a valid two-citation finding and it stays **MAJOR**. The stale-doc demotion applies only when the doc already contradicts shipped code *independently of this plan*.

**The inverse case is not a MINOR.** When the doc describes a guarantee the repo doesn't actually implement — the doc is *right* and the **mechanism** is missing, misconfigured, or unreachable — that is not a stale-doc finding and gets no downgrade. Rate it on the consequence of the absent mechanism: MAJOR by default, CRITICAL when it silently disables a merge gate. The stale-doc downgrade applies only when the plan is following working code that the doc mis-describes. Distinguishing the two is the whole job: "the doc names a helper that was renamed" is a documentation defect; "the doc promises a test gate that doesn't run" is a hole in the build. The sequenced-follow-up rule below is *not* an exception to this one — a deliberate, plan-named deferral is still eligible for downgrade, because a plan that names the gap is not hiding it. This rule governs mechanisms the plan neither names nor owns.

## Severity

| Tier | Meaning at plan time |
|---|---|
| 🔴 **CRITICAL** | The plan violates a live non-negotiable, verified against code. It cannot be implemented as written. **Stop and revise.** |
| 🟡 **MAJOR** | The plan works but is incomplete, or contradicts a doc it doesn't update. Creates rework and drift. **Fold the fix into the plan.** |
| 🔵 **MINOR** | Cheap to fix now, expensive later. Includes the stale-doc class. **Never changes the terminator.** |

CRITICAL triggers, all verifiable against code: `audit_log` row not in the **same** `db.batch([...])` as the mutation (D1 has no interactive transactions) · DB access by any path other than Drizzle via `getDb(env)` · a cached SSR route baking a cookie or `data-theme` value into HTML (§9.1a) · a 404 returned as HTTP 200 with a long TTL (§9.1b) · a `dark:` variant, `.theme-dark` block, or theme toggle (AECI-226) · ranking that depends on a paid tier · a `Vary` value other than `Accept-Language` · a migration that drops or renames a column deployed code still reads · a base branch on which the plan's test lanes don't trigger **when this plan owns that gap** (category 5) — such a plan is implementable, but it merges unverified, which lands in the same place.

MAJOR triggers: a behavior change with no update step for the doc that governs it · a new endpoint with no Zod schema in `packages/shared/` or no error-code row in `API_CONTRACTS.md` §4 · a write affecting cached pages with no `CACHE_PURGE_QUEUE` enqueue or no named `Cache-Tag` · the wrong base branch for the work (ADR 0019) · a base branch on which a workflow in the plan's test story won't trigger, established by reading its `on: pull_request: branches:` block rather than `CICD_PLAN.md` (escalates to CRITICAL only when this plan owns the gap — category 5) · an ADR-worthy decision with no ADR step · a new logic path with no test named in the plan · new user-facing copy with no `i18n` / `$localize` mention · a new locale missing from either `angular.json` `i18n.locales` or the SSR Worker's `LOCALES`.

MINOR triggers: the stale-doc class above · the plan cites a superseded section as authority · dead vocabulary (`appendAuditLog`, `invalidateForEntity`, `disciplines` for `audiences`) · missing `Closes AECI-N` · cites a section number that doesn't exist.

**Caps.** Three CRITICAL+MAJOR findings, five MINOR. Over the cap, report the most severe and add `+N suppressed — the anchor may be wrong.` A check that flags twelve things and misses the one that costs a week is worse than one that says "proceed". Calibrate.

**Group before you cap.** Category 1 routinely surfaces many docs from one root cause — a single removed function can falsify eight files. That is *one* finding, not eight: emit one MAJOR that names every unlisted doc in its body, and don't let it crowd out the other categories. The `+N suppressed` string above is a diagnosis ("the anchor may be wrong"), so don't use it for a plan that is simply under-scoped on docs — say `+N further docs listed above` instead. Caps exist to stop the check being ignored, not to hide work.

**Sequenced-follow-up rule.** If the plan names a deliberate, sequenced follow-up for something it removes or defers, downgrade or drop the finding. WC-3 removed the `cacheKeyUrl` normalization on purpose and said WC-4 restores it; flagging that as CRITICAL is a false positive.

Two limits on it. The deferral must be named **in the plan under review** — a sweep announced only in a doc the plan happens to read does not count, or every plan in an epic inherits a blanket excuse. And an epic-level docs sweep discharges only *wholesale rewrites*, never the per-PR duty to add a supersession banner to a section this plan makes **actively misleading**: someone reading between the two PRs must not be able to follow the doc and be wrong. `CACHE_STRATEGY.md`'s full rewrite could reasonably wait for WC-11; `STAGE_1_PHASE_2_SPEC.md` §8.4 — which described `/admin/purge` as calling the zone purge-by-tag API — could not, and for five commits it told readers something the code no longer did. WC-11 eventually added its supersession banner; WC-6 should have.

## Categories, in order of yield

1. **Doc invalidation and same-PR updates.** For every behavior the plan changes, first name the **artifact** — the function, endpoint, header, env var, table, or metric it adds, removes, or redefines (`callCloudflarePurge`, `POST /admin/purge`, `aeci.cache.purge`, `CF_PURGE_API_TOKEN`). Then `grep -rn '<artifact>' --include='*.md' .` for each (repo-wide — `apps/*/README.md` carries real hits too), and treat **every match as a candidate finding**.

   The grep is what finds second-order dependents; the source-of-truth table won't, because its row labels describe *scope*, not *mechanism*. `docs/STAGE_1_PHASE_2_SPEC.md` is listed as "Phase 2 scope and spec" — unreachable from that label even though its §8.4 was the live description of `POST /admin/purge`. Walk the table **second**, as a coverage check on the grep.

   Each surviving match is either an **explicit step in the plan** (path + section) or an explicitly named deferral. "Update docs" is not a step. **Phase specs and `STAGE_1_SPEC.md` count** — a section can be historically scoped and still be the only place a mechanism is written down. A new governing `docs/*.md` needs a `CLAUDE.md` table row in the same PR (AECI-106).
2. **Spec contradiction.** The plan does something the governing section forbids or specifies differently. Quote the sentence; never paraphrase.
3. **Missing contract element.** Zod schema and error code; audit row in the same batch; `Cache-Tag`; queue purge; a migration for a schema change; a new locale in both registries.
4. **Superseded-anchor trap.** The plan builds on a section that has been superseded (see the trap list above).
5. **Scope, phase, and base branch.** The plan exceeds or misses the issue's stated scope; Stage 2 work inside a Stage 1 issue (`CLAUDE.md` §"What's NOT in scope"); base branch wrong per ADR 0019 — **`main` is the only line.** `stage-2` merged into `main` and was deleted on 2026-09-03 (ADR 0019's 2026-09-03 amendment), so branch everything from `main` and merge back to `main`. `admin-panel` merged into `main` on 2026-08-14 and is retired too. A plan that names `stage-2` or `admin-panel` as its base is citing a branch that does not exist.

   **Then check the base branch is actually gated. A correct base is not a tested base.** `branches:` on a `pull_request` trigger filters by **base** branch, so a workflow pinned to `main` runs *nothing* on a PR into `stage-2`, `admin-panel`, or an epic branch — and it fails **green**: the checks are absent rather than red, so nothing looks wrong. **Open every `.github/workflows/*.yml` and read its `on: pull_request:` block against the base the plan states.** Do not substitute `docs/CICD_PLAN.md` for this. If the plan states no base branch, resolve it from the current branch's upstream, and failing that assume `main` — then say which you assumed. (The `stage-2` and `admin-panel` names in this paragraph are the historical cases the rule was learned from. Both branches are retired, so today the rule matters for epic branches.) A plan that omits its base is the case most likely to inherit an ungated one silently, so this is exactly when not to skip the check. That is precisely how it was missed on the 13,591-line AECI-513 epic: `CICD_PLAN.md` §3.1 was titled "On every PR push" and ADR 0019 asserted "No CI/CD workflow changes", while `deploy.yml` and `integration-db-tests.yml` both carried `branches: [main]` on their `pull_request` trigger. The doc was confidently wrong and only the YAML disproved it. (Cite the trigger block, not a line number — that filter was removed in `fd994483`, and a stale line number in this file would be the same failure it warns about.)

   Every lane in the plan's test story that won't fire on this base is 🟡 **MAJOR**. **Escalate to 🔴 CRITICAL only when this plan owns the gap** — when it is the first to open the ungated base, or when it is an epic/kickoff plan whose sub-issues will all inherit it. If the base was already ungated before this plan, report it once as MAJOR, name the tracking issue if one exists (say "untracked" if not — and that absence is itself worth a sentence), and do not re-terminate on it: the plan is correct and the fix isn't in its scope. **Scope the severity to the plan, not to the branch** — a long-lived branch outlives any one plan, so a branch-scoped CRITICAL would fire on every PR into it forever, which is a standing alarm rather than a finding. Where the two pull against each other, **the epic/kickoff clause wins**: a plan whose sub-issues will each inherit the gap owns it, even though the branch outlives the plan. Name the workflow, the trigger block, and the fix in either case.
6. **Test plan and undocumented decisions.** A new logic path with no named test; the wrong test lane per `TESTING_STRATEGY.md`; an ADR-worthy choice made silently (the bar is `docs/adr/README.md`'s own: "could this surprise someone six months from now?").

**Out of scope here** — it belongs to `docs/CODE_REVIEW_CHECKLIST.md`, which reviews the diff: file-level security review, accessibility specifics, performance micro-analysis, AI-authored-code red flags.

## Exemptions

Load `docs/CODE_REVIEW_EXEMPTIONS.md` before composing findings and apply active entries, per that file's §"Plan-time matching". A finding this step produces that the team decides is a false positive should be written up there as an ordinary exemption with a `finding_matches:` matcher — that is also how this step's false-positive rate gets measured.

## Do this inline

Don't dispatch a subagent. The load-bearing checks are evidentiary (`Grep` for a symbol, read a schema line), and a grep result isn't subject to self-review bias; a fresh subagent would re-derive the plan from the same issue and the same docs at full context cost and mostly agree with itself. The residual risk is real — you are reviewing a plan you may have written — which is exactly why every finding must carry code evidence rather than an opinion.

## 4.5b Output format

```
## Spec Review — AECI-320

**Plan:** migrate POST /admin/purge to in-process ctx.cache.purge()
**Spec anchor:** §9.3 → superseded; re-anchored to CACHE_STRATEGY.md §5
**Reviewed against:** CACHE_STRATEGY.md §5, ADR 0020, STAGE_1_SPEC.md §9.1a/§9.1b
**Doc updates the plan already carries:** CACHE_STRATEGY.md, ADR 0020

🔴 CRITICAL
- `P4` — "write the claim row, then append the audit entry" — the audit_log row must go in the SAME db.batch([...]) as the mutation. D1 has no interactive transactions, so the second statement can commit alone and the §26.1 invariant breaks silently. Use auditInsert. (CLAUDE.md §Constraints; apps/api/src/lib/audit.ts:42)

🟡 MAJOR
- `P9` — "set vendors.verified = true" — flips a value rendered on cached vendor and product pages, but the plan enqueues no purge. Add the CACHE_PURGE_QUEUE enqueue for vendor:{slug}, each product:{slug}, and index:products, post-commit inside ctx.waitUntil. (CACHE_STRATEGY.md §5; apps/api/src/routes/admin-claims.ts:118)

🔵 MINOR
- `P2` — "call appendAuditLog()" — that helper exists in no code; the doc is stale and the plan's intent is right. The real API is auditInsert / workflowTransitionInsert. (STAGE_1_SPEC.md:1628 vs apps/api/src/lib/audit.ts:42)

❌ Revise the plan before implementing — 1 critical, 1 major.
```

Findings have no `file:line` to anchor to, so each one is anchored by **`` `P<n>` `` — the plan's step number, `P0` for the preamble — plus a verbatim quote of twelve words or fewer** from the plan. The step number alone breaks when a plan is renumbered mid-edit; the quote alone is too long to scan.

Exactly one terminator, always present:

| Terminator | When |
|---|---|
| `❌ Revise the plan before implementing — N critical, M major.` | ≥1 CRITICAL |
| `⚠️ Fold the changes above into the plan — M major, K minor.` | 0 CRITICAL, ≥1 MAJOR |
| `✅ Plan matches the contract — proceed.` | 0 CRITICAL, 0 MAJOR (MINORs may still be listed) |
| `⚪ No governing docs resolved — not reviewable.` | the n/a ladder came up empty; add one line on what was tried |

Before posting, self-check: you actually read the section rather than recalling it · you quoted rather than paraphrased · every finding cites both a doc and a code artifact · you walked the source-of-truth table for category 1 · you loaded `CODE_REVIEW_EXEMPTIONS.md` · you're inside the caps.
