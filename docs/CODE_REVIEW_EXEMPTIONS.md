# AEC Integrations — Code Review Exemptions

**Audience:** LLMs and humans performing pre-merge code review, or the pre-implementation plan check.
**Companions:** `CODE_REVIEW_CHECKLIST.md` (the categories and severity rules for a diff) and `.agents/skills/spec-anchor/SKILL.md` step 4.5 (the same job for a plan, before code exists — see §"Plan-time matching" below).

This file is the list of findings the team has consciously accepted, deferred, or scheduled for later — so the review process stops re-flagging them on every PR. The reviewer reads this file **before** producing a review, and any finding that matches an active entry here is dropped silently.

---

## How this file works

1. Reviewers (humans and LLMs) load this file at the start of every review.
2. For each finding the checklist would otherwise produce, the reviewer asks: *does an active exemption match this exact thing?*
   - **Match = same file/path (or matching glob), same category, AND the severity is covered.** Be strict: a "performance" exemption does not cover a "security" finding even on the same line.
3. If an active exemption matches → drop the finding silently. Do not list it. Do not even mention the exemption in the review output (otherwise PRs accumulate noise).
4. If a matching exemption is **expired** (see below) → report the finding normally, AND add a one-line note at the bottom of the review: `Note: EX-NNN has expired; the underlying finding is back in scope.` The exemption stays in the file until someone retires it.

**This file does not cover mechanically-enforced items.** An `EX-NNN` entry suppresses a *review finding*; it has no effect on a lint error, which fails the build before review happens. Checklist items tagged `Lint: ✅` (see `docs/CODE_REVIEW_CHECKLIST.md` §Approach and `ANGULAR_STYLE_GUIDE.md` §24) are therefore out of scope here. To make an exception to one of those, use the mechanism's own escape hatch and say why in the comment: an `eslint-disable-next-line` with a justification for an ESLint rule, or `constraints-guard-allow-next-line` for a `check-source-constraints.mjs` rule. If you find yourself wanting a standing exemption for a lint rule, the rule is wrong — fix the rule (AECI-549).

## Active vs. expired

An entry is **active** when:

- `status: active`, AND one of:
  - `expiry: permanent` — always active, OR
  - `expiry: AECI-NNN` and that Linear issue is **not** in the `Done` / `Cancelled` state, OR
  - `expiry: YYYY-MM-DD` and today's date is **before** that date.

An entry is **expired** when its `expiry` condition has fired (issue closed, date passed). The reviewer treats expired entries as if they did not exist — findings come back into scope. Someone should then either delete the entry, move it to the "Retired" section at the bottom, or write a new exemption (with a new ID and new expiry) if the deferral is being extended.

### How to check whether a Linear issue is closed

If the reviewer has access to Linear (via MCP or otherwise), call `mcp__claude_ai_Linear__get_issue_status` on the issue ID and check the state name. If the reviewer does not have Linear access in this session, **assume the issue is still open** (i.e. the exemption is still active) unless the PR body, commit message, or `CHANGELOG` explicitly says the issue has shipped. Better to leave the exemption silently in place than to surface a finding that's been waived.

## Entry schema

Each exemption is one ATX-3 (`###`) section. The reviewer parses entries by scanning for `### EX-` headings.

Required fields:

- **ID** — `EX-NNN` (zero-padded, sequential). Heading format: `### EX-NNN — Short title`.
- **Scope** — at least one of:
  - `files:` — glob patterns (e.g. `apps/api/src/routes/**`)
  - `paths:` — exact paths or `path:line` references
  - `categories:` — categories from `CODE_REVIEW_CHECKLIST.md` (e.g. `Security`, `i18n`, `Caching`)
  - `finding_matches:` — substring or regex to match against the would-be finding text
- **Severity** — `BLOCKER`, `MAJOR`, or `any`. The exemption only suppresses findings at that level (or below if `any`).
- **Justification** — one paragraph. *Why* this is being deferred. Specifics, not vibes. A future reviewer (or future-you) must be able to decide whether the reason still holds.
- **Expiry** — exactly one of:
  - `AECI-NNN` — Linear issue ID that, when closed, removes the exemption
  - `YYYY-MM-DD` — calendar date the exemption stops applying
  - `permanent` — the team has accepted this trade-off indefinitely
- **Status** — `active` or `retired`.
- **Added** — `YYYY-MM-DD` and optionally a handle/name.

If multiple matchers are present (e.g. `files:` AND `categories:`), they combine as **AND** — every matcher must match for the exemption to apply. If you need OR, write two exemptions.

Use a fenced code block tagged `yaml` for the structured fields so both humans and parsers see the same content.

### Template

```
### EX-NNN — Short human title

\`\`\`yaml
id: EX-NNN
scope:
  files:
    - apps/.../**
  paths:
    - apps/.../foo.ts:42
  categories:
    - Caching
  finding_matches:
    - "Cache-Control header missing"
severity: MAJOR              # BLOCKER | MAJOR | any
expiry: AECI-123             # AECI-NNN | YYYY-MM-DD | permanent
status: active               # active | retired
added: 2026-05-17
added_by: name-or-handle
\`\`\`

**Justification.** One paragraph explaining why this is being deferred. Be
specific. Reference the spec section or the planned follow-up work.
```

---

## Plan-time matching (the `spec-anchor` plan check)

The pre-implementation reviewer — step 4.5 of `.agents/skills/spec-anchor/SKILL.md` — loads this file too, reading the same entries through the adjustments below. No schema change: a finding the team has consciously accepted at merge time is one they also don't want raised at plan time, so one list serves both reviewers.

- **`files:` / `paths:`** are evaluated against the paths the **plan names**. If the plan names no paths, a path-scoped exemption does **not** match — report the finding. Fail open toward reporting here: a plan is cheap to correct, so a false positive costs a sentence, while a wrongly suppressed finding costs a build.
- **`categories:`** may name a category from either `CODE_REVIEW_CHECKLIST.md` or the plan check's own six. Match on intent where the names differ — `Caching` covers "missing contract element — cache tag/purge"; `Spec alignment` covers "spec contradiction" and "doc invalidation".
- **`severity:`** maps across the two vocabularies: a `BLOCKER` exemption covers a plan-time **CRITICAL**; `MAJOR` covers **MAJOR**; `any` covers **MINOR** as well.
- **`finding_matches:`** applies unchanged and is the preferred matcher for plan-time exemptions, since plan findings are anchored to a step number rather than a file.

**This is also how the plan check's false-positive rate gets measured.** There is no dashboard and no artifact directory. A finding the team decides is wrong gets written up here as an ordinary exemption with a `finding_matches:` matcher — the count and content of plan-time exemptions *is* the signal, and each one silences the recurrence for free. If they accumulate faster than they expire, the check needs recalibrating, not more categories.

---

## Active exemptions

### EX-002 — Cron-written bookkeeping rows carry no `audit_log` row (ADR 0022)

```yaml
id: EX-002
scope:
  paths:
    - apps/api/src/scheduled.ts
    - apps/api/src/lib/home-stats.ts
    - apps/api/src/lib/algolia-sync.ts
    - apps/api/src/lib/recompute-counts.ts
    - apps/api/src/routes/page-views.ts
    - apps/api/src/routes/landing-forms.ts
    # Added 2026-08-14 (AECI-587): the three Phase 8.3 bookkeeping writers this
    # exemption was reasoned about but never listed. `metrics-snapshot.ts` and
    # `job-runs.ts` write unaudited by design; `retention-prune.ts` is here for
    # the opposite reason — a reviewer reading it should land on the carve-out
    # AND on the scheduled-DELETE exception below, which it must satisfy.
    - apps/api/src/lib/metrics-snapshot.ts
    - apps/api/src/lib/metrics-backfill.ts
    - apps/api/src/lib/job-runs.ts
    - apps/api/src/lib/retention-prune.ts
  categories:
    - Audit logging
    - Data integrity
  finding_matches:
    - "audit_log"
    - "auditInsert"
    - "same db.batch"
    - "§26.1"
severity: any
expiry: permanent
status: active
added: 2026-08-12
added_by: claude (AECI-573)
```

**Justification.** `STAGE_1_SPEC.md` §26.1 formerly read as an absolute — "every write path … no state change without a corresponding audit entry" — and reviewers were correctly flagging every unaudited write against it. **ADR 0022 scopes that invariant to *domain state*.** Derived and log-class writes are exempt when they are all three of: computed entirely from data already in the database (or an append-only event / lead-capture log), invisible on every public surface, and reproducible by re-running the job. That covers `stats_cache` (the 07:00 home-stats job and the Algolia sync watermark), the denormalized product counters, `page_views`, `mailing_list` / `feedback` (already documented in `API_CONTRACTS.md` §6.9/§6.13), and `metrics_daily` / `job_runs` (`ADMIN_PANEL_SPEC.md` §7.1/§7.2, **shipped 2026-08-13** with AECI-581 and AECI-583). Observability for these is `job_runs` plus Datadog.

**This exemption is narrow, and two things fall outside it — keep flagging them.** (1) **Domain-state writes always audit, regardless of actor.** A cron or `actorType: 'system'` write that touches the catalog, users, reviews, claims, requests, or workflows is *not* exempt — the test is entity class, not actor class. The `*/15` reconciliation sweep mutating `vendor_requests` / `workflow_instances` in `apps/api/src/lib/linear.ts` is a real violation and has its own issue; do not treat this entry as covering it. (2) **Scheduled `DELETE`s always audit** — exactly one summary row per run (`action='retention.pruned'`, `metadata={table, cutoff, rowsDeleted}`) in the same batch as the delete. A retention cron that deletes without one is a finding.

`permanent` because it records where a spec boundary sits, not a deferral. It expires only if ADR 0022 is superseded.

---

## Retired exemptions

### EX-001 — Phase 1.6 scaffolding skips API auth/CORS/CSRF/rate-limit on /api/health

```yaml
id: EX-001
scope:
  paths:
    - apps/api/src/index.ts
    - apps/api/src/routes/health.ts
  categories:
    - Security
    - Authorization model
  finding_matches:
    - "Auth checks missing"
    - "CORS policy"
    - "CSRF"
    - "rate limit"
severity: MAJOR
expiry: AECI-29
status: retired
added: 2026-05-17
added_by: claude
retired: 2026-06-01
retired_reason: AECI-29 (baseline RLS + Supabase Auth integration) is Done, so the AECI-29 expiry condition fired. API auth / CORS / CSRF / rate-limit findings are back in scope. The 2026-06-01 codebase audit flagged this entry as expired-but-still-active.
```

**Justification.** The API Worker is private and only reachable via the SSR Worker's service binding during Phase 1 (per `STAGE_1_SPEC.md` and the wrangler config comments at `apps/api/wrangler.jsonc:7-14`). No public route is exposed yet, so CORS / CSRF / per-IP rate limits are not applicable. Auth wiring lands with AECI-29 (RLS + Supabase Auth integration). When AECI-29 closes this exemption expires and these checks come back into scope for the first endpoint that takes user-controlled input.

---

When an exemption is no longer needed — either the underlying issue shipped, the trade-off was reversed, or the code was deleted — move the entry here, set `status: retired`, and add a `retired:` field with the date and a one-line reason. Keeping retired entries in the file is a low-cost historical record of what the team consciously accepted and when.
