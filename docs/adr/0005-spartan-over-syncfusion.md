# ADR 0005: Spartan UI (headless) + Tailwind v4 over Syncfusion

**Status:** Accepted
**Date:** Phase 1 · **Recorded:** 2026-06-01
**Context owner:** _unset — confirm_

> _Rationale reconstructed from repo evidence (CLAUDE.md, `DESIGN.md`) during the 2026-06-01 audit; confirm the head-to-head._

---

## Context

AECi has a strong editorial visual identity (`DESIGN.md` — a token-driven OKLCH palette, "borders, not shadows," Source Serif 4 / the Two-Family Rule) and an accessibility-first requirement. The UI layer had to give **full control over visual tokens** while providing accessible primitives. Candidates: Spartan UI's headless "brain" primitives (on Tailwind v4 + Angular CDK) versus a styled commercial component suite such as **Syncfusion**.

## Decision

Use **Spartan UI brain primitives + Tailwind v4 + Angular CDK** — helm codegen off; primitives styled via Tailwind + the theme tokens. Chosen over Syncfusion.

## Consequences

- ➕ Headless primitives give complete control over design tokens and editorial styling, with accessibility handled by Spartan + CDK.
- ➕ No commercial licensing; Angular-native; aligns with the zoneless / signals stack.
- ➖ More styling work up front — no batteries-included themed components; the team owns the component look.
- ➖ Smaller ecosystem than a commercial suite; some complex widgets (data grids, schedulers) may need building if they become requirements.
