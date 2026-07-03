# Stage 1 — Phase 6 Spec (Requests & Moderation)

Sibling to `STAGE_1_PHASE_2_SPEC.md` / `STAGE_1_PHASE_5_SPEC.md`. Governs Phase 6 of the build order (`STAGE_1_SPEC.md` §16). Where this doc and §16/§12/§26.3 disagree, **this doc wins for Phase 6** (and those sections are reconciled to point here). Planned 2026-06-10; decomposed into AECI Phase 6.1–6.13.

---

## 1. Goal

The moderation-**orchestration** layer. Route incoming claim/correction requests into Linear, keep state in sync both ways, give admins a requests dashboard, surface domain-match + duplicate signals, and wire reviewer-ban management — plus a lean workflow-history audit so every moderation action is traceable in Supabase.

The forms that *create* requests already shipped (Phase 2 / AECI-128); Phase 6 builds everything that *happens after* a request lands.

---

## 2. Inputs from earlier phases — what exists (do NOT rebuild)

- **Request forms + write path** (AECI-128): `POST /api/requests/claim` and `/correction` insert `vendor_requests` rows with `status='open'`, `domain_match='pending'`, `linear_issue_id=null` — "for the Phase 6 pipeline to pick up."
- **Tables**: `vendor_requests`, `workflow_instances`, `workflow_transitions` all exist (baseline migration). `appendAuditLog()` already supports `actorType: 'workflow'`. **Zero migrations in Phase 6.**
- **Phase 5 dependencies**: the user-session authz middleware (`requireAdmin`, AECI-196), the `/admin` route guard + shell (AECI-203), and the review-moderation queue driven off `review.status` (AECI-204). Phase 6 builds **on** the Phase 5 admin surface.
- **Contracts already specified**: `GET /api/admin/requests` (`API_CONTRACTS.md` §6.10), `POST /api/webhooks/linear` + `LinearWebhookSchema` (§6.11). The workflow tables + types are in `STAGE_1_SPEC.md` §26.2–26.4.
- **Nothing built yet**: no Linear client, no webhook, **no Slack anywhere**, no n8n wiring, no workflow-tracking code, no domain-match logic, no `/api/admin/*`, no request dedup.

---

## 3. Scope & decisions

### 3.1 In scope (Phase 6)

1. **Lean workflow tracking** — `workflow_instances` + `workflow_transitions` as an append-only history (§5).
2. **Linear integration** — issue creation on submit, the inbound webhook, site→Linear sync, a reconciliation sweep (§6).
3. **Vendor-request moderation signals** — domain-match (info only) + duplicate flags on submit (§7).
4. **Admin requests dashboard** — `GET /api/admin/requests` + resolve/reject actions + `/admin/requests` UI (§8).
5. **Reviewer ban management** — admin sets `banned_at`/`ban_reason`; "repeat offender" prompt (§9).
6. **Notifications** — Linear + email, no Slack (§10). **Observability + checkpoint** (§11).

### 3.2 Decisions locked with the PO (2026-06-10)

- **No Slack.** The moderation surface is the Linear **"Vendor Requests" project** (each request = an issue) plus Linear's **native email notifications** to the assignee, plus the admin pending badge. An **admin email** fires only on a Linear-pipeline *failure* (§6.2). No `#moderation` channel.
- **Lean workflow tracking, not a guarded FSM.** Moderation is driven off the existing `status` columns; `workflow_transitions` is an append-only history. This **relaxes `STAGE_1_SPEC.md` §26.3** ("documented state machine… invalid transitions throw") for Stage 1 — low request volume doesn't justify the machinery. The full guarded FSM can drop in later.
- **Linear issue creation on submit**, fire-and-forget via `ctx.waitUntil()`, with a reconciliation sweep + failure email as the backstop (§6).
- **domain-match is informational only.** Auto-*computed* and shown to the admin (+ the `domain-check-pending` label on mismatch), but it **never** auto-approves or auto-rejects. Admins resolve every request by hand. Corrections are **never** auto-applied — the admin edits source data in Airtable and re-promotes (§7.3).

### 3.3 Out of scope (Stage 2+ / deferred)

Guarded FSM with enforced transitions; n8n; Slack; auto-approval; auto-applied corrections; vendor self-serve portal. **Deferred to Phase 7:** transactional email (the permanent home of the failure-alert email — landed in AECI-240 / Phase 7.5 on **Resend**, not Loops; see `docs/email.md`), WAF rate limits on the request endpoints, and the daily data-quality job (§23.1).

---

## 4. §12 reconciliation — n8n → Cloudflare Worker

`STAGE_1_SPEC.md` §12 ("Issue Tracking — Linear via n8n") is **superseded**. n8n is dropped (Phase 2 Spec §18.1: the form-submit-to-Linear handler is a Cloudflare Worker — fewer moving parts, versioned in-repo, observable in Datadog). **AECI-18** (the Phase-1 n8n setup, marked Done) is **abandoned for the form→Linear path** — n8n has no remaining Stage 1 use. The Worker handles Linear API auth, retries, and idempotency directly.

---

## 5. Lean workflow tracking

- **`workflow_instances`** — create one per `vendor_request` (`workflow_type` `vendor_claim` | `correction_request`) and per `review` (`review_moderation`). Store `current_state` (mirrors the entity's `status`) + `linear_issue_id` (vendor requests only — `review_moderation` has no Linear issue).
- **`workflow_transitions`** — append-only history (`from_state`, `to_state`, `actor_id`, `reason`, `metadata`), written on **every** status change and by the inbound Linear webhook (`actor_type: 'workflow'`).
- **`appendWorkflowTransition()`** helper, mirroring `appendAuditLog()`. **No guarded state machine** — transitions are *recorded*, not *enforced* (Stage-1 relaxation of §26.3). Both tables forward to Datadog (§26.5).

---

## 6. Linear integration

### 6.1 Issue creation on submit

Extend the AECI-128 request handler: after the `vendor_requests` insert, create a Linear issue in the **"Vendor Requests" project** via the Linear GraphQL API — claim/correction template, body from the form fields, **`Source URL` as a Linear attachment** (renders as a clickable card), labels (`claim`|`correction`, plus `domain-check-pending` on a domain mismatch — §7.1), assignee **round-robin Chris/Bill**. Store the returned issue id on `vendor_requests.linear_issue_id` + the `workflow_instance`. **Idempotent** (never double-create for one request). Runs via `ctx.waitUntil()` so it never blocks the `201`. Secret: `LINEAR_API_KEY`.

### 6.2 Failure handling

If the Linear API call fails: the row stays `open` with `linear_issue_id=null`, a Datadog error is logged, the reconciliation sweep (§6.4) retries, and on **persistent** failure an **admin email** fires so the request is never silently lost. (Email mechanism: **Resend** — wired in AECI-240 / Phase 7.5, `docs/email.md`; fail-open, so the stuck-row visibility in `/admin/requests` + the Datadog alert remain the guaranteed backstop.)

### 6.3 `POST /api/webhooks/linear` (Linear → Site)

Per `API_CONTRACTS.md` §6.11. **HMAC-verify** the `Linear-Signature` header against the signing secret. On an issue state change, write a `workflow_transitions` row (`actor_type: 'workflow'`, metadata referencing the Linear action) and update `vendor_requests.status`. **Validate `LinearWebhookSchema` against a real captured payload** before depending on field names.

### 6.4 Reconciliation sweep

A scheduled job (extend the existing scheduled Worker — the AECI-139 cron→queue→consumer, ADR 0013): find `open` requests with `linear_issue_id=null` older than ~N minutes → retry §6.1; alert (admin email) on persistent failures. This is the guaranteed backstop for §6.2.

### 6.5 Site → Linear sync

When an admin resolves/rejects in `/admin/requests` (§8), push the change to the Linear issue (status transition + a comment) via GraphQL, and record a `workflow_transition`. Keeps Linear and the app DB (D1, ADR 0016) consistent regardless of where the admin acted (they may also resolve directly in Linear → the webhook §6.3 covers that direction). Wired into the resolve/reject handler's `SyncRequestToLinear` seam at the composition root (`apps/api/src/index.ts`) via `pushRequestResolutionToLinear` (AECI-220).

---

## 7. Vendor-request moderation signals

### 7.1 domain-match (informational)

On submit, compute whether the `submitter_email` domain matches the target vendor's website domain → set `vendor_requests.domain_match` `yes`/`no` (was `pending`). Drives the `domain-check-pending` Linear label on a mismatch and the admin display. **No auto-approval** — purely a hint for the admin.

### 7.2 Duplicate detection on submit (§22.4 / §23.2)

Flag likely duplicates: an existing `open` request of the same `kind` for the same `(target_type, target_id)`, or the same `submitter_email` + target. **Informational flag** for the admin (and a Linear note) — never auto-rejects.

### 7.3 Corrections are never auto-applied

Per §22.5: a correction request routes to Linear + the admin dashboard; the admin reviews the suggested change and **edits the source data in Airtable, then re-promotes** (`REVIEW_APP_PROMOTE_API.md`). Phase 6 only routes + tracks.

---

## 8. Admin requests dashboard

### 8.1 `GET /api/admin/requests` + actions

Per `API_CONTRACTS.md` §6.10. `requireAdmin` (Phase 5 / AECI-196). `ListVendorRequestsQuerySchema` (`kind?`, `status` `open|resolved|rejected`, paginated). Plus **resolve/reject actions** → set `status` + `resolved_by`/`resolved_at`, trigger the §6.5 site→Linear sync, write a `workflow_transition` + `appendAuditLog()`.

### 8.2 `/admin/requests` UI

Under the Phase 5 admin shell (AECI-203). Lists claims/corrections with: submitter, target (linked), **domain-match hint**, **duplicate flag**, Linear issue link, status, age; resolve/reject controls. i18n, both themes, axe-clean.

---

## 9. Reviewer ban management

Per §22.3. The admin UI gains an action to set `profiles.banned_at` + `ban_reason` (enforcement — rejecting a banned user's review submit — already lands in Phase 5 / AECI-197). **Repeat-offender prompt:** when a reviewer's **3rd** review is rejected, surface a "consider a ban" prompt to the admin (not automatic). Every ban writes `appendAuditLog()` + a `workflow_transition`.

---

## 10. Notifications (no Slack)

- **Happy path:** a new claim/correction creates a Linear issue (§6.1) → **Linear's native email notifications** alert the assignee (Chris/Bill). New review submissions surface via the Phase 5 admin **pending badge** + queue. No custom email, no Slack.
- **Failure path:** an **admin email** on a persistent Linear-pipeline failure (§6.2), plus a Datadog alert and the stuck-row in `/admin/requests`.

---

## 11. Observability (Phase 6.12)

Parity with AECI-66 / AECI-141 / AECI-180 / AECI-206. Metrics (`aeci.*`): request→Linear creation success/failure, webhook receipts + HMAC failures, site→Linear sync errors, reconciliation backlog (stuck-row count), ban actions. Dashboard "Phase 6 — Requests/Moderation"; alerts on pipeline failure, stuck-row backlog, webhook HMAC failures; runbook entries.

---

## 12. Testing

- **Linear client**: issue creation (mocked GraphQL), idempotency, failure → retry + email path.
- **Webhook**: HMAC verify (valid/invalid signature → 401), payload → `workflow_transition` + status mapping.
- **domain-match + dedup**: compute correctness (match/mismatch; duplicate vs not).
- **Admin**: non-admin → 403/404; resolve/reject → status + transition + site→Linear sync.
- **RLS**: `vendor_requests`/`workflow_*` admin-only (extend the AECI-90 harness).
- **e2e**: submit request → Linear issue (mock) → inbound webhook → status sync → admin resolve.

---

## 13. Companion-doc reconciliations (land with Phase 6.1)

- **`STAGE_1_SPEC.md` §12** — n8n → Cloudflare Worker banner (§4 above).
- **§22.1** — Slack alert line → Linear + email (no Slack).
- **§26.3** — note the Stage-1 lean relaxation (recorded transitions, not a guarded FSM).
- **§16 Phase 6** — expand to the 6.1–6.13 breakdown.
- **`CLAUDE.md`** — index the Phase 6 spec; correct the "Workflow automation: n8n" stack line.

---

## 14. Phase 7 handoff

Phase 6 leaves for Phase 7: **Resend** transactional email (the permanent home of the §6.2 failure-alert email + the §5.4 account-deletion email — landed in AECI-240 / Phase 7.5, `docs/email.md`; specced as "Loops", built on Resend), **WAF rate limits** on the public request endpoints, and the **daily data-quality job** (§23.1).

---

## 15. Issue breakdown (AECI Phase 6.1–6.13)

| # | Issue | Depends on |
|---|---|---|
| 6.1 | Write this spec + reconcile §12 / §22.1 / §26.3 / §16 / CLAUDE.md | — |
| 6.2 | Lean workflow tracking — `appendWorkflowTransition()` + instances on request/review submit | 6.1 |
| 6.3 | Retrofit `review_moderation` transitions onto Phase-5 review submit + moderation | 6.2, (Phase 5 AECI-197/204) |
| 6.4 | Linear client + issue creation on submit (templates, labels, assignee, idempotent) + failure handling | 6.2 |
| 6.5 | `POST /api/webhooks/linear` (HMAC → `workflow_transitions` + status) | 6.2 |
| 6.6 | Site → Linear sync on admin resolve/reject | 6.4 |
| 6.7 | Reconciliation sweep (cron) for stuck requests + admin email | 6.4 |
| 6.8 | domain-match + duplicate flags on submit (informational) | 6.1 |
| 6.9 | `GET /api/admin/requests` + resolve/reject actions API | 6.1, (Phase 5 AECI-196) |
| 6.10 | `/admin/requests` dashboard UI | 6.9, (Phase 5 AECI-203) |
| 6.11 | Reviewer ban management (admin set `banned_at` + repeat-offender prompt) | (Phase 5 AECI-203/196) |
| 6.12 | Phase 6 observability | 6.4, 6.5 |
| 6.13 | Phase 6 completion checkpoint | all |
