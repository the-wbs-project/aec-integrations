# Legal documents

Markdown source of truth for the four launch-required legal pages (AECI-237, Phase 7.2).
These files are the **canonical, versioned source** for the `/legal/*` pages — the site renders
the current version of each on SSR. See `STAGE_1_SPEC.md` §13 (required documents) and §27
(lifecycle) for the governing spec.

> **These files are NOT loaded as runtime assets.** They are inlined into the bundle at build
> time via the esbuild `text` loader (`"loader": { ".md": "text" }` in `apps/web/angular.json`)
> and parsed by the content registry at `apps/web/src/app/legal/legal-content.ts`. Editing a file
> here changes the rendered page on the next build/deploy.

## Files ↔ routes

The route slug (short, public, set by the footer links) maps to a long filename per spec §27.1.
The mapping lives in `legal-content.ts`:

| Route (public)              | Source file                   | Frontmatter `title`     |
| --------------------------- | ----------------------------- | ----------------------- |
| `/legal/terms`              | `terms-of-service.md`         | Terms of Service        |
| `/legal/privacy`            | `privacy-policy.md`           | Privacy Policy          |
| `/legal/review-guidelines`  | `review-guidelines.md`        | Review Guidelines       |
| `/legal/listing-accuracy`   | `listing-accuracy-policy.md`  | Listing Accuracy Policy |

## Frontmatter

Each file opens with a YAML frontmatter block (scalar keys only — parsed by the hand-rolled
`parseFrontmatter` in `legal-content.ts`, not a YAML library):

```yaml
---
title: Privacy Policy
version: 1.0
effective_date: 2026-08-01      # blank while a doc is an unapproved draft
last_updated: 23 June 2026
counsel_approved_by:            # blank until counsel signs off
counsel_approved_on:            # blank until counsel signs off
linear_issue: AECI-237
---
```

`title`, `version`, and `last_updated` render in the page header. `effective_date` renders only
when present. Dates are authored **pre-formatted as display strings** — never parsed/reformatted
at render time (that would be an SSR/CSR hydration and edge-cache trap).

## Status: pre-launch drafts

As of AECI-237 these are **template drafts pending counsel review** — the empty
`counsel_approved_*` frontmatter is the machine-readable "unapproved" signal, and each body opens
with a visible "Draft — pending legal review" notice. The counsel review is a human gate tracked
separately and verified at completion checkpoint 7.12; it does not block the page scaffolding.
Bracketed placeholders (e.g. `[Legal entity name]`, `[governing jurisdiction]`) mark the
counsel-specific details that must be filled before launch.

## Change / versioning workflow (spec §27.2)

Git history **is** the version log (§27.3); each version's permalink is its commit hash. To change
a legal document:

1. **Proposed change** — identify the needed update (regulatory change, terminology fix, a new
   feature requiring a policy update).
2. **Linear issue** — open one describing the rationale, scope, and urgency.
3. **Branch + PR** — commit the text change on a branch; open a PR linking the Linear issue.
   Reviewers (and counsel) can read the rendered change on the PR's Cloudflare preview deploy.
4. **Counsel review** — counsel reviews the PR / preview; capture their approval in the Linear issue.
5. **Bump frontmatter** — increment `version`, set `effective_date`, fill `counsel_approved_by` /
   `counsel_approved_on`, update `last_updated`, and remove the draft notice.
6. **Merge** — the new version goes live on the next deploy.
7. **Close the Linear issue** — link the merged PR and note the effective date.

When a change materially affects users, see §27.4 (Stage 2+ may add user notification; Stage 1 has
no persistent accounts to notify).

## i18n

The markdown body is **content**, not UI strings — it is not extracted into `messages.xlf`. Only
the page chrome (title/meta/labels) is `$localize`-wrapped in `legal-page.ts`. Future localization
adds per-locale files (e.g. `terms-of-service.es-ES.md`) selected by the active locale, not message
catalogue entries.
