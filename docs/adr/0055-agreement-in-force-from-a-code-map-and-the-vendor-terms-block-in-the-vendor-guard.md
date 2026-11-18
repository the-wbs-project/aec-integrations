# ADR 0055: An agreement is in force from a dated code map or a published row, drafts never are, and the Vendor Terms block lives in the vendor guard

- Status: Accepted. Built as AECI-1677.
- Date: 2026-11-12
- Issue: AECI-1677. Counsel's Q42 answer and Chris's rulings 24 and 25 of 2026-11-11; counsel Q3 (the Managed plan click).
- Relates to: ADR 0054 (`legal_versions`), ADR 0016 (`db.batch`), ADR 0022 (audit in the same batch), ADR 0026 (rate limits on writes); `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24, `VENDOR_SIGNUP_PROCESS.md` §4, `AUTH_AND_RLS.md`, `API_CONTRACTS.md` §6.14 "Legal acceptance"

## Context

Every Vendor Terms acceptance in production was given against a draft whose page said it was not
in force. Counsel (Q42) says the 30-day change email cannot move those vendors onto the final
version. Each company must tick the box again. Ruling 24: until an owner seat accepts the version
in force, the portal opens only the acceptance screen. Ruling 25 and Vendor Terms 1.3 text item
13.12: a rights-reducing change applies to a company only after an owner seat accepts it.

Three things were missing. The API Worker could not tell whether a version is in force, because
it cannot read the Markdown frontmatter. Nothing could tell an acceptance of a draft from one of a
final text when both carry the same version number. And nothing stopped a blocked company acting
through the API while the portal showed only the screen.

A bug in any of these locks every vendor out of the portal. Today no document is in force.

## Decision

1. **In force comes from code or from a published row.** `LEGAL_AGREEMENT_EFFECTIVE_ON` in
   `@aeci/shared` holds each known version's effective day, mirrored from its frontmatter by a web
   spec. A `legal_versions` row dates a published version. A version is in force from 12:00 UTC
   of that day (`legalEffectiveAtMs`). Nothing in force means nothing pending and nothing blocked,
   for every seat. Three specs pin that invariant.
2. **A draft is never in force, for good.** The versions dated `null` today stay `null`
   (`agreements.spec.ts`). An acceptance of one never counts. The effective-date change must
   therefore bump to a new version, so "accepted 1.3" can never mean both a draft and a final text.
3. **The block is in the vendor guard, on writes only.** On a vendor write, `findVendorProfile`
   reads the Vendor Terms rows and the company's acceptances in the same batch it already runs,
   and a blocked company gets `403 LEGAL_ACCEPTANCE_REQUIRED`. Two routes opt out with
   `allowTermsPending`: the accept, and the Stripe portal link. Reads stay open. The portal shell
   hides the tabs while blocked, and fails open when its read fails.
4. **One acceptance screen, source `portal`.** The row carries the claim's fields and the box
   label naming the version and the company. A seat with no name on file types its name. It
   records no IP address or browser until the Privacy Policy names this acceptance.
5. **A block that starts mid-session reaches the screen.** One interceptor on the vendor route
   hears `403 LEGAL_ACCEPTANCE_REQUIRED` from any `/api/vendor/*` call and re-reads the state.

## Consequences

- Every vendor write pays two small extra reads in a round trip it already makes. Reads pay
  nothing.
- A future vendor write route is blocked by default. It must opt out explicitly, and the matrix
  spec counts the opt-outs.
- The effective-date change cannot set a date on 1.3. It bumps, and adds the new version's day
  to the map.
- A shell bug can at worst show the portal to a blocked company. It cannot let a write through,
  and a read failure never hides the portal.
- What happens to a monthly subscription without the Managed plan click is not decided here.
  AECI-1690 decided it in ADR 0047 decision 9: the charge does not bind the version, and the
  version the subscriptions are on keeps applying. Nothing is cancelled. A click binds at the
  next charge.
- **The block covers only routes behind the vendor guard.** Account settings, the seat-invite
  accept (`POST /api/seat-invites/:token/accept`) and claim requests sit outside it and stay
  open. That is deliberate: they act for a person, not as the company under the Vendor Terms.
- **Two owners accepting at the same instant can write two rows.** Both are true evidence of an
  acceptance of the same version, and coverage reads either. Harmless, so there is no unique
  index or guard for it.
- **Publishing stays off in demo and production.** Once a published row's effective moment
  passes, every claimed company without a covering acceptance is blocked. The change-notice
  email (AECI-1620) has shipped, so a publish tells vendors first. `LEGAL_PUBLISH_ENABLED` stays
  off in demo and production until every issue on the legal gate list has shipped, and the
  release that sets the first effective date turns it on.
- **Two open items for the legal stream (AECI-1363):** whether the Privacy Policy will name the
  portal acceptance's IP address and browser (then `PORTAL_RECORDS_EVIDENCE` flips), and
  confirmation that the first in-force version must be a new version number.

## Amendment 2026-11-13 — reader documents, and signing in is the Terms acceptance (AECI-1637)

Nothing above is reversed. Counsel's Q34 and Chris's rulings of 2026-11-13 extend the first idea
to the Terms of Service and the Privacy Policy. The second idea, a block in a guard, is NOT
extended to readers: signing in is the acceptance.

1. **The reader documents are row-gated (ruling 2).** A Terms or Privacy version is in force from
   12:00 UTC of its day only once a `legal_versions` row published it with the same moment, by
   `legalReaderVersionInForce`, the rule of `legalAgreementVersionInForce`. They had switched on
   their date alone. Their maps are `LEGAL_READER_*`, kept apart from `LEGAL_AGREEMENT_*` because
   the checkbox labels, text hashes and the vendor screen are keyed on the two agreements. Draft
   versions are never in force, so today a sign-in records nothing.
2. **Signing in is the acceptance (Chris, 2026-11-13).** `/auth/login` always shows one line
   beside the sign-in buttons: "By signing in, you agree to our Terms of Service and Privacy
   Policy." The sign-in is the click. `POST /api/auth/profile/ensure`, which the SSR callback
   calls on every sign-in, writes one `terms_acceptances` row for the Terms version in force,
   with its audit row in one `db.batch`, once per account per version. The callback forwards the
   browser's `CF-Connecting-IP` and `User-Agent`. The write never fails the sign-in.
   `AUTH_AND_RLS.md` §3.1b has the detail.
3. **No reader block, no gate.** `createAuthzMiddleware` does not read the Terms rows, and no
   route answers `403 LEGAL_ACCEPTANCE_REQUIRED` for a reader. That code stays the Vendor Terms
   block's alone (decision 3). A session that began before a new version stays on the earlier
   one until its next sign-in. An earlier draft of this amendment put a block in the guard with
   four opt-outs and a full-viewport panel. It was replaced the same day, before it shipped.
4. **What `requires_acceptance` means for the Terms.** The row is written for every Terms
   version in force, whatever the flag. The flag says the version reduces rights: it then binds
   an account holder only from their next sign-in, never on continued use, and the change email
   says so. Acceptance is for the Terms only (ruling 4): the publish refuses the flag for the
   Privacy Policy, and a Privacy change gets the email and the 30-day window.
5. **The record outlives the account (ruling 1).** `terms_acceptances` has no FK to `profiles`
   and keeps email, version and time for the life of the account plus 6 years. IP address and
   browser go at 90 days.

**Consequence.** No read is added to any guard. The cost is two small reads on each sign-in,
and only while a Terms version can be in force. Whether the line is enough for a
rights-reducing change is an open counsel question (`LEGAL_COUNSEL_RECORD.md`, Q34). Its
fallback is one unticked box on the sign-in page, shown only after a rights-reducing change;
`terms_acceptances.checkbox_default_unticked` is kept for it.
