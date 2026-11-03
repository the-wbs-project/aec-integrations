# Listing submissions runbook

Internal. How we handle a request to add a product, decide whether to list it, check a claim
that the usual signals cannot settle, and reply. Written for Chris (owner) and Bill (backup).

The public side of this policy is the help-center page `/docs/trust/listing-submissions`
(`apps/web/src/content/docs/trust/listing-submissions.md`). The two must agree. A change to the
three listing conditions, the reply time or the proof methods changes both in the same PR.

Corrections and removals are not covered here. They follow the Listing Accuracy Policy
(`/legal/listing-accuracy`).

**Status: written 2026-10-15 under AECI-588 (E2.6 of AECI-1332).** The rulings are Chris's,
2026-10-15.

---

## 1. Owner and SLA

- **Owner:** Chris owns inbound submissions.
- **Backup:** Bill covers when Chris is away.
- **Acknowledge within 2 business days.** This is the published number on the help-center page.
- **Decide within 10 business days.** This is internal. It is not published.

The clock starts when the email arrives or the in-app request is submitted.

## 2. Where submissions are tracked

Linear is the only tracker we write to. The Airtable Outreach table is no longer used for
submissions.

| Arrives as | Record | What the operator does |
|---|---|---|
| The listing request page (`/vendor-program/list-your-product`, AECI-1474) or the claim dialog's "Not listed? Type it in" path. Both are the same form | A `listing_requests` row, its `listing_request.created` audit row, and the `listing-request-alert` email to support (`VENDOR_PROGRAM_PAGE_SPEC.md` §15.4) | Work it from the "Listing requests" section of `/admin/requests` (§15.5). Resolve or reject it there. The claimant already has an automatic `claim-received` receipt. |
| A cold email | Nothing until you file it | File a Linear issue (below). |

**As built, AECI-1435 (2026-10-21): a request in the queue is from a confirmed address.** An
anonymous typed-in listing, and an anonymous claim, wait until the typed address clicks the emailed
confirm link (ADR 0043). Nothing reaches `/admin/requests`, `/admin/claims` or the support inbox
before that. So the email on a listing request or a claim in the queue has received our mail.
It still says nothing about whether the person works at the company: the domain and LinkedIn checks
are unchanged. A request that was never confirmed is not in any queue, and its pending row is
deleted after 7 days.

**A cold email becomes a Linear issue.**

- Team: AECi. No project.
- Title: `REQUEST - {{company}}: listing submission`.
- Assignee: Chris.
- Body: the email quoted in full, and the sender's address on its own line.

The `REQUEST - ` title prefix is new with this runbook. It is recorded in
`docs/linear-issue-conventions.md` §3.

The in-app path files no Linear issue by design. §15.4 makes the alert and the admin queue its
record. Resolving a listing request does not create the listing. You add it upstream in the
review app, promote it, then email the submitter to finish their claim (§15.5).

Rejecting a listing request sends nothing either. The `claim-received` receipt promises an
explanation, so email the submitter yourself before you reject.

## 3. The listing decision

List the product when all three conditions hold. They are the public page's conditions, word for
word in substance.

A request from the listing form also starts a claim, so check that the submitter works for the
company as well. The form's copy and receipt promise this check. It does not apply to a cold email.

1. A live public website with a page about the product.
2. A real legal entity behind it, which a public company register can confirm.
3. At least one capability for architecture, engineering or construction work that we can describe
   from public material.

Company age, revenue, beta status and company size do not matter. We do not list a pre-launch
waitlist, a product with no public description, or a product we cannot place in the taxonomy.

**Checks for condition 2, in this order.**

1. **WHOIS for the domain.** A `.com.au` record publishes the registrant and an ABN (Australian
   Business Number). A `.com` record is usually redacted.
2. **The national company register.**

   | Country | Register |
   |---|---|
   | Australia | ABN Lookup, `abr.business.gov.au` |
   | United Kingdom | Companies House |
   | United States | The Secretary of State's business search for the state of incorporation |

3. **Cross-checks.** The governing-law clause in the site's own terms. The sender's name against
   the registrant. The registration date against the dates the site and the sender claim.

Record what each check found on the Linear issue. An in-app request that needs these checks gets
a Linear issue too, under the same title, so the findings have one home.

**The research rule.** Any statement we send back to a vendor about their own property comes from
a decoded or primary source. Never from a page summary, a search snippet or an AI digest.

**Cloudflare email obfuscation.** A site behind Cloudflare renders every email address as
`[email protected]`. The real value is hex-encoded in the element's `data-cfemail` attribute. The
first byte is the XOR key. Decode it before you quote an address back to anyone:

```python
def dec(h):
    k = int(h[:2], 16)
    return ''.join(chr(int(h[i:i+2], 16) ^ k) for i in range(2, len(h), 2))
```

**A decline names the condition.** Say which condition was not met and what would change the
answer. Use template 2 in §5.

## 4. Identity proof for a claim

**The default is the built check.** The claim queue at `/admin/claims` shows the signals:
the work-email domain match, the claimant's own LinkedIn profile, the company's existing seats and
any competing claims (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5 signal list and §5.0a). The vendor terms
describe this check in their "We check each claim" paragraph
(`apps/web/src/content/legal/vendor-terms.md`).

**Escalate to proof of domain control when any of these holds:**

- The claimant uses a free mailbox (Gmail, Outlook.com and the like).
- WHOIS is redacted.
- The WHOIS registrant does not match the claimant or the company.

**Two methods.** The claimant picks one. They count the same.

| Method | What the claimant does | How we check |
|---|---|---|
| DNS record | Adds a TXT record `aeci-verification={{token}}` on the apex domain | `dig +short TXT {{domain}}` shows the record |
| File on the website | Serves `https://{{domain}}/.well-known/aeci-verification.txt` containing the token | Open the URL. The body is the token. |

**The token.**

- 32 hex characters, generated with `openssl rand -hex 16`.
- Single use. One token per claim.
- Recorded on the claim's Linear issue. The claim pipeline files one for every claim.
- Valid for 14 days from the email. After 14 days, decline the claim with template 3's lapse line.
  The claimant can submit a new claim, which gets a new token.

**Not accepted.** A reply from an address at the domain is not proof. Many company domains have
no MX record (no inbound mail), so the method often cannot be used. A message echoed back through the site's contact form is not proof
either. It shows that someone can submit a form, not that they control the domain.

**Wording.** Never call this "verification" or "verified" to a vendor. That word belongs to
dual-vendor integration attestation (`STAGE_2_ATTESTATIONS_SPEC.md`,
`/docs/trust/agreement-states`). Say "we checked your claim" or "proof of domain control". The
record name `aeci-verification` is a technical label the claimant types. Do not repeat it in prose.

**The token check is manual today.** No product surface issues or checks a token. The operator
runs `openssl` and `dig` by hand and approves the claim in `/admin/claims` once the token shows.

## 5. Reply templates

**Placeholders.** `{{company}}`, `{{product}}`, `{{listing_url}}`, `{{domain}}`, `{{token}}`,
`{{date}}`, `{{condition}}` and `{{what_would_change}}` are filled in before sending. These are
email bodies, not shell commands.

Every template carries the independence line unchanged:

> We compile listings from public information, we correct our own errors free, and nothing about
> ranking or placement is for sale.

### Template 1: listed, not yet claimed

```text
Hi {{name}},

Thanks for getting in touch about {{product}}. It is listed on AEC Integrations here:
{{listing_url}}

You can claim it from that page with "Claim {{company}}". Claiming is free. Once we have checked
your claim, your team can edit the listing, reply to reviews and confirm integration data.

Managed is the paid plan for maintaining the listing yourself. The plans are compared here:
https://www.aecintegrations.com/docs/vendors/plans

We compile listings from public information, we correct our own errors free, and nothing about
ranking or placement is for sale.

Chris
AEC Integrations
```

### Template 2: not listed

```text
Hi {{name}},

Thanks for suggesting {{product}}. We have not listed it yet.

We list a product when it has a live public website with a product page, a legal entity that a
public company register can confirm, and at least one capability for architecture, engineering or
construction work that we can describe from public material.

{{product}} does not meet this one yet: {{condition}}.

What would change the answer: {{what_would_change}}. When that is in place, reply to this email
and we will look again.

We compile listings from public information, we correct our own errors free, and nothing about
ranking or placement is for sale.

Chris
AEC Integrations
```

### Template 3: claim needs proof of domain control

```text
Hi {{name}},

Thanks for your claim on {{company}}. Our usual checks were not enough to approve it, so we need
proof of control of {{domain}}. Either of these works. Pick the one that is easier for you.

1. Add a DNS TXT record on {{domain}} with this value:
   aeci-verification={{token}}

2. Publish a plain text file at
   https://{{domain}}/.well-known/aeci-verification.txt
   containing only this line:
   {{token}}

The code is for this claim only. Please put it in place by {{date}}, which is 14 days from today,
and reply to this email when it is live. We will check it and then decide your claim.

We compile listings from public information, we correct our own errors free, and nothing about
ranking or placement is for sale.

Chris
AEC Integrations
```

**Lapse line.** After 14 days with no proof, decline the claim with this text: "We could not
complete the check on your claim within 14 days, so we have closed it. You are welcome to submit a
new claim at any time, and we will send a new code."

Template 1 links the vendor-guide Plans page. The help-center page cannot link it (the General
guide never links into the vendor guide, `STAGE_2_PRODUCT_DOCS_SPEC.md` §3), but an email can.

## 6. Taxonomy reset

We create the taxonomy terms. A vendor with a seat places its own products under existing terms in
the portal. A suggestion that arrives with a submission is advice. We read it and place the product
ourselves.

An admin may reset a vendor's placement where no evidence supports it. Ask the vendor for evidence
first. Reset only when none is given.

**Reset with the lock (2026-10-23, AECI-1382).** Make the reset through "Correct a field" on
`/admin/vendors/:id` (`ADMIN_PANEL_SPEC.md` §5.7). Pick the product and the facet, tick the terms
it should keep, and give the reason the vendor reads. Untick every term to remove them all. The
correction is locked (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5), so the vendor cannot undo it from
the portal. The vendor is told in Messages, and the audit row records the terms before and after.
Lift the lock if the vendor later sends evidence. Lifting keeps our terms, and the vendor can then
change them.

## 7. History

The first inbound submission was NestFiles, on 2026-08-12. It was handled ad hoc, with no written
rule for what we list or how we check who is asking. This policy was written on 2026-10-15 under
AECI-588, which is E2.6 of the Agreements epic AECI-1332 (`docs/VENDOR_SIGNUP_PROCESS.md` §5).
