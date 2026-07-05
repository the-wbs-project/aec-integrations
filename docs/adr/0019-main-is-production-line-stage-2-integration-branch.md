# 0019 — `main` is the production line; Stage 2 develops on a long-lived `stage-2` integration branch

- **Status:** Accepted (2026-07-05)
- **Date:** 2026-07-05
- **Context owner:** chrisw@thewbsproject.com
- **Spec anchor:** `docs/CICD_PLAN.md` §10, `docs/environments.md` (Promotion model)
- **Supersedes (scoped):** the "single long-lived branch `main`, no long-lived branches" rule in `docs/CICD_PLAN.md` §10 — for the duration of the Stage 2 build only.
- **Interacts:** ADR 0016 (D1 app DB — forward-only migrations are the load-bearing constraint), ADR 0017 (shared auth project — unaffected)

---

## Context

Production went live on **2026-07-05**. Stage 2 (vendor portal, self-serve claiming, paid
features, trust scoring) now has to be built **while a live production site must remain
patchable**.

The pipeline is a single linear trunk with promote-by-SHA gates
(`docs/environments.md` Promotion model):

```
main (HEAD) ──auto──► staging ──promote(SHA)──► demo ──promote(SHA)──► production
```

- Every push to `main` auto-deploys to **staging** (`deploy.yml`).
- `promote-to-demo.yml` / `promote-to-prod.yml` each take an explicit `commit_sha` and
  refuse to run unless that SHA is already live on the immediate upstream tier (demo checks
  staging; prod checks demo). The buttons already accept an **arbitrary** commit — the
  promote *mechanism* supports shipping a specific fix.

Two facts make the single trunk unsafe once Stage 2 work lands on `main`:

1. **Code entanglement.** A commit's SHA is a point in `main`'s linear history, so it carries
   **everything merged before it**. Promoting a hotfix SHA to prod would drag in every
   in-progress Stage 2 commit ahead of it. There is no "just this fix" SHA on a shared trunk.
2. **Forward-only D1 migrations (the decisive one).** `promote-to-prod` runs
   `wrangler d1 migrations apply aeci-app-production` as part of the promote. Any Stage 2
   schema migration sitting on `main` reaches **production's D1** the instant you promote past
   it. Feature flags hide UI; they do **not** hide a migration, and D1 migrations are
   forward-only (rollback is a time-travel restore, not a down-migration — `CICD_PLAN.md` §6.2).

Feature-flagging Stage 2 on the trunk (the lower-friction alternative) solves (1) only weakly
and does not solve (2) at all, and early Stage 2 is schema-heavy. So flags are insufficient as
the primary mechanism.

## Decision

**`main` becomes the production/stable line; Stage 2 development moves to a long-lived
`stage-2` integration branch.** This is a deliberate, time-boxed exception to the
`CICD_PLAN.md` §10 "no long-lived branches" rule, justified by production being live plus
forward-only D1 migrations.

- **`main` = production line.** Only production-destined work lands here: hotfixes, and Stage 2
  work that is genuinely additive *and* safe to ship to prod now. `main` HEAD must stay
  **always-promotable** — staging auto-tracks it, so `main` HEAD is always a valid prod
  candidate. Production-destined feature branches branch off `main` and squash-merge back.
- **`stage-2` = long-lived integration branch.** All Stage 2 feature branches (and Conductor
  workspaces doing Stage 2 work) target `stage-2` and squash-merge into it. Merge
  **`main → stage-2` regularly** (after every hotfix, at least weekly) to absorb fixes and keep
  drift small. When Stage 2 is ready, merge **`stage-2 → main`** via PR, promote through the
  tiers, then reset/retire the branch.
- **Hotfix flow is unchanged** and *is* the "apply a fix to live prod" path:
  branch from `main` → PR to `main` → squash-merge → staging auto-deploys → `promote-to-demo`
  (SHA) → `promote-to-prod` (SHA).
- **No CI/CD workflow changes.** Staging still auto-tracks `main` (now the prod line — exactly
  what we want); the promote buttons already take an arbitrary SHA; `drift-check.yml` is
  base-branch-agnostic, so Stage 2 PRs into `stage-2` still get the schema-drift gate. Stage 2
  integration is validated via **PR previews** (per-PR `aeci-{web,api}-pr-<N>` Workers); a
  dedicated always-on Stage 2 environment is *not* built now (revisit if PR previews prove
  insufficient).

## Consequences

**Positive**
- Production is patchable at any time via the existing, battle-tested promote path, with no
  Stage 2 code or schema entangled.
- Prod's D1 **never sees a Stage 2 migration** until `stage-2 → main` merges and is promoted —
  the forward-only-migration hazard is eliminated by construction, not by discipline.
- Zero workflow/infra change; the change is branch conventions + docs.

**Negative / accepted trade-offs**
- **Long-lived-branch drift + an eventual large merge.** Mitigated by frequent `main → stage-2`
  merges. This is precisely the drift §10 warned about — accepted deliberately because the
  live-prod + forward-only-migration constraints outweigh it.
- **Migration-journal reconciliation.** Stage 2 migrations accumulate on `stage-2` while
  hotfix migrations may land on `main`. Before merging `stage-2 → main`, re-run
  `pnpm --filter @aeci/api db:generate` and reconcile against any `main` migrations so the
  Drizzle journal (`apps/api/migrations/meta/_journal.json`) stays linear.
- **Conductor convention split.** The default "branch from `main`" (CLAUDE.md, memory) now
  means *production-destined work*; Stage 2 workspaces branch from `stage-2`. Agents must pick
  the base branch by the nature of the work.
- **Staging no longer shows integrated Stage 2.** Staging is the prod candidate; Stage 2
  integration lives in PR previews (or the eventual `stage-2 → main` promote). Accepted.

## Implementation

1. Create the `stage-2` branch off `main` (`git branch stage-2 main && git push -u origin stage-2`).
2. Docs updated in the same change: this ADR, the ADR index, `CICD_PLAN.md` §10,
   `docs/environments.md` (Promotion model), `CLAUDE.md` (Git workflow).
3. Keep cutting release tags (`vX.Y.Z`) from `main` after each validated prod promote — they
   double as break-glass branch points (`CICD_PLAN.md` §10).

At Stage 2 launch, merge `stage-2 → main`, promote, and either reset `stage-2` off the new
`main` for Stage 3 work or retire it — at which point the trunk model (§10 original) can
resume if no further parallel-stage work is outstanding.
