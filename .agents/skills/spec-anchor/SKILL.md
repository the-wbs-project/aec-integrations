---
name: spec-anchor
description: Anchor AECI-* work to its governing spec, then check the plan against it before any code exists. Fetches the Linear issue, resolves its "**Spec section:**" line by scanning the whole line for every doc it names and every §X.Y it names, then pairing them (so "§6.2 / §6.7 (docs/STAGE_1_PHASE_6_SPEC.md)" and "docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4" both resolve; default docs/STAGE_1_SPEC.md only when no doc is named; an anchor whose heading does not exist is reported, never silently re-pointed), loads the matching section, follows cross-references into the companion docs (API_CONTRACTS.md, DATABASE_SCHEMA.md, AUTH_AND_RLS.md, CACHE_STRATEGY.md, CICD_PLAN.md, TESTING_STRATEGY.md, UNIT_TESTING_GUIDE.md, CODE_REVIEW_CHECKLIST.md, the ADR index), and — once a plan exists — reviews that plan against the loaded contract, returning findings rated CRITICAL / MAJOR / MINOR. Use whenever the user names an AECI-* issue, pastes a Linear URL, asks to "start AECI-N", writes or finishes a plan for an AECI issue, or asks you to implement/fix/review something governed by the Stage 1, Stage 1.5, or Stage 2 specs. Do not invoke for non-AECI work, doc-only edits to the spec itself, or pure config/lint tasks with no spec contract.
argument-hint: "[AECI-N]"
user-invocable: true
metadata:
  version: 1.4.0
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

From the returned `description`, take the first line beginning `**Spec section:**` and resolve it with a **two-pass scan of the whole line**. One regex cannot do this job: the forms in real use put the doc name somewhere a single anchored pattern can't reach, and a partial match that still *succeeds* is how the anchor silently resolved to the wrong document.

**Pass A — collect every doc named on the line.**

```
(?:docs\/)?[A-Za-z0-9_.\-\/]*[A-Za-z0-9_\-]\.md
```

Run it `g`-globally. `CLAUDE.md`, `DESIGN.md`, `PRODUCT.md` and `ANGULAR_STYLE_GUIDE.md` resolve at the repo root; every other bare name resolves under `docs/`.

**Pass B — collect every section anchor on the line.**

```
§\s*(\d+[a-z]?(?:\.\d+[a-z]?)*)
```

Also `g`-global. `9.3`, `2a`, `6`, `24.2`, `13` all match — and so do the letter-suffixed sub-anchors (`5.4a`, `6.4a`, `9.1b`), which is why the trailing `[a-z]?` repeats inside the group. Dropping it is not a near-miss: `§6.4a` would capture `6.4`, and `### 6.4` exists, so the heading check would pass on the wrong section. Twenty-plus live headings across fifteen docs take that form. A `§` followed by a non-digit (`§"Where to start"`) is a *named* anchor — keep it, but match it as `§"([^"]+)"` rather than here.

**Pairing rule.**

| Docs found | Anchors found | Resolution |
|---|---|---|
| 0 | ≥1 | Default to **`docs/STAGE_1_SPEC.md`**, as before |
| 1 | ≥1 | **Every anchor belongs to that doc**, wherever on the line it sits |
| 1 | 0 | Whole document — read its table of contents, then the sections the issue body actually discusses |
| ≥2 | any | Split the line on `;`, `+` and `·`. Anchors in a segment belong to the doc named in that segment; a segment naming no doc inherits the previous segment's. Load at most **two** docs, and name any you skipped |
| 0 | 0 | Not an anchor — go to the n/a ladder in step 4.5a |

The one-doc row is the load-bearing one. It makes all of these resolve identically and correctly:

```
**Spec section:** §5.4 (docs/ADMIN_PANEL_SPEC.md)
**Spec section:** §6.2 / §6.7 (docs/STAGE_1_PHASE_6_SPEC.md)
**Spec section:** §9.6 / §9.8 (docs/ADMIN_PANEL_SPEC.md, the visitor definition)
**Spec section:** docs/STAGE_2_VENDOR_PORTAL_SPEC.md §4
**Spec section:** the whole of `docs/ADMIN_PANEL_SPEC.md`
```

**Then verify the heading exists. This step is the point of the scan.**

Confirm each resolved anchor is really in its resolved doc. **Resolve the parent section first, then narrow** — the sub-anchor is not always a heading, and three conventions are live:

| Form | Example | Where |
|---|---|---|
| Bare numbered heading | `## 9. Caching Strategy` / `### 9.3 Invalidation` | most docs |
| `§`-prefixed heading | `## §3 AECi-specific overrides` / `### §3.4 Alert model` | `POSTHOG_MIGRATION_SPEC.md` (all 31), `PERFORMANCE_AUDIT.md` (mixed) |
| Numbered **list item** under a heading | `## 9. Non-functional requirements` → `6. **No self-pollution…**` is §9.6 | `ADMIN_PANEL_SPEC.md`, the most-anchored doc there is |

So the check is: **does `^#{1,4}\s+§?<parent>[.\s)]` exist?** If yes, the anchor resolves — narrow to the `###` or the list item, and if the sub-number is absent inside a parent that does exist, say "§X.Y not found inside §X" and review against the parent rather than bailing. Only when the **parent** heading is missing:

> Print `**Spec anchor:** §X.Y (docs/A.md) — heading not found` and drop to the n/a ladder in step 4.5a.

**Never substitute a same-numbered section from a different doc.** That was the old behaviour and it was silent: a failed doc capture fell through to `docs/STAGE_1_SPEC.md`, which has a plausible-looking section at almost every number, so the check printed a confident header over an unrelated contract. Two measured cases, both from the 24 issues created 2026-09-10/11: AECI-862 (`§6.2, §6.7 (docs/STAGE_1_PHASE_6_SPEC.md)`, the request-reconciliation sweep) resolved to `STAGE_1_SPEC.md` **§6.2 Internal consumption pattern**; AECI-871 (`§9.6, §9.8 (docs/ADMIN_PANEL_SPEC.md)`, traffic classification) resolved to `STAGE_1_SPEC.md` **§9 Caching Strategy**. Six of the twenty-one human-authored issues resolved that way. An anchor that will not resolve is a **reportable state**, not a fallback.

**If the line is missing, reads `n/a`, or fails the heading check, do not stop — go to the n/a ladder in step 4.5a.** As of 2026-09-11 only 2 of the 21 most recent human-authored issues carry no line at all, down from the 40% that prompted AECI-601, so the ladder is no longer the majority path. Mis-resolution is now the larger risk, which is why the heading check above is mandatory rather than advisory. Machine-authored tickets (the `Claim:` / `Correction:` issues written by `buildDescription()` in `apps/api/src/lib/linear.ts`) never carry a line by design — recognise them by their `Request: <uuid>` trailer and use the ladder without remarking on it.

The grammar issue authors are asked to write is `docs/linear-issue-conventions.md`. If you meet a line this scan cannot resolve, that doc is where the fix goes — not a widened regex here.

**If the named doc isn't in the worktree, check the other branches before declaring it missing:**

```bash
git show origin/main:docs/<DOC>.md | head -5
```

This mattered most while `stage-2` was a separate line; `stage-2` merged into `main` and was retired on 2026-09-03, so `main` now carries every spec doc (`docs/ADMIN_PANEL_SPEC.md` included — it was the standing example of a doc visible from only one branch). The check is still worth keeping for epic branches: read the doc from the branch that has it and **say which branch you read it from**, because it may not match the code in this worktree.

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

**Two heading conventions are in use, and the heading check in step 1 must accept both.** Most docs number bare (`## 9.`, `### 9.3`). `docs/POSTHOG_MIGRATION_SPEC.md` puts the section mark *in* the heading (`## §3 AECi-specific overrides`, `### §3.4 Alert model`) for all 31 of its headings, and `docs/PERFORMANCE_AUDIT.md` mixes the two. Match `^#{1,4}\s+§?<anchor>[.\s)]?` — treating the `§` as absent would report `heading not found` on a section that is plainly there, which is the same silent-wrongness this skill exists to prevent, just inverted.

`docs/STAGE_1_5_SPEC.md` is self-contained (§1–§10) and its subsection numbers (e.g. `§4.1`, `§5.2`, `§6.1`) are what the 1.5 issues cite; when an anchor resolves there, read that doc, not `STAGE_1_SPEC.md`. The same holds for the phase specs and `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`.

Sub-sections appear as `### 9.3 Invalidation` (or sometimes as numbered subheadings inside the section body). To find the right slice:

1. Locate the heading whose number matches the leading component (`9` for `9.3`, `2a` for `2a`).
2. Read from that heading until the next `## ` heading at the same level.
3. If the anchor includes a sub-number (`9.3`, `24.2`), narrow further to the `### ` block that matches, but keep the parent section's intro available for context.

Use the `offset` + `limit` parameters of `Read` once you know the line range — don't slurp the whole file when one section will do.

### 3. Follow cross-references into companion docs

Within the loaded section, look for explicit pointers and load whichever apply. The canonical companion docs (per the `CLAUDE.md` source-of-truth table, which is the complete index — the spec's own §1a points back at it) are:

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
| Vendor portal, claiming, account status | `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` |
| Admin panel surfaces, operator console, traffic/audience reporting | `docs/ADMIN_PANEL_SPEC.md` |
| Visual tokens, palette, typography, components | `DESIGN.md` (repo root) and `docs/BRAND_GUIDELINES.md` |
| Audience, voice, anti-references, principles | `PRODUCT.md` (repo root) |
| Paid tiers, entitlements, the ranking firewall | `docs/STAGE_2_PAID_TIERS_SPEC.md` |
| Attestations, agreement state, product versions | `docs/STAGE_2_ATTESTATIONS_SPEC.md` |
| Vendor-portal live updates, the freshness cursor, polling | `docs/STAGE_2_REALTIME_SPEC.md` |
| Vendor-activation window, dark launch, seat granting | `docs/STAGE_2_1_SPEC.md` |
| Hardening punch list, live-defect fixes, `/methodology` | `docs/STAGE_2_5_SPEC.md` |
| Trust ladder, pSEO, rebrand handling | `docs/STAGE_3_SPEC.md` |
| Metric catalogue, dashboards, alerts, the live plane | `docs/OBSERVABILITY.md` |
| Event catalogue, consent tiers, activation funnel, identity | `docs/ANALYTICS.md` |
| The PostHog swap, liveness sweep, alert model | `docs/POSTHOG_MIGRATION_SPEC.md` |
| Daily/weekly operate-and-tune, launch-tunable thresholds | `docs/POST_LAUNCH_MONITORING.md` |
| Algolia index settings, custom ranking, tie-breakers | `docs/SEARCH_RANKING.md` |
| WAF zone rules, bot settings, the in-Worker limiter | `docs/waf-rate-limits.md` |
| Promote payload, the async job protocol, connector pages | `docs/REVIEW_APP_PROMOTE_API.md` |

Treat companion docs as authoritative for their topic. If the spec section and a companion doc disagree, the companion doc wins for its topic — but flag the conflict to the user (CLAUDE.md: "if the spec contradicts itself, raise it, don't silently work around").

This table is a lookup, not a reading list. **Don't load more than four companion docs.** If the section seems to pull in more, the anchor is probably too broad — say so. When a doc you need isn't here, the `CLAUDE.md` source-of-truth table is the complete index and this is a convenience subset of it.

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

**Read `.agents/skills/spec-anchor/plan-check.md` in full before checking.** It holds the precedence chain, the verify-before-you-flag rule, severity tiers and caps, the six categories (category 5 is the base-branch gating check), exemptions, and the 4.5b output format and terminators. It is a separate file so sessions that only anchor do not load it.

### 4.5a The n/a path

When step 1 found no `**Spec section:**` line, or it reads `n/a`, resolve the governing docs with this ladder. Stop at the first rung that yields at least one document.

1. **Re-run step 1's Pass A over the rest of the line.** Harvest every `.md` path, plus every `§X.Y` and `§"…"` anchor beside it, **regardless of the lead-in phrase.** The canonical form is `n/a — <reason>. Governing docs: \`docs/A.md\` §X` — AECI-550's own line reads `n/a — dev tooling. Governing docs: CLAUDE.md §"Where to start", .agents/skills/spec-anchor/` — but do not key on the colon. Requiring a literal `Governing docs:` is what made this rung fire on **zero** of the five `n/a` issues in the 2026-09-10/11 sample: they wrote "Governing docs **are**", "Governing **context** today is", and "**governed by**". Those are the same statement. Read them all.

   A path outside `docs/` counts — `.agents/skills/spec-anchor/`, `apps/api/src/lib/email.ts`, `DESIGN.md` at the root. A bare directory means "the thing that governs is this code"; load its entry point and say so.
2. **Map the plan's touched paths against the `CLAUDE.md` source-of-truth table.** `apps/api/src/db/**` → `DATABASE_SCHEMA.md` + ADR 0016 · `.github/workflows/**` → `CICD_PLAN.md` · `apps/web/src/server*` → `CACHE_STRATEGY.md` · `.agents/skills/**` → `CLAUDE.md` §Skills.
3. **Always add `CLAUDE.md` §"Constraints that aren't negotiable".** These bind every plan regardless of anchor. This rung never fails, but on its own it supports CRITICAL-tier checks only.

In n/a mode: **MINOR is suppressed entirely**, the cap is **three findings total**, and the header must print `**Mode:** n/a — MINOR suppressed, max 3` alongside an explicit `**Reviewed against:**` list. If only rung 3 fires and the plan touches nothing the constraints cover, emit the `⚪` terminator with one line on what was tried. Silence is never an acceptable output — a check that examined nothing has to say so.

### 5. Hand off to implementation

Once the contract is on screen, the plan check is clean (or its findings are folded in), and the user hasn't redirected:

- For UI-touching work, fold in the "Design checklist" from `CLAUDE.md` (critique → anchor reference → craft/refine → polish → impeccable detect → axe). Stage 1 is **light theme only** — no `dark:` variants, no toggle (AECI-226).
- For write paths, the §26.1 invariant from `CLAUDE.md`: every state-changing write emits its `audit_log` (and `workflow_transitions`) row into the **same** `db.batch([...])` as the mutation, via the `auditInsert` / `workflowTransitionInsert` builders in `apps/api/src/lib/audit.ts`. D1 has no interactive transactions, so a separate statement is not atomic. The §26.5 forward runs post-commit in `ctx.waitUntil`, to **PostHog Logs** — Datadog was deleted in AECI-651 (ADR 0024).
- For writes that affect cached pages, invalidation is a post-commit `CACHE_PURGE_QUEUE` enqueue inside `ctx.waitUntil`; the SSR consumer delegates `ctx.cache.purge()` into the cached `Renderer` entrypoint (`CACHE_STRATEGY.md` §5, ADR 0020).
- For DB code, ADR 0016 applies: Drizzle over the D1 `DB` binding via `getDb(env)`. No Prisma, no Accelerate, no pg adapter, no `DATABASE_URL` — Prisma was fully removed in AECI-278.

Then proceed with the task normally. Don't re-run steps 1–4 on the same anchor within the same conversation — re-reading the spec mid-task is fine via `Read`, but the summary block should only appear once. Step 4.5 is different: run it again whenever the plan materially changes.

## Failure modes to avoid

- **Don't paraphrase the spec.** Quote load-bearing sentences. Paraphrase is how we drift.
- **Don't load every companion doc.** Only the ones the section actually pulls in, four at most.
- **Don't proceed past step 4 with open questions.** "I'll assume…" is exactly the failure CLAUDE.md tells you to avoid.
- **Don't flag a plan for contradicting a doc without checking the code.** The docs are stale in known places; a doc-only citation is a MINOR stale-doc finding, never a blocker.
- **Don't treat a missing `**Spec section:**` line as a dead end.** Use the n/a ladder. It is no longer the majority path, but it is still the right one.
- **Don't let a resolution succeed silently against the wrong doc.** This is the failure the step-1 scan exists to stop. The old single regex could match the section number and *miss* the doc name, and a missed doc fell through to `docs/STAGE_1_SPEC.md` — which has its own §6.2, §9.6 and §4, so the check printed a confident header over an unrelated contract. Six of twenty-one recent issues resolved that way (AECI-601). **An anchor that will not resolve is a reportable state, not a fallback.** Print `heading not found` and use the ladder.
- **Don't run for AECI work that's just lint/format/dep-bump churn** — beyond the category-5 base-branch gating check, which is a grep across `.github/workflows/` and applies to every plan. That noise dilutes the signal when you do run it.
