# Design workflow lessons

Append-only log. Every ported screen contributes at least one lesson. See [`workflow.md`](./workflow.md) §6 for the format and why each entry requires an **Action** line.

Newest entries on top.

---

## 2026-06-27 — A "relevance tuning" prototype is a real surface + a diff panel, not a dev tool (AECI-286)

**Lesson:** When the ask is to "think through search relevance tuning," the prototype that lands is
a premium, in-app surface you can *feel*, paired with an engineering diff panel underneath — not a
bare debug table. Chris's standing preference is buyer-facing, toggleable concepts over a dev tool,
even for an inherently engineering-flavored concern like ranking.

**Context:** AECI-286 is the pre-launch think-through of the `SEARCH_RANKING.md` §7 tuning loop (the
real post-launch run, AECI-283, is blocked on go-live and needs real query data). Built as
`/preview/search-relevance`: the real `SearchProductCard`s with rank badges on top (toggle Baseline
/ Ratings-forward / Coverage-weighted / Balanced blend, drag weight sliders), and a signal +
rank-delta table below. It ranks curated AEC fixtures through a pure, unit-tested
`ranking-strategies.ts`, so it runs in any workspace with no Algolia keys; an on-page caveat keeps
it honest (it models `customRanking` client-side, it is not Algolia).

**Action:**

- For a "tuning/relevance" prototype, lead with the real result surface (reuse the shipping cards +
  tokens) and put the signal/diff view second; don't ship the diff table alone.
- Keep the ranking logic pure and framework-free (separate `*.ts` + plain-Vitest spec) so the lab
  needs no live service and every strategy is unit-testable.
- Two AA gotchas the axe pass caught in the diff panel: `--accent-rating` (goldenrod) and
  `--accent-warm` (bone) are icon/background accents, not small-text colors. Use `--text-secondary`
  for numerals and `--accent-secondary-deep` (clay deep) for the "moved down" delta so up/down stay
  distinct and both clear AA.

---

## 2026-06-10 — For multi-concept design selection, default to the in-app `preview/` route, not a `.context/` HTML file (AECI-181, Home design pass)

**Lesson:** When a design pass produces several concepts for the PO to choose between, the
preferred review surface is a **dev-only Angular `preview/` route** running in the real app, not a
self-contained HTML prototype in `.context/`. Chris reviews concepts with the real components,
fonts, theming, and SSR/hydration in front of him.

**Context:** AECI-181's plan offered both formats (a self-contained `.context/` HTML prototype with
concept/theme/state toggles, or a dev-only Angular preview route under `apps/web/src/app/preview/`).
The HTML route is faster to author and doesn't touch the app, so it was built first. Chris's
response: "I wanted you to build all three in preview and then I chose." Selection wasn't blocked
(he opened the HTML and picked Faire), but the standalone file wasn't the surface he wanted to
evaluate in. The `preview/` infrastructure already exists for exactly this (lazy-loaded,
production-blocked via `isPreviewPath`, used for the v0 port loop), so there was a ready home.

**Action:**

- For future multi-concept selection, default to a `apps/web/src/app/preview/<surface>/` route
  registered in `preview.routes.ts`, reusing the real components + tokens, so the PO reviews in the
  running app (`pnpm dev:agent`). Reserve a `.context/` HTML prototype for a fast fallback or when
  the app can't boot.
- State the format choice up front and let Chris redirect **before** building, since the two
  formats are a non-trivial fork in effort.
- Chosen home direction (anchor **Faire**) recorded in `docs/design/home-direction.md`; AECI-190's
  shipped components are the reused Faire vocabulary, keeping the home coherent with `/products`.

---

## 2026-05-19 — v0 share URLs are opaque to WebFetch and to cross-origin iframe inspection (AECI-19, Vendor Detail)

**Lesson:** We cannot pull v0's emitted React code out of a v0 share URL programmatically. `WebFetch` only retrieves the chat transcript text (descriptions of changes), not the file contents. Loading the share URL in a real browser session reveals an iframe at `sb-*.vercel.run` that hosts a VS Code Web editor for the project — cross-origin to v0.app, so its DOM is unreadable, and the actual rendered preview happens at a separate sandbox origin we cannot extract code from.

**Context:** AECI-19 Step 5 anticipated this with a fallback ("ask Chris to paste the v0-emitted code as a comment or into an ephemeral scratch file under `.context/`"). The fallback isn't strictly needed because the porting rules already say "the value of v0 output is the *layout, spacing, hierarchy, and visual decisions* — those translate; the code is reference material, not a starting point" — i.e. we shouldn't be copying v0's code anyway. The chat transcript text gives us enough to port faithfully.

**Action:**

- For future v0 ports, default to extracting the design from the chat transcript (use a browser session to load the share URL and read v0's own iteration summaries) and the live preview iframe screenshot. Skip code extraction.
- If the live preview iframe URL is needed for a side-by-side visual diff, scrape it from the v0 chat page's `iframe[src*="vercel.run"]` element — but it points to a code editor frame, not the running app; for the *running app*, screenshot from v0's preview pane in the browser.
- Cached the Vendor Detail design brief at `.context/v0-vendor-detail-brief.md` for traceability. `.context/` is gitignored, so this is a workspace-local note — fine for this purpose since the canonical contract is the chat itself, not our paraphrase of it.

---

## 2026-05-19 — Un-layered global rules in `styles.css` beat layered Tailwind utilities (AECI-19, Vendor Detail)

**Lesson:** `apps/web/src/styles.css` declares `a { color: var(--accent-primary); }` as an un-layered rule. Tailwind v4 utilities live inside cascade layers, and un-layered styles win over layered ones in CSS regardless of selector specificity. So `<a class="text-(--surface-base)">` keeps the global Forest text color and the label disappears against a Forest button background.

**Context:** The first port attempt placed an `<a brnButton>` Visit-website button on top of `bg-(--accent-primary)`. With white text expected, the link rendered as a green box with no visible label. The fix in this PR was a Tailwind v4 `!` override on the link's color utility — `!text-(--surface-base)` plus `hover:!text-(--surface-base)`. The `spartan-demo.ts` reference component sidestepped this because it uses `<button>` not `<a>`, so the global `a` rule never applied.

**Action:**

- When porting any v0 link styled as a CTA, default to the `!`-prefixed color utility on `<a>` elements, or use a `<button>` if the destination is internal.
- Consider an upstream fix on `styles.css` to wrap the global `a` rule in `@layer base { ... }` so it loses to Tailwind utilities by default. Out of scope for AECI-19; flag as a follow-up if more anchor-styled CTAs appear in Phase 2.

---

## 2026-05-19 — Spartan brain `<brn-popover>` is a block element by default and breaks CSS Grid layouts (AECI-19, Vendor Detail)

**Lesson:** Placing `<brn-popover>` directly inside a CSS Grid container makes the popover claim a grid cell, pushing the intended right-column content to a new row. The directive selector matches both `[brnPopover]` and `<brn-popover>`, and the latter renders a real DOM element with default `display: block`.

**Context:** Each product card uses `grid grid-cols-[1fr_auto]` with logo/name/description on the left and a review-score "hero" on the right. The first port placed each `<brn-popover>` (for the score-distribution popover and the rankings popover) as a sibling of the two grid cells. The popover element took its own grid track and pushed the score hero into a third row beneath the description, breaking the v0 brief's two-column card layout.

**Action:**

- For Spartan brain primitives that use a `<brn-…>` host element and whose visible content lives in `<ng-template brn…Content>`, add `class="contents"` (Tailwind for `display: contents`) to the host element when it sits inside a grid or flex container that should ignore it. The popover trigger button still owns the layout slot; the popover host is functionally invisible until the template opens.
- Same trick applies to `<brn-dialog>` in similar layouts.

---

## 2026-05-19 — v0.dev's Instructions field is profile-scoped on our plan (AECI-19)

**Lesson:** v0.dev does not expose a project-level Instructions field on our current plan; the only available option is profile-level **Custom Instructions** at [v0.dev account settings](https://v0.dev/chat/settings/account), which applies to every chat across every project under the account. There is also a hard 2000-character limit on the field — the original v0-system-prompt.md body was 2522 chars and had to be compressed.

**Context:** AECI-19 Step 3 originally said to paste the prompt into "project settings → system prompt". Neither piece of that mapped to reality:

1. There is no UI field called "System Prompt" — it's "Custom Instructions".
2. Project-level Custom Instructions isn't available on this plan, so the field can only be configured at profile scope.
3. Even at profile scope, v0 caps the value at 2000 characters and refuses to save longer values.

Putting AECi-specific instructions at profile scope is acceptable only because the v0 account is AECi-dedicated. The moment any non-AECi work runs in the same account, this becomes wrong — the prompt would silently apply to unrelated chats.

**Action:**

- `v0-system-prompt.md` prelude rewritten to call out: profile scope, 2000-char limit, two fallbacks (per-chat first message, or recheck plan upgrades), and the recount command.
- Body compressed from 2522 → 1915 chars while preserving all six required sections.
- `workflow.md` §2 updated to describe where the prompt is actually pasted and under what constraints.
- AECI-19 Step 3 in Linear rewritten to match v0's real UI terminology and limits, so the next contributor doesn't repeat the hunt.
- Re-check v0's plan offering every quarter; if project-level Instructions becomes available, migrate to it and remove the dedicated-account caveat.

---

## 2026-05-19 — Workflow bootstrap (AECI-19)

**Lesson:** Permanent design-workflow artifacts must live under `docs/design/`, not `.context/`. The original AECI-19 description told agents to commit four files under `.context/` and delete one — every one of those instructions was a no-op because `.context/` is gitignored.

**Context:** The first version of AECI-19 was written assuming `.context/` was a tracked directory. It isn't (see `.gitignore` line 4 — `.context/` is intentionally reserved for ephemeral within-workspace handoffs in Conductor). Future agents following the original instructions would have written the files locally, run `git add`, watched them get silently skipped, and the next workspace would have started over from empty. The "delete the abandoned Figma plan" step was also moot — the Figma plan was never committed for the same reason.

**Action:**

- AECI-19 description rewritten to point all permanent artifacts at `docs/design/` (`v0-system-prompt.md`, `v0-porting-rules.md`, `workflow.md`, `LESSONS.md`).
- `workflow.md` §7 codifies the `.context/` vs `docs/design/` split so this confusion doesn't recur.
- For future issues: when a Linear issue says to commit something under `.context/`, that's an issue-template bug — flag it and propose the tracked path.

---

## 2026-05-19 — Token names in the porting rules must match the codebase, not the issue text (AECI-19)

**Lesson:** When the porting rules reference theme tokens, they must reference the actual token names from `apps/web/src/styles.css`, not whatever placeholder names an issue description guessed. The Tailwind utility syntax is also fixed by codebase convention — verify it before writing rules.

**Context:** AECI-19's description guessed token names like `--bg`, `--fg`, `--forest`, `--clay`, `--border`, `--card`, `--muted-fg` and proposed a `bg-[hsl(var(--bg))]` class syntax. The reality in the repo (set by AECI-24) is different:

- Tokens are `--surface-base`, `--surface-raised`, `--surface-sunken`, `--border-default`, `--border-strong`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--accent-primary`, `--accent-primary-hover`, `--accent-secondary`, `--accent-warm`.
- The class syntax used in the existing demo component (`apps/web/src/app/demo/spartan-demo.ts`) is Tailwind v4's paren shortcut: `bg-(--accent-primary)`, `text-(--text-primary)`, `border-(--border-default)`.

Writing the porting rules against the placeholder names would have produced a contract that no component could satisfy.

**Action:**

- `v0-porting-rules.md` §1 uses the real token names and the real Tailwind v4 paren syntax, with `apps/web/src/styles.css` cited as the source of truth.
- Before extending the porting rules to a new concern (typography utilities, spacing scale, icon system), check the codebase first and cite the file. Don't trust placeholder names from issue text.

---

> _Vendor Detail port lessons (AECI-19 Step 5) will be appended above this line once the port lands._
