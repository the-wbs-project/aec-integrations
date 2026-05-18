---
name: spec-anchor
description: Before implementing or modifying code for any AECI-* Linear issue, anchor the work to docs/STAGE_1_SPEC.md. Fetches the Linear issue, parses its "**Spec section:** §X.Y" line, loads the matching section from STAGE_1_SPEC.md, and follows cross-references into the companion docs (API_CONTRACTS.md, DATABASE_SCHEMA.md, AUTH_AND_RLS.md, CICD_PLAN.md, TESTING_STRATEGY.md, UNIT_TESTING_GUIDE.md, CODE_REVIEW_CHECKLIST.md). Use whenever the user names an AECI-* issue, pastes a Linear URL, asks to "start AECI-N", or asks you to implement/fix/review something governed by the Stage 1 spec. Do not invoke for non-AECI work, doc-only edits to the spec itself, or pure config/lint tasks with no spec contract.
user-invocable: false
metadata:
  version: 1.0.0
  type: project-procedure
---

# Spec Anchor

Anchor every AECI implementation task to the Stage 1 spec **before** touching code. `CLAUDE.md` says the spec is the contract; this skill is how that contract gets loaded.

## When to run this

Run automatically at the start of a turn when any of these are true:

- The user mentions an issue ID matching `AECI-\d+`.
- The user pastes a Linear URL containing `/issue/AECI-`.
- The user says "start", "implement", "work on", "pick up", "fix", or "review" alongside an AECI issue reference.
- The user asks you to change behavior governed by the spec (routes, API endpoints, schema, RLS, caching, audit logging, theming tokens, i18n, search, auth) without naming an issue — in that case skip step 1 and start at step 2 against the relevant section.

**Skip** when:

- The task is editing `docs/STAGE_1_SPEC.md` itself, or any companion doc.
- The task is pure tooling (CI yaml, eslint config, prettier, dependency bumps) with no spec contract.
- The user has already loaded the spec section earlier in the conversation and is iterating on the same surface.

## Procedure

### 1. Fetch the Linear issue

Use the Linear MCP. The repo's team prefix is `AECI`.

```
mcp__claude_ai_Linear__get_issue(issueId: "AECI-N")
```

From the returned `description`, extract the first line matching:

```
\*\*Spec section:\*\*\s*§?(\d+[a-z]?(?:\.\d+)*)
```

That capture group is the anchor — e.g. `9.3`, `2a`, `6`, `24.2`. If the line is missing, **stop and tell the user**: per the team's Linear issue templates (`Build Issue Template`, `Bug Template`, `Vendor Claim Template`, `Correction Request Template`), every issue should open with a Spec section reference. Ask whether the issue is genuinely out-of-spec (e.g., infra-only) or the template was skipped.

Also capture from the issue:

- The team's PR-status mapping noted in user memory: draft PR → no action, PR ready → In Progress, review → In Review, merge → Done. (Don't restate this unprompted, but use it when offering to update the issue.)
- Linked Git branch name (if any). If absent, suggest the `aeci-{N}-short-description` form.

### 2. Load the spec section

Read `docs/STAGE_1_SPEC.md`. The spec uses ATX headings like:

```
## 9. Caching Strategy
## 9a. Stage 2 Carve-Outs
## 26. Audit Trail & Workflows
```

Sub-sections appear as `### 9.3 Invalidation` (or sometimes as numbered subheadings inside the section body). To find the right slice:

1. Locate the heading whose number matches the leading component (`9` for `9.3`, `2a` for `2a`).
2. Read from that heading until the next `## ` heading at the same level.
3. If the anchor includes a sub-number (`9.3`, `24.2`), narrow further to the `### ` block that matches, but keep the parent section's intro available for context.

Use the `offset` + `limit` parameters of `Read` once you know the line range — don't slurp the whole file when one section will do.

### 3. Follow cross-references into companion docs

Within the loaded section, look for explicit pointers and load whichever apply. The canonical companion docs (per §1a of the spec and the `CLAUDE.md` table) are:

| Topic in section | Load |
|---|---|
| Endpoint shape, request/response, Zod, error codes | `docs/API_CONTRACTS.md` |
| Table, column, index, RLS, migration | `docs/DATABASE_SCHEMA.md` |
| Role, permission, RLS policy | `docs/AUTH_AND_RLS.md` (and `docs/rls_policies.sql` if policy SQL is involved) |
| Workflow, environment, deployment, secret | `docs/CICD_PLAN.md` |
| Test tool, coverage target, axe, Lighthouse, Playwright | `docs/TESTING_STRATEGY.md` |
| Writing a unit test, fixture, mock | `docs/UNIT_TESTING_GUIDE.md` |
| Pre-merge review category | `docs/CODE_REVIEW_CHECKLIST.md` |
| Visual tokens, palette, typography, components | `DESIGN.md` (repo root) and `docs/BRAND_GUIDELINES.md` |
| Audience, voice, anti-references, principles | `PRODUCT.md` (repo root) |

Treat companion docs as authoritative for their topic. If the spec section and a companion doc disagree, the companion doc wins for its topic — but flag the conflict to the user (CLAUDE.md: "if the spec contradicts itself, raise it, don't silently work around").

### 4. Summarize the contract

Before writing or editing any code, post a short block to the user containing:

- **Issue:** `AECI-N — title`
- **Spec anchor:** `§X.Y — section title`
- **Companion docs loaded:** comma-separated list, or "none required"
- **Contract bullets:** 3–6 bullets capturing the constraints the implementation must respect (endpoint shape, RLS rule, cache key, audit-log call, theme/i18n requirement, etc.) — quote the spec where wording is load-bearing.
- **Open questions:** anything ambiguous in the spec. If non-empty, **stop and ask** — don't proceed.

Keep it tight. The point is to make the contract visible to the user before code happens, not to recite the doc.

### 5. Hand off to implementation

Once the contract is on screen and the user hasn't redirected:

- For UI-touching work, fold in the "Design checklist" from `CLAUDE.md` (critique → craft/refine → polish → impeccable detect → both themes → axe).
- For write paths, remember the non-negotiables from `CLAUDE.md`: `appendAuditLog()` + `invalidateForEntity()` on every state-changing write.
- For DB code, the Prisma Accelerate rule applies (no `@prisma/adapter-pg-worker`, no TCP pooler from Worker runtime).

Then proceed with the task normally. Don't re-run this skill on the same anchor within the same conversation — re-reading the spec mid-task is fine via `Read`, but the summary block should only appear once.

## Failure modes to avoid

- **Don't paraphrase the spec.** Quote load-bearing sentences. Paraphrase is how we drift.
- **Don't load every companion doc.** Only the ones the section actually pulls in. Loading all eight wastes context.
- **Don't proceed past step 4 with open questions.** "I'll assume…" is exactly the failure CLAUDE.md tells you to avoid.
- **Don't run for AECI work that's just lint/format/dep-bump churn.** That noise dilutes the signal when you do run it.
