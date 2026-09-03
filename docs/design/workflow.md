# Design workflow — v0.dev → Angular

> Replaces an abandoned Figma-first approach that was never committed (so there is no prior plan file to remove).

This document is the **how** of getting a screen from idea to shipped UI in this repo. The companion documents define the **what**: see [`v0-system-prompt.md`](./v0-system-prompt.md) and [`v0-porting-rules.md`](./v0-porting-rules.md).

---

## 1. The loop

```
spec section
    │
    ▼
v0 prompt (per-chat, focused on one screen)
    │
    ▼
iterate in v0 (3–6 turns — optimize for visual decisions, not code)
    │
    ▼
save the v0 share link as a comment on the AECI issue
    │
    ▼
Claude Code port to apps/web/src/app/preview/<screen>/
    │   (apply v0-porting-rules.md end to end)
    ▼
preview route registered (dev-only)
    │
    ▼
review: light + dark, desktop + tablet + mobile, verification checklist
    │
    ▼
wire to real data — separate Phase 2 entity-page issue
    │
    ▼
ship
```

Each step has a clearly named owner. (Chris) drives the v0 portion in a browser; Claude Code drives every step in the repo. Step boundaries match the steps in the AECI issue template.

---

## 2. Source files this workflow depends on

Two files are the contract. Update both whenever the workflow changes.

- [`docs/design/v0-system-prompt.md`](./v0-system-prompt.md) — the instructions configured in v0.dev. Currently pasted into **profile-level Custom Instructions** because v0 does not expose project-level Instructions on our plan (verified 2026-05-19); this is only safe because the v0 account is AECi-dedicated. v0 reads this field on every generation. **When you edit this file, re-paste the body into v0's Custom Instructions** — the file is the source of truth, not the v0 UI copy. Stay under the 2000-character limit (the file's prelude shows the recount command).
- [`docs/design/v0-porting-rules.md`](./v0-porting-rules.md) — the React → Angular + Spartan brain + tokens translation table. This is the contract that every port is reviewed against.

Plus two upstream sources:

- [`DESIGN.md`](../../DESIGN.md) (repo root) — the visual system source of truth: type scale, color tokens, spacing, do's and don'ts.
- [`PRODUCT.md`](../../PRODUCT.md) (repo root) — strategic context: audiences, voice, anti-references, principles.

Every port should be coherent with `DESIGN.md` and `PRODUCT.md`. If a v0 design conflicts with either, the design system wins.

---

## 3. What goes in a v0 prompt

Brand colors and aesthetic stance are in the **system prompt** — do not repeat them per chat. Each chat opens with screen-specific facts:

- **Screen purpose** — one sentence. "Vendor detail page for an AEC software directory."
- **Layout regions** with widths — "Three columns on desktop: left 40%, middle 35%, right 25%. Stacks on mobile."
- **Data fields each region needs** — concrete. "Left column: company name, logo, HQ, founded year, public/private status, long description, Crunchbase signals (rank, heat score, categories, monthly visits)."
- **Realistic sample data hint** — "Invent a plausible AEC vendor like 'Bluebeam' or 'Procore'. No lorem ipsum." Realistic copy stress-tests the layout in ways lorem can't.
- **"Research database, not SaaS landing page"** reminder.

Useful follow-up prompts after the first generation are typically about *visual rhythm* and *information density*, not about colors or components:

- "Right column feels disconnected — same visual rhythm as the others."
- "Cards too cramped — more breathing room, lighter borders."
- "Section separation too heavy — subtle borders, not dividers."
- "Move [metric] to where the eye lands first — current position buries it."

---

## 4. What stays out of v0

Don't ask v0 to design these. They're either tied to our infra or are Phase 2+ concerns.

- Real data binding (the API Worker reading Cloudflare D1 via Drizzle).
- Routes beyond the single preview entry — no app shell, no breadcrumbs unless they're part of the visual brief.
- Auth flows, sign-in screens, profile menus.
- i18n machinery — strings will be wrapped in the port.
- Analytics / observability instrumentation (PostHog; Datadog until AECI-651).
- Error states, loading states, empty states (unless the screen brief explicitly calls them out).

---

## 5. Preview routes are dev-only

Ports land at `apps/web/src/app/preview/<screen-name>/<screen-name>.component.ts` and are wired into a `preview.routes.ts` that is **conditionally imported** based on `environment.production === false` (or whatever the equivalent build-time guard is in the current Angular config — verify on each port).

These routes never ship to production. They exist so reviewers can see the port at a stable URL during preview-deploy review. Real entity routes are added in Phase 2 issues, with their own designs that may iterate further from the preview.

---

## 6. Lessons file pattern

Maintain [`docs/design/LESSONS.md`](./LESSONS.md) (append-only). Every ported screen contributes at least one lesson. Format:

```markdown
## YYYY-MM-DD — <Screen name> (AECI-<n>)

**Lesson:** <One-sentence description of what we learned.>

**Context:** <Why this came up — what we tried, what happened.>

**Action:** <What changes in the workflow, porting rules, or system prompt as a result. If "no change", explain why.>
```

A required **Action** line per entry forces every lesson to either change the contract or be explicitly retired. Lessons without consequence rot.

---

## 7. Why not `.context/`

`.context/` is gitignored — see [`/.gitignore`](../../.gitignore) line 4. Conductor uses it for **ephemeral within-workspace handoffs**: scratch files between agents in the same workspace, downloaded attachments, transient working notes. None of that survives the workspace.

Permanent design-workflow artifacts (this file, the porting rules, the system prompt, the lessons log) go under `docs/design/` for three reasons:

1. **They survive across workspaces.** A new agent in a fresh Conductor workspace can read `docs/design/v0-porting-rules.md` and start porting. They cannot read a file that exists only in some other workspace's gitignored directory.
2. **They show up in PR review.** Changes to the porting contract should be reviewable like any other doc change. Drift in a gitignored file is invisible.
3. **They live in the same tracked tree as `docs/STAGE_1_SPEC.md`** and the rest of the source-of-truth documents listed in [`CLAUDE.md`](../../CLAUDE.md). Future agents that read the spec hierarchy find the design workflow alongside it, not in a hidden parallel directory.

The split is:

- **`.context/`** — ephemeral handoffs between agents in *one* workspace (e.g., pasting v0-emitted React code into a scratch file before porting).
- **`docs/design/`** — durable contract artifacts that every workspace needs.

If you find yourself wanting to commit something under `.context/`, that's the signal to move it to `docs/design/` or another tracked location first.
