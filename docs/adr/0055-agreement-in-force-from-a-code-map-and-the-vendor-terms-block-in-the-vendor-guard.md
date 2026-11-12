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
   label naming the version and the company. It records no IP address or browser until the
   Privacy Policy names this acceptance.

## Consequences

- Every vendor write pays two small extra reads in a round trip it already makes. Reads pay
  nothing.
- A future vendor write route is blocked by default. It must opt out explicitly, and the matrix
  spec counts the opt-outs.
- The effective-date change cannot set a date on 1.3. It bumps, and adds the new version's day
  to the map.
- A shell bug can at worst show the portal to a blocked company. It cannot let a write through,
  and a read failure never hides the portal.
- What happens to a monthly subscription without the Managed plan click is not decided here
  (AECI-1690).
