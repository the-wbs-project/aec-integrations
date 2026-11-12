# ADR 0054: A published legal version is a D1 record, its PDF is built in CI and fixed by hash, and its flags are the operator's

- Status: Accepted. Built as AECI-1688 (step 2 of the change-notice rebuild). Extended by AECI-1620 (step 3, decision 7: the notice).
- Date: 2026-11-12
- Issue: AECI-1688, AECI-1620. Counsel's Q3 answer of 2026-11-05 (what a change notice must carry). Built on AECI-1610 (upcoming versions and their pages).
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
2. **The PDF is built in CI and fixed by its hash.** `legal-pdf.yml` (dispatch only, from `main`
   only, behind the tier's GitHub environment) prints the version file with Playwright, with page
   JavaScript off, refuses a blank
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
6. **The publish alone sends nothing.** AECI-1688 added no email, queue message or purge.
   AECI-1620 added the notice, decision 7.
7. **The change notice (AECI-1620, 2026-11-12).**
   - **A queue, one message per company.** After a material publish commits, inside `waitUntil`,
     the route reads the audience and `sendBatch`es one `{ legalVersionId, vendorId }` message per
     company onto `aeci-legal-notice-{env}`, in chunks of 100. The same Worker consumes it. A
     non-material version enqueues nothing. Vendor Terms: every company with an unbanned seat,
     to every seat and the billing email. Managed plan: every company with a live subscription of
     any source, to the owner seats and the billing email. A grant or complimentary company gets
     it as information (ruled by Chris).
   - **The outcome is on the row.** The fan-out's result lands in `notice_enqueued_at` (set only
     when every company was queued) and `notice_vendor_count` (how many were), with a
     `legal_version.notice_queued` audit row in one batch. A failed audience read or queue send
     leaves `notice_enqueued_at` NULL with the partial count, so `/admin/legal` says the send did
     not finish.
   - **The dedupe key holds the company id.** Each address is reserved in `notification_sends`
     as `legal-terms-change:{document}:{version}:{vendorId}:{recipientHash}`. An address that is
     the billing email of two companies gets one notice per company, because each is that
     company's notice. A `failed` send releases its key and the message retries, so the retry
     reaches only the failed addresses.
   - **The hash is checked at send time.** The consumer reads the PDF once per message and
     compares its sha256 with `pdf_sha256`. A mismatch, a missing file or a missing site URL sends
     nothing and retries: an email without the fixed copy or the link would not be the notice the
     agreements promise.
   - **Never a partial company.** Seat addresses come from `fetchAuthUserEmailsResult`. An
     unavailable lookup retries the message instead of acking it with seats missing.
   - **Re-send.** `POST /api/admin/legal-versions/:id/notice` re-reads the audience and
     re-enqueues every company, then writes the outcome with a `legal_version.notice_resent`
     audit row in one batch. The keys make it safe. It is the recovery for a failed queue and for
     a message the queue dropped after three retries (no dead-letter queue, like every other
     queue here). It refuses a non-material version and one already in effect.
   - **The copy restates the agreements and goes no further.** The Managed plan acceptance ask to
     monthly card customers says nothing about what happens without an acceptance, because that
     sentence of the agreement is being rewritten by the legal stream.

7. **A wrong PDF is fixed before publish, never after.** The run keeps the PDF as an artifact and
   names the commit, slug, version and env in its summary. The operator opens it and checks that
   the commit's upcoming file is the text the tier serves. A wrong file found before publish is
   deleted from the tier's bucket (`wrangler r2 object delete`) and the workflow re-run, because the
   workflow never overwrites. After publish the stored file is never replaced: its hash is on the
   row. A wrong published text is a new version. The commands are in the legal README.

## Alternatives rejected

- **A frontmatter flag for "published".** It would have to be edited out of the text on bump day,
  and the text must stay as published. The manifest marks a version upcoming; the row marks it
  announced.
- **Render the PDF in the Worker.** No PDF library fits the Worker's limits, and Browser
  Rendering would add a billed binding for a job that runs a few times a year.
- **One "material" checkbox, ticked by default.** An unthinking click would have recorded a
  material change. Two questions with no default force a decision on each.
- **Midnight UTC.** See decision 4.
- **Send the notice inline from the publish request** (AECI-1620). A company can hold many
  seats, each send can carry a 5 MB PDF, and a request has a connection and time budget. The
  queue spreads the work and gives retries.
- **One notice per address across companies** (the first build's key, without the company id).
  The second company's notice would never be sent, so that company would have no notice of its
  own terms.
- **Ack a message when the seat lookup is degraded** (the first build). The missing seats would
  never be told.
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
