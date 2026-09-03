---
name: spec-anchor
description: Anchor AECI-* work to its governing spec, then check the plan against it before any code exists. Fetches the Linear issue, parses its "**Spec section:** §X.Y" line (which may name the spec doc in parentheses, e.g. "§6.1 (docs/STAGE_1_5_SPEC.md)" for Stage 1.5 work — default docs/STAGE_1_SPEC.md), loads the matching section, follows cross-references into the companion docs (API_CONTRACTS.md, DATABASE_SCHEMA.md, AUTH_AND_RLS.md, CACHE_STRATEGY.md, CICD_PLAN.md, TESTING_STRATEGY.md, UNIT_TESTING_GUIDE.md, CODE_REVIEW_CHECKLIST.md, the ADR index), and — once a plan exists — reviews that plan against the loaded contract, returning findings rated CRITICAL / MAJOR / MINOR. Use whenever the user names an AECI-* issue, pastes a Linear URL, asks to "start AECI-N", writes or finishes a plan for an AECI issue, or asks you to implement/fix/review something governed by the Stage 1, Stage 1.5, or Stage 2 specs. Do not invoke for non-AECI work, doc-only edits to the spec itself, or pure config/lint tasks with no spec contract.
argument-hint: "[AECI-N]"
user-invocable: true
metadata:
  version: 1.2.0
  type: project-procedure
---

# Spec Anchor

Anchor every AECI implementation task to the spec **before** touching code, then check the plan against that anchor while changing it is still cheap. `CLAUDE.md` says the spec is the contract; this skill is how that contract gets loaded — and how a plan gets held to it.

## When to run this

Run automatically at the start of a turn when any of these are true:

- The user mentions an issue ID matching `AECI-\d+`.
- The user pastes a Linear URL containing `/issue/AECI-`.
- The user says "start", "implement", "work on", "pick up", "fix", or "review" alongside an AECI issue reference.
- **A plan has just been written for an AECI issue** (plan mode is exiting, or the assistant has produced a step-by-step implementation plan). Run step 4.5 even if steps 1–4 already ran earlier in the conversation.
- The user asks you to change behavior governed by the spec (routes, API endpoints, schema, RLS, caching, audit logging, theming tokens, i18n, search, auth) without naming an issue — in that case skip step 1 and start at step 2 against the relevant section.

**Skip** when:

- The task is editing `docs/STAGE_1_SPEC.md` or another governing doc itself.
- The task is pure tooling (CI yaml, eslint config, prettier, dependency bumps) with no spec contract. This exempts CI *changes* from spec review; it never exempts you from checking that CI actually *runs* on the plan's base branch (step 4.5, category 5).
- The user has already loaded the spec section earlier in the conversation and is iterating on the same surface. (Step 4.5 is the exception — it re-runs per plan, not per anchor.)

## Procedure

### 1. Fetch the Linear issue

Use the Linear MCP. The repo's team prefix is `AECI`.

```
mcp__claude_ai_Linear__get_issue(issueId: "AECI-N")
```

**Resolving the issue ID when the user didn't give one:** read it from the branch with `(?i)(?:^|/)aeci-(\d+)`. The leading-segment match is required — real branches carry an author prefix (`chris/aeci-550-…`), not just the documented `aeci-{N}-…` form.

From the returned `description`, extract the first line matching:

```
\*\*Spec section:\*\*\s*§?(\d+[a-z]?(?:\.\d+)*)\s*(?:\(([^)]*\.md)[^)]*\))?
```

- **Group 1** is the section anchor — e.g. `9.3`, `2a`, `6`, `24.2`.
- **Group 2** (optional) is the **spec doc the issue anchors against**, when the line names one in parentheses — e.g. `§6.1 (docs/STAGE_1_5_SPEC.md)`. When group 2 is absent, the spec doc defaults to **`docs/STAGE_1_SPEC.md`**. (A bare path without `docs/` still resolves under `docs/`.)

**If the line is missing or reads `n/a`, do not stop — go to the n/a ladder in step 4.5a.** Roughly 40% of recent AECi issues carry no `**Spec section:**` line (several use `**Repo:**` / `**Base branch:**` instead, and some belong to the review app), so a hard stop here blocks the majority case. Mention once that the issue skipped the template, then proceed via the ladder.

**If the named doc isn't in the worktree, check the other branches before declaring it missing:**

```bash
git show origin/main:docs/<DOC>.md | head -5
```

`docs/ADMIN_PANEL_SPEC.md` is the live example — it exists on `origin/main` and not on `stage-2`, and a large share of recent issues anchor to it. Read it from the branch that has it and **say which branch you read it from**, because it may not match the code in this worktree.

Also capture from the issue:

- The team's PR-status mapping noted in user memory: draft PR → no action, PR ready → In Progress, review → In Review, merge → Done. (Don't restate this unprompted, but use it when offering to update the issue.)
- Linked Git branch name (if any). If absent, suggest the `aeci-{N}-short-description` form.

### 2. Load the spec section

Read the **spec doc resolved in step 1** — the `.md` named in the Spec-section line, or **`docs/STAGE_1_SPEC.md`** by default. All the spec docs use the same ATX-heading convention, so the slicing below is identical:

```
## 9. Caching Strategy
## 9a. Stage 2 Carve-Outs
## 26. Audit Trail & Workflows
```

`docs/STAGE_1_5_SPEC.md` is self-contained (§1–§10) and its subsection numbers (e.g. `§4.1`, `§5.2`, `§6.1`) are what the 1.5 issues cite; when an anchor resolves there, read that doc, not `STAGE_1_SPEC.md`. The same holds for the phase specs and `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`.

Sub-sections appear as `### 9.3 Invalidation` (or sometimes as numbered subheadings inside the section body). To find the right slice:

1. Locate the heading whose number matches the leading component (`9` for `9.3`, `2a` for `2a`).
2. Read from that heading until the next `## ` heading at the same level.
3. If the anchor includes a sub-number (`9.3`, `24.2`), narrow further to the `### ` block that matches, but keep the parent section's intro available for context.

Use the `offset` + `limit` parameters of `Read` once you know the line range — don't slurp the whole file when one section will do.

### 3. Follow cross-references into companion docs

Within the loaded section, look for explicit pointers and load whichever apply. The canonical companion docs (per the `CLAUDE.md` source-of-truth table, which is the complete index — the spec's own §1a list is incomplete) are:

| Topic in section | Load |
|---|---|
| Endpoint shape, request/response, Zod, error codes | `docs/API_CONTRACTS.md` |
| Table, column, index, migration | `docs/DATABASE_SCHEMA.md` |
| Role, permission, ban, GDPR erasure | `docs/AUTH_AND_RLS.md` |
| Cache tag, TTL, purge, `Vary`, SEO headers | `docs/CACHE_STRATEGY.md` |
| Workflow, environment, deployment, secret, branch model | `docs/CICD_PLAN.md` |
| Test tool, coverage target, axe, Lighthouse, Playwright | `docs/TESTING_STRATEGY.md` |
| Writing a unit test, fixture, mock | `docs/UNIT_TESTING_GUIDE.md` |
| Pre-merge review category | `docs/CODE_REVIEW_CHECKLIST.md` |
| Why a choice was made (and whether it's been reversed) | `docs/adr/README.md` → the specific ADR |
| Phase 2 / 5 / 6 scope | `docs/STAGE_1_PHASE_{2,5,6}_SPEC.md` |
| Integration pair page, claims, attestations | `docs/STAGE_1_5_SPEC.md` |
| Vendor portal, claiming, verified badges | `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` |
| Admin panel surfaces | `docs/ADMIN_PANEL_SPEC.md` (on `origin/main` — see step 1) |
| Visual tokens, palette, typography, components | `DESIGN.md` (repo root) and `docs/BRAND_GUIDELINES.md` |
| Audience, voice, anti-references, principles | `PRODUCT.md` (repo root) |

Treat companion docs as authoritative for their topic. If the spec section and a companion doc disagree, the companion doc wins for its topic — but flag the conflict to the user (CLAUDE.md: "if the spec contradicts itself, raise it, don't silently work around").

Don't load more than four companion docs. If the section seems to pull in more, the anchor is probably too broad — say so.

### 4. Summarize the contract

Before writing or editing any code, post a short block to the user containing:

- **Issue:** `AECI-N — title`
- **Spec anchor:** `§X.Y — section title`
- **Companion docs loaded:** comma-separated list, or "none required"
- **Contract bullets:** 3–6 bullets capturing the constraints the implementation must respect (endpoint shape, cache key, audit-batch rule, i18n requirement, etc.) — quote the spec where wording is load-bearing.
- **Open questions:** anything ambiguous in the spec. If non-empty, **stop and ask** — don't proceed.

Keep it tight. The point is to make the contract visible before code happens, not to recite the doc.

### 4.5 Check the plan against the contract

Runs once a plan exists — after step 4, before any file is edited. If there's no plan yet, skip silently and come back when there is. Re-run per plan, not per anchor: a revised plan gets a fresh check.

#### Resolve authority first — the precedence chain

The docs in this repo are not uniformly current. Resolve which source actually governs, in this order, before judging anything:

1. **`CLAUDE.md` §"Constraints that aren't negotiable"** — the live constraint list.
2. **`docs/adr/`** — the dated decision record, including reversals (ADR 0020 reverses ADR 0010's mechanism; ADR 0016 retires Prisma).
3. **The superseding doc named in the `CLAUDE.md` source-of-truth table** — the phase specs, `STAGE_1_5_SPEC.md`, `STAGE_2_VENDOR_PORTAL_SPEC.md`, `CACHE_STRATEGY.md`.
4. **The companion doc for its topic** (the spec's own §1a rule).
5. **`docs/STAGE_1_SPEC.md` §X.Y — last**, and only where nothing above contradicts it.

**Supersession pre-check.** Scan the loaded slice for `Supersed` / `stale` / `~~strikethrough~~` markers and cross-check the source-of-truth table. `STAGE_1_SPEC.md` carries fifteen such markers. If the anchor lands in a superseded block, **re-anchor to the superseding doc and say so in the header** — don't review the plan against a section the repo has already retired.

Known traps: §9.1 / §9.2 / §9.3 → `CACHE_STRATEGY.md` · §16 Phase 2/5/6 → the phase specs · §3.1 route row, §4.4, §7.5 → `STAGE_1_5_SPEC.md` · `STAGE_2_SPEC.md` §2.1 → `STAGE_2_VENDOR_PORTAL_SPEC.md` · §12 / §18.1 n8n → `STAGE_1_PHASE_6_SPEC.md` (n8n dropped, no Slack) · §18 Stage 2 forward-compat → `STAGE_2_SPEC.md`.

#### Verify before you flag

**Every finding must cite two things: a doc (`doc.md:line` or `§X.Y`) *and* a code artifact** — a `path.ts:line`, a workflow-YAML line, a schema or migration line, or a proven absence established with `Grep`.

A finding that can only cite the doc is **not a plan defect**. It is a stale-doc finding, and it is reported as MINOR in the shape *"the spec says X, the code says Y, the plan follows Y and is correct."* This rule is load-bearing: `appendAuditLog()` appears in seventeen doc locations and in zero lines of code (the real API is `auditInsert` / `workflowTransitionInsert` in `apps/api/src/lib/audit.ts`), and `invalidateForEntity()` was never built at all. Without this rule the reviewer would flag correct plans for not matching wrong docs — which is the exact failure this step exists to prevent.

**Carve-out: category-1 doc-invalidation findings.** There the doc is correct *today* and the plan is about to make it wrong, so demanding a code artifact would silently demote the highest-yield category to MINOR — the plan's code doesn't exist yet. The code citation for these is the **current** line the plan removes or replaces (`apps/web/src/server/routes/admin-purge.ts:104` — the `callCloudflarePurge` call this plan deletes), never the code the plan will write. That is a valid two-citation finding and it stays **MAJOR**. The stale-doc demotion applies only when the doc already contradicts shipped code *independently of this plan*.

**The inverse case is not a MINOR.** When the doc describes a guarantee the repo doesn't actually implement — the doc is *right* and the **mechanism** is missing, misconfigured, or unreachable — that is not a stale-doc finding and gets no downgrade. Rate it on the consequence of the absent mechanism: MAJOR by default, CRITICAL when it silently disables a merge gate. The stale-doc downgrade applies only when the plan is following working code that the doc mis-describes. Distinguishing the two is the whole job: "the doc names a helper that was renamed" is a documentation defect; "the doc promises a test gate that doesn't run" is a hole in the build. The sequenced-follow-up rule below is *not* an exception to this one — a deliberate, plan-named deferral is still eligible for downgrade, because a plan that names the gap is not hiding it. This rule governs mechanisms the plan neither names nor owns.

#### Severity

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

#### Categories, in order of yield

1. **Doc invalidation and same-PR updates.** For every behavior the plan changes, first name the **artifact** — the function, endpoint, header, env var, table, or metric it adds, removes, or redefines (`callCloudflarePurge`, `POST /admin/purge`, `aeci.cache.purge`, `CF_PURGE_API_TOKEN`). Then `grep -rn '<artifact>' --include='*.md' .` for each (repo-wide — `apps/*/README.md` carries real hits too), and treat **every match as a candidate finding**.

   The grep is what finds second-order dependents; the source-of-truth table won't, because its row labels describe *scope*, not *mechanism*. `docs/STAGE_1_PHASE_2_SPEC.md` is listed as "Phase 2 scope and spec" — unreachable from that label even though its §8.4 was the live description of `POST /admin/purge`. Walk the table **second**, as a coverage check on the grep.

   Each surviving match is either an **explicit step in the plan** (path + section) or an explicitly named deferral. "Update docs" is not a step. **Phase specs and `STAGE_1_SPEC.md` count** — a section can be historically scoped and still be the only place a mechanism is written down. A new governing `docs/*.md` needs a `CLAUDE.md` table row in the same PR (AECI-106).
2. **Spec contradiction.** The plan does something the governing section forbids or specifies differently. Quote the sentence; never paraphrase.
3. **Missing contract element.** Zod schema and error code; audit row in the same batch; `Cache-Tag`; queue purge; a migration for a schema change; a new locale in both registries.
4. **Superseded-anchor trap.** The plan builds on a section that has been superseded (see the trap list above).
5. **Scope, phase, and base branch.** The plan exceeds or misses the issue's stated scope; Stage 2 work inside a Stage 1 issue (`CLAUDE.md` §"What's NOT in scope"); base branch wrong per ADR 0019 — production-destined work and hotfixes go to `main`, Stage 2 work to `stage-2`.

   **Then check the base branch is actually gated. A correct base is not a tested base.** `branches:` on a `pull_request` trigger filters by **base** branch, so a workflow pinned to `main` runs *nothing* on a PR into `stage-2`, `admin-panel`, or an epic branch — and it fails **green**: the checks are absent rather than red, so nothing looks wrong. **Open every `.github/workflows/*.yml` and read its `on: pull_request:` block against the base the plan states.** Do not substitute `docs/CICD_PLAN.md` for this. If the plan states no base branch, resolve it from the current branch's upstream, and failing that from ADR 0019 (Stage 2 work → `stage-2`) — then say which you assumed. A plan that omits its base is the case most likely to inherit an ungated one silently, so this is exactly when not to skip the check. That is precisely how it was missed on the 13,591-line AECI-513 epic: `CICD_PLAN.md` §3.1 was titled "On every PR push" and ADR 0019 asserted "No CI/CD workflow changes", while `deploy.yml` and `integration-db-tests.yml` both carried `branches: [main]` on their `pull_request` trigger. The doc was confidently wrong and only the YAML disproved it. (Cite the trigger block, not a line number — that filter was removed in `fd994483`, and a stale line number in this file would be the same failure it warns about.)

   Every lane in the plan's test story that won't fire on this base is 🟡 **MAJOR**. **Escalate to 🔴 CRITICAL only when this plan owns the gap** — when it is the first to open the ungated base, or when it is an epic/kickoff plan whose sub-issues will all inherit it. If the base was already ungated before this plan, report it once as MAJOR, name the tracking issue if one exists (say "untracked" if not — and that absence is itself worth a sentence), and do not re-terminate on it: the plan is correct and the fix isn't in its scope. **Scope the severity to the plan, not to the branch** — `stage-2` is permanently long-lived, so a branch-scoped CRITICAL would fire on every Stage 2 PR forever, which is a standing alarm rather than a finding. Where the two pull against each other, **the epic/kickoff clause wins**: a plan whose sub-issues will each inherit the gap owns it, even though the branch outlives the plan. Name the workflow, the trigger block, and the fix in either case.
6. **Test plan and undocumented decisions.** A new logic path with no named test; the wrong test lane per `TESTING_STRATEGY.md`; an ADR-worthy choice made silently (the bar is `docs/adr/README.md`'s own: "could this surprise someone six months from now?").

**Out of scope here** — it belongs to `docs/CODE_REVIEW_CHECKLIST.md`, which reviews the diff: file-level security review, accessibility specifics, performance micro-analysis, AI-authored-code red flags.

#### Exemptions

Load `docs/CODE_REVIEW_EXEMPTIONS.md` before composing findings and apply active entries, per that file's §"Plan-time matching". A finding this step produces that the team decides is a false positive should be written up there as an ordinary exemption with a `finding_matches:` matcher — that is also how this step's false-positive rate gets measured.

#### Do this inline

Don't dispatch a subagent. The load-bearing checks are evidentiary (`Grep` for a symbol, read a schema line), and a grep result isn't subject to self-review bias; a fresh subagent would re-derive the plan from the same issue and the same docs at full context cost and mostly agree with itself. The residual risk is real — you are reviewing a plan you may have written — which is exactly why every finding must carry code evidence rather than an opinion.

### 4.5a The n/a path

When step 1 found no `**Spec section:**` line, or it reads `n/a`, resolve the governing docs with this ladder. Stop at the first rung that yields at least one document.

1. **Parse `Governing docs:` from the same line.** The convention is already in use — AECI-550's own line reads `n/a — dev tooling. Governing docs: CLAUDE.md §"Where to start", .agents/skills/spec-anchor/`. Match `Governing docs?:\s*(.+)$`, then pull the backticked paths and any `§"…"` or `§X.Y` anchors. Keep writing issues this way.
2. **Map the plan's touched paths against the `CLAUDE.md` source-of-truth table.** `apps/api/src/db/**` → `DATABASE_SCHEMA.md` + ADR 0016 · `.github/workflows/**` → `CICD_PLAN.md` · `apps/web/src/server*` → `CACHE_STRATEGY.md` · `.agents/skills/**` → `CLAUDE.md` §Skills.
3. **Always add `CLAUDE.md` §"Constraints that aren't negotiable".** These bind every plan regardless of anchor. This rung never fails, but on its own it supports CRITICAL-tier checks only.

In n/a mode: **MINOR is suppressed entirely**, the cap is **three findings total**, and the header must print `**Mode:** n/a — MINOR suppressed, max 3` alongside an explicit `**Reviewed against:**` list. If only rung 3 fires and the plan touches nothing the constraints cover, emit the `⚪` terminator with one line on what was tried. Silence is never an acceptable output — a check that examined nothing has to say so.

### 4.5b Output format

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

### 5. Hand off to implementation

Once the contract is on screen, the plan check is clean (or its findings are folded in), and the user hasn't redirected:

- For UI-touching work, fold in the "Design checklist" from `CLAUDE.md` (critique → anchor reference → craft/refine → polish → impeccable detect → axe). Stage 1 is **light theme only** — no `dark:` variants, no toggle (AECI-226).
- For write paths, the §26.1 invariant from `CLAUDE.md`: every state-changing write emits its `audit_log` (and `workflow_transitions`) row into the **same** `db.batch([...])` as the mutation, via the `auditInsert` / `workflowTransitionInsert` builders in `apps/api/src/lib/audit.ts`. D1 has no interactive transactions, so a separate statement is not atomic. Datadog forwarding runs post-commit in `ctx.waitUntil`.
- For writes that affect cached pages, invalidation is a post-commit `CACHE_PURGE_QUEUE` enqueue inside `ctx.waitUntil`; the SSR consumer delegates `ctx.cache.purge()` into the cached `Renderer` entrypoint (`CACHE_STRATEGY.md` §5, ADR 0020).
- For DB code, ADR 0016 applies: Drizzle over the D1 `DB` binding via `getDb(env)`. No Prisma, no Accelerate, no pg adapter, no `DATABASE_URL` — Prisma was fully removed in AECI-278.

Then proceed with the task normally. Don't re-run steps 1–4 on the same anchor within the same conversation — re-reading the spec mid-task is fine via `Read`, but the summary block should only appear once. Step 4.5 is different: run it again whenever the plan materially changes.

## Failure modes to avoid

- **Don't paraphrase the spec.** Quote load-bearing sentences. Paraphrase is how we drift.
- **Don't load every companion doc.** Only the ones the section actually pulls in, four at most.
- **Don't proceed past step 4 with open questions.** "I'll assume…" is exactly the failure CLAUDE.md tells you to avoid.
- **Don't flag a plan for contradicting a doc without checking the code.** The docs are stale in known places; a doc-only citation is a MINOR stale-doc finding, never a blocker.
- **Don't treat a missing `**Spec section:**` line as a dead end.** Use the n/a ladder. Most recent issues need it.
- **Don't run for AECI work that's just lint/format/dep-bump churn** — beyond the category-5 base-branch gating check, which is a grep across `.github/workflows/` and applies to every plan. That noise dilutes the signal when you do run it.
