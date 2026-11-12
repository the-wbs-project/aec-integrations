# ADR 0054: A published legal version is a D1 record, its PDF is built in CI and fixed by hash, and its flags are the operator's

- Status: Accepted. Built as AECI-1688 (step 2 of the change-notice rebuild).
- Date: 2026-11-12
- Issue: AECI-1688. Counsel's Q3 answer of 2026-11-05 (what a change notice must carry). Built on AECI-1610 (upcoming versions and their pages).
- Relates to: ADR 0016 (`db.batch`), ADR 0022 (audit in the same batch), ADR 0026 (rate limits on writes); `STAGE_1_SPEC.md` §27.3 to §27.5, `ADMIN_PANEL_SPEC.md` §5.22, `DATABASE_SCHEMA.md` §8.6i, `API_CONTRACTS.md` §6.10 "Legal versions", the legal `README.md`

## Context

Counsel's Q3 answer says a change notice counts only if it names the version and its effective
date, summarises every material change, links a fixed copy of that version and attaches a copy
the customer can save. The Vendor Terms and the Managed plan agreement promise that. Three later
issues need one place that says a version was announced: the notice email (AECI-1620), the
acceptance screen (AECI-1677) and reader accounts (AECI-1637).

Before this change nothing recorded an announcement. The manifest (`LEGAL_UPCOMING`, AECI-1610)
says a version's text is published ahead of its date, but not that anyone decided what it means
for customers, or what file they would be sent.

## Decision

1. **A published version is a row in `legal_versions`, written once.** `POST
   /api/admin/legal-versions` from `/admin/legal` inserts it with its `legal_version.published`
   audit row in one `db.batch`. The unique `(document, version)` index makes a second publish, or
   the loser of a race, a `409`. Nothing edits or deletes a row. The version and its day are read
   from `LEGAL_AGREEMENT_UPCOMING_VERSIONS`, never typed.
2. **The PDF is built in CI and fixed by its hash.** `legal-pdf.yml` (dispatch only, behind the
   tier's GitHub environment) prints the version file with Playwright, refuses a blank
   `effective_date`, and uploads to `UPLOADS` at `legal/<slug>/v<version>.pdf`. It refuses to
   overwrite an object that exists. The publish checks the object (present, `%PDF-`, at most
   5 MB, size checked on `head` first) and records the sha256 and size of the exact bytes it read.
   Any later reader must re-hash and compare, so a changed file is caught rather than sent. The key is
   built from code constants after the upcoming check, never from the request.
3. **The two flags are the operator's call, asked with no default.** `material` (the change is
   summarised and noticed) and `requires_acceptance` (an owner seat must accept before it applies:
   for the Vendor Terms a change to liability, indemnity, disputes or the content license; for the
   Managed plan agreement a material change monthly customers click to accept). Acceptance implies
   material. The page asks both as Yes/No radio groups with nothing chosen, and the confirmation
   says what each answer causes.
4. **The effective moment is 12:00 UTC on the manifest's day.** One shared helper,
   `legalEffectiveAtMs`, sets `effective_at` and measures the 30-day window. Midnight UTC is the
   evening before in the Americas, which would start a version early there and shorten the notice.
5. **Publishing is switched per tier.** `LEGAL_PUBLISH_ENABLED` is `"true"` on local and staging,
   `"false"` on demo and production, so a publish cannot stand in for the legal README's list of
   issues that must ship before any effective date. AECI-1677 turns production on.
6. **This step sends nothing.** No email, no queue message, no purge. AECI-1620 adds the notice
   fan-out and fills `notice_enqueued_at` and `notice_vendor_count`.

## Alternatives rejected

- **A frontmatter flag for "published".** It would have to be edited out of the text on bump day,
  and the text must stay as published. The manifest marks a version upcoming; the row marks it
  announced.
- **Render the PDF in the Worker.** No PDF library fits the Worker's limits, and Browser
  Rendering would add a billed binding for a job that runs a few times a year.
- **One "material" checkbox, ticked by default.** An unthinking click would have recorded a
  material change. Two questions with no default force a decision on each.
- **Midnight UTC.** See decision 4.
- **A CHECK on `document` or `expedited_reason`.** A CHECK change on D1 is a table recreate. Zod
  owns the vocabulary, the house rule for enum-like text.

## Consequences

- A version cannot be published until its file, manifest entries, deploy and PDF all exist, in
  that order (legal README "Publishing an upcoming agreement version").
- A mistaken publish cannot be undone from the page. Fixing one needs a new version, or a
  hand-run D1 statement with its own audit row.
- The PDF in R2 must never be replaced after publish. The workflow refuses, and a manual
  `wrangler r2 object put` would be caught only by a reader that re-hashes, which every reader
  of the PDF must do.
