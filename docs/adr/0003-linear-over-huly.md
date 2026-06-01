# ADR 0003: Linear over Huly for issue tracking

**Status:** Accepted
**Date:** Phase 1 setup · **Recorded:** 2026-06-01
**Context owner:** _unset — confirm_

> _Rationale reconstructed from repo evidence during the 2026-06-01 audit; confirm the head-to-head._

---

## Context

The project needed an issue tracker to drive the dev workflow: branch creation, PR-status sync, automation, and an API an LLM/agent can read (the `spec-anchor` skill parses issues; n8n posts to it). Linear and the open-source, self-hostable **Huly** were the candidates.

## Decision

Use **Linear** (team `AECI`). The workflow is Conductor → Linear → GitHub branch → PR, with `Closes AECI-N` auto-closing issues on merge, an n8n **native Linear node** for the Phase 6 request/moderation automation, and the `**Spec section:** §X.Y` convention in issue templates that `spec-anchor` parses (Linear's plan lacks custom fields, so the convention lives in the description).

## Consequences

- ➕ Mature, hosted GitHub integration (branch linking, PR-status mapping) with zero self-hosting burden.
- ➕ First-class API + a native n8n node for automation.
- ➖ Hosted/commercial — no self-hosting, data lives in Linear.
- ➖ The `§X.Y` spec-section convention is a workaround for the plan's missing custom-field feature (documented in CLAUDE.md).
