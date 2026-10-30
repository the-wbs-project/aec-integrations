# Legal documents

Markdown source of truth for the `/legal/*` pages: the four launch-required ones (AECI-237, Phase 7.2)
and the two vendor agreements from `docs/VENDOR_SIGNUP_PROCESS.md` §4 (AECI-1359, AECI-1360).
These files are the **canonical, versioned source** for the `/legal/*` pages — the site renders
the current version of each on SSR. See `STAGE_1_SPEC.md` §13 (required documents) and §27
(lifecycle) for the governing spec.

> **These files are NOT loaded as runtime assets.** They are inlined into the bundle at build
> time via the esbuild `text` loader (`"loader": { ".md": "text" }` in `apps/web/angular.json`)
> and parsed by the content registry at `apps/web/src/app/legal/legal-content.ts`. Editing a file
> here changes the rendered page on the next build/deploy.

## Files ↔ routes

The route slug (short, public, set by the footer links) maps to a long filename per spec §27.1.
The mapping lives in `LEGAL_SOURCE_FILES` (`app/legal/legal-manifest.ts`):

| Route (public)                  | Source file                   | Frontmatter `title`     |
| ------------------------------- | ----------------------------- | ----------------------- |
| `/legal/terms`                  | `terms-of-service.md`         | Terms of Service        |
| `/legal/privacy`                | `privacy-policy.md`           | Privacy Policy          |
| `/legal/review-guidelines`      | `review-guidelines.md`        | Review Guidelines       |
| `/legal/listing-accuracy`       | `listing-accuracy-policy.md`  | Listing Accuracy Policy |
| `/legal/vendor-terms`           | `vendor-terms.md`             | Vendor Terms            |
| `/legal/managed-plan-agreement` | `managed-plan-agreement.md`   | Managed Plan Agreement  |
| `/legal/terms/v1.0` (archive)   | `versions/terms/v1.0.md`      | Terms of Service        |
| `/legal/privacy/v1.0` (archive) | `versions/privacy/v1.0.md`    | Privacy Policy          |
| `/legal/vendor-terms/v1.0` (archive) | `versions/vendor-terms/v1.0.md` | Vendor Terms |
| `/legal/managed-plan-agreement/v1.0` (archive) | `versions/managed-plan-agreement/v1.0.md` | Managed Plan Agreement |

## Frontmatter

Each file opens with a YAML frontmatter block (scalar keys only — parsed by the hand-rolled
`parseFrontmatter` in `legal-frontmatter.ts`, not a YAML library):

```yaml
---
title: Privacy Policy
version: 1.0
effective_date: 2026-08-01      # blank while a doc is an unapproved draft
last_updated: June 23, 2026
counsel_approved_by:            # blank until counsel signs off
counsel_approved_on:            # blank until counsel signs off
linear_issue: AECI-237
---
```

`title`, `version`, and `last_updated` render in the page header. `effective_date` renders only
when present. Dates are authored **pre-formatted as display strings** — never parsed/reformatted
at render time (that would be an SSR/CSR hydration and edge-cache trap). Write them in US format,
"Month D, YYYY" (for example `October 10, 2026`), the same as `methodology.md` (AECI-1262). Copy is
US English throughout.

## Status: pre-launch drafts

These remain **drafts pending counsel review** (AECI-308). The `counsel_approved_by` /
`counsel_approved_on` frontmatter now carries the literal marker `pending sign-off` — the
machine-readable "not yet approved" signal (it was blank as of AECI-237) — and each body still
opens with a visible "Draft, pending legal review" notice. The Privacy Policy's notice is shortened
to "Pending Legal Review", because Google's OAuth brand review read "not yet in force" as no
policy at all. It also carries the "Signing in with Google" disclosure that review requires.
`effective_date` stays blank until launch. The counsel review is a human gate tracked separately and verified at completion
checkpoint 7.12; it does not block the page scaffolding.

The governing law and venue in `terms-of-service.md` are filled with the **AECI-306** values
(State of Florida; state courts of Martin County, Florida, plus the U.S. District Court for the
Southern District of Florida), applied under **AECI-312** on October 14, 2026 (ToS v1.1). The
operator legal entity (The WBS Project, Inc.) and registered address in `privacy-policy.md`, and
the entity name in every operator definition, were committed on October 28, 2026 (the AECI-306
values, applied in the legal week-0 pass). The Privacy Policy's opening now states it is written for
United States law; the full GDPR-section removal is still **AECI-309**. The same pass bumped the
vendor terms and the Managed plan agreement to v1.1 (**AECI-1428**: when Managed ends, the fields
stay the vendor's), disclosed the Cloudflare Web Analytics page-load count (**AECI-1472**),
softened the Terms' taxonomy IP claim to a compilation claim (**AECI-1135**), and added the
vendor-maintained-listings sentences to the Terms (from AECI-1023, via AECI-308). On October 29,
2026 **AECI-1431** added a sentence to the Managed plan agreement's "Refunds" section, still in the
v1.1 draft: a charge we made in error is always reversed, outside the 14-day window. Counsel should
check it with the rest of the draft. The pricing rules behind it are `docs/PRICING_RULES.md` §5. The same day
**AECI-1228** added a line to the Privacy Policy's "Retention" list: our own visit record is copied to
a long-term archive before its 400-day deletion and kept indefinitely (ADR 0050). It went into the v1.1
draft in place, without a bump, because that draft has never taken effect.

**AECI-1540** covered private row threads between two companies in all three v1.1 drafts: the
vendor terms' confidentiality and personal-data sections, the Privacy Policy's collection, sharing,
retention and deletion sections, and the Terms' acceptable use. The governing spec is
`docs/STAGE_2_ATTESTATIONS_SPEC.md` §15.15. Counsel is asked whether a message body may be kept
after its author deletes their account.

**DMCA designated agent: registered** with the U.S. Copyright Office DMCA Designated Agent
Directory on October 28, 2026 (**AECI-305**, registration number DMCA-1084399), as the role
"Copyright Agent, The WBS Project, Inc." at the address and `copyright@thewbsproject.com` printed in
the Terms' "Copyright complaints" section. The directory entry and the Terms block must stay
identical; change both together. The registration **lapses on October 28, 2029** unless renewed
before then, and a lapse loses the §512 safe harbor for user reviews.

**Arbitration / class-action waiver: decided against** (AECI-312, October 14, 2026). Disputes go
to the courts named above. Rationale is on the issue; revisit if user volume grows.

## Versions and URLs (spec §27.3, AECI-1361)

Every version has a stable URL. The repo is private, so git history is not the public version log.

| What                | Where                                   | URL                          |
| ------------------- | --------------------------------------- | ---------------------------- |
| Current version     | `<name>.md` (this folder)               | `/legal/<slug>`              |
| Superseded version  | `versions/<slug>/v<version>.md`         | `/legal/<slug>/v<version>`   |

- An archive file is the superseded version's **final text, copied unchanged**, frontmatter
  included. Recover it with `git show <sha>:apps/web/src/content/legal/<name>.md`, where `<sha>`
  is the last commit before the bump.
- The current pointer is the current file's frontmatter `version`. `currentLegalVersion(slug)` in
  `app/legal/legal-content.ts` reads it. The shared agreement map
  (`LEGAL_AGREEMENT_CURRENT_VERSIONS`, `packages/shared/src/api/agreements.ts`) must equal it for
  the vendor terms and the Managed plan agreement; a spec checks this.
- Each archive is listed in `LEGAL_ARCHIVES` (`app/legal/legal-manifest.ts`) with its superseded
  date: the date of the commit that bumped the current file. That manifest generates the archive
  routes and holds them out of the index (`NOINDEX_PATH_PREFIXES`).
- An archive page opens with "This is version X, superseded on <date>. Read the current version."
  It is noindex, canonicalises to the current page, and is not in `sitemap.xml`.
- Every current file **ends with** `## Change history`: one list line per version, naming
  `Version X.Y` once. Give the effective date, or say "draft, never in force" for a version that
  never took effect. A superseded version's line links its archive URL and gives its superseded
  date. For example:

  ```markdown
  ## Change history

  - **Version 1.1** (this version): draft, not yet in force.
  - [Version 1.0](/legal/terms/v1.0): draft, never in force. Superseded October 14, 2026.
  ```

- The registry (`app/legal/legal-versions.ts`) checks all of this at module init. A version
  collision, a filename/frontmatter mismatch, an archive missing from the manifest, an archive not
  listed in the change history, or a listed version or link that does not resolve throws and
  fails `ng test`.

**When to bump.** Once a version is in force (`effective_date` set), any text change is a new
version: bump and archive. While a document is still a draft that never took effect, a wording
fix may be made in place without a bump; update `last_updated`. AECI-1361 did this for the four
launch documents when it replaced the "public commit log" sentence.

## Change workflow (spec §27.2)

Most changes to these files start as a code change somewhere else. `docs/LEGAL_IMPACT_REVIEW.md`
maps each behaviour the app changes to the section here that describes it, and every plan and PR
states a `Legal impact` verdict against it. A `text` verdict is step 1 below.

To change a legal document:

1. **Proposed change** — identify the needed update (regulatory change, terminology fix, a new
   feature requiring a policy update).
2. **Linear issue** — open one describing the rationale, scope, and urgency.
3. **Branch + PR** — commit the text change on a branch; open a PR linking the Linear issue.
   Reviewers (and counsel) can read the rendered change from the diff, or by running the branch locally. There is no per-PR preview deploy (retired 2026-10-10, AECI-1268).
4. **Counsel review** — counsel reviews the PR diff; capture their approval in the Linear issue.
5. **Bump frontmatter** — increment `version`, set `effective_date`, fill `counsel_approved_by` /
   `counsel_approved_on`, update `last_updated`, and remove the draft notice. Archive the
   superseded text and add its `## Change history` line in the same PR (see above).
6. **Merge** — the new version goes live on the next deploy.
7. **Close the Linear issue** — link the merged PR and note the effective date.

When a change materially affects users, see §27.4 (Stage 2+ may add user notification; Stage 1 has
no persistent accounts to notify).

## i18n

The markdown body is **content**, not UI strings — it is not extracted into `messages.xlf`. Only
the page chrome (title/meta/labels) is `$localize`-wrapped in `legal-page.ts`. Future localization
adds per-locale files (e.g. `terms-of-service.es-ES.md`) selected by the active locale, not message
catalogue entries.
