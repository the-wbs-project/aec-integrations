# ADR 0003: Linear over Huly for issue tracking

**Status:** Accepted
**Date:** Phase 1 setup · **Recorded:** 2026-06-01
**Context owner:** _unset — confirm_

> _Rationale reconstructed from repo evidence during the 2026-06-01 audit; confirm the head-to-head._

---

## Context

The project needed an issue tracker to drive the dev workflow: branch creation, PR-status sync, automation, and an API an LLM/agent can read (the `spec-anchor` skill parses issues; n8n posts to it). Linear and the open-source, self-hostable **Huly** were the candidates.

## Decision

Use **Linear** (team `AECI`). The workflow is Conductor → Linear → GitHub branch → PR, with `Closes AECI-N` auto-closing issues on merge, ~~an n8n **native Linear node** for the Phase 6 request/moderation automation~~, and the `**Spec section:** §X.Y (docs/SPEC_NAME.md)` convention in issue templates that `spec-anchor` parses (Linear's plan lacks custom fields, so the convention lives in the description).

## Consequences

- ➕ Mature, hosted GitHub integration (branch linking, PR-status mapping) with zero self-hosting burden.
- ➕ First-class GraphQL API — which is what the automation ended up using directly, after n8n was dropped.
- ➖ Hosted/commercial — no self-hosting, data lives in Linear.
- ➖ The `§X.Y` spec-section convention is a workaround for the plan's missing custom-field feature. The grammar and the checked-in mirror of the templates are `docs/linear-issue-conventions.md`.
- ➖ **The templates live only in Linear, so they drift with nothing in git to catch it.** Between 2026-05-13 and 2026-09-11 the Build template asked for `**Spec:**` while every consumer looked for `**Spec section:**`. Mitigated, not fixed, by the checked-in mirror (AECI-601).

> **Amendment (2026-09-11, AECI-601).** **n8n was dropped** — the Phase 6 request pipeline is a Cloudflare Worker calling Linear's GraphQL API directly (`apps/api/src/lib/linear.ts`, `docs/STAGE_1_PHASE_6_SPEC.md`), and there is no Slack leg. The native-Linear-node rationale above is struck; the rest of the decision stands and Linear is unaffected by it. Two of the four issue templates were retired the same day — see `docs/linear-issue-conventions.md` §4.
