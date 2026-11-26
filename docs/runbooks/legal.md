# Legal runbooks

Procedures for a legal event that carries its own deadline: a data breach, an accessibility barrier
report or demand letter, a copyright notice or counter-notice, a subpoena for a reviewer's identity, a request for the ranking evidence. The last five sections run our published legal versions: the
change notice, the day-of notice when the first versions take effect, the acceptance screen, and the two digest checks on a version's effective date. No alert pages any of them. Alert runbooks are in
[`alerts.md`](./alerts.md). Subscription and billing procedures are in
[`subscriptions.md`](./subscriptions.md). Counsel's answers are verbatim in
`docs/LEGAL_COUNSEL_RECORD.md` (Q25, Q38, Q40, Q41). Where counsel did not say something, these steps say
"retain an attorney", not a guess.

**Insurance.** The WBS Project has no general liability or cyber policy today (Chris, 2026-11-11).
Each runbook below says "no insurer to notify". When a policy exists, put its notice address and
notice deadline here, and make notifying the insurer the first step of every runbook here.

**Every matter gets a Linear issue.** Title it with the matter, assign it to Chris, and date every
step in a comment as it happens. That issue is the record of what we kept, sent and produced.

**The hold folder.** Exports hold personal data, so they never go in a git repo, `.context/`, Linear or
email. Keep them in one dated folder per matter on encrypted storage that only Chris can read, and
name the folder on the Linear issue. Delete the copies in `/tmp` once they are moved.

## Data breach (Fla. Stat. 501.171)

**The clock.** 30 days from the day we determine a breach happened, or have reason to believe one did.
That day is day 0. Write it on the Linear issue before anything else.

**1. Contain and record.** Stop the access. Rotate the exposed credential. Record what was reached,
from when to when, and how we know. Keep every log you read: copy it out before its retention ends
(the debugging record is 7 days).

**2. Decide whether it is notifiable.** Under 501.171, two kinds of "personal information" matter for us.
The first is an email address together with a credential that would let someone into the account
(counsel, Q41). The second is a first name or initial and last name together with "any information
regarding an individual's geolocation" (501.171(1)(g)1.a.(VII)). The statute does not define
geolocation, so we read it widely: a name with an IP address or any other location counts (ruling 67).

| What was taken | Notifiable? |
|---|---|
| Email addresses with live magic-link tokens | Yes |
| Email addresses with live session tokens (the `sb-*-auth-token` cookie, a Supabase refresh token) | Yes |
| Email addresses with stored Google OAuth tokens | Yes. We hold none server-side; see the recorded checks |
| Email addresses alone | No |
| A name together with an IP address or any location. Today that is a claim or grant acceptance inside its 90 days, and any record that holds both a name and a place | Yes (ruling 67) |
| Names and work emails with no IP address and no location | No |
| IP addresses or locations with no name | No |
| Keyed hashes (the page-view `ip_hash`, `recipient_hash`, `user_agent_hash`) | No |
| Expired or used tokens | No. Check the lifetime below before relying on this |

If the answer is "no", record the reasoning on the issue and stop here. If unsure, retain an attorney.

**3. Count the affected people, by state.** Each state's law follows where the person lives, not where
we are. Some states have deadlines shorter than 30 days. List the states and check each one's rule
before the first notice goes out.

**4. Notify, in this order.**

| Who | When | Trigger |
|---|---|---|
| Each affected person | As fast as practicable, no later than day 30 | Any notifiable breach |
| Florida Department of Legal Affairs | Within the same 30 days. 15 more days if we give good cause in writing within the 30 | 500 or more Florida residents affected |
| The nationwide consumer reporting agencies | Without unreasonable delay | More than 1,000 people affected |
| Insurer | First, when a policy exists | None today |

**4a. The no-harm waiver (501.171(4)(c)).** We may skip the notice to individuals when all of these
hold. It fits the low-harm case, such as names with IP addresses and no credential.

1. We have made an appropriate investigation.
2. We have consulted a relevant federal, state or local law enforcement agency. This step is required,
   not optional. Record who, when and what they said.
3. We reasonably determine that the breach has not caused, and is not likely to cause, identity theft or
   any other financial harm to the people affected.
4. The determination is in writing. Keep it for at least five years.
5. We send that written determination to the Florida Department of Legal Affairs within 30 days of
   making it.

The waiver covers the notice to individuals only. The statute does not say it excuses the notice to the
Department, so with 500 or more Florida residents affected, send that notice anyway and explain the
waiver in it. Other states have their own rules. Check each one in step 3 before relying on this.

**5. What the individual notice says.** At a minimum (501.171(4)(e)): the date, estimated date or
estimated date range of the breach, a description of the personal information that was or may have
been accessed, and contact details the person can use to ask about the breach and about what we hold on
them. Send it by email to the address on record, or by post (501.171(4)(d)). The template is below.

**5a. What the Department notice says (501.171(3)(b)).** A synopsis of what happened. How many people
in Florida were or may have been affected. Any free services we offer, with instructions. A copy of the
individual notice, or an explanation of what we did instead. The name, address, phone number and email
of the person who can say more. On request the Department may also ask for an incident or forensics
report, our breach policy, and the steps taken to fix it. The attorney drafts this one.

**6. Our processors.** A processor that holds our data must tell us of a breach on its side, as fast as
practicable and no later than 10 days after it determines the breach or has reason to believe one
happened. That duty is in the statute (501.171(6)(a)), so it binds the processor whatever its agreement
says. The processor must also give us what we need for our own notices.

- **The clock (ruling 67).** The statute does not say when our 30 days start if the breach was at a
  processor. We take the strict reading: day 0 is the day the processor determined the breach, not the
  day it told us. A processor that uses its full 10 days leaves us about 20. Ask the processor for its
  determination date in writing, first thing.
- **A late processor is our problem.** A processor's failure to give proper notice counts as a violation
  against us (501.171(6)(b)), and the civil penalty in 501.171(9)(b) falls on the covered entity.
- **Do not wait to be told.** A processor sends a breach notice to the contact email on our account with
  it, not to a status page. Supabase's agreement says so (DPA §10). Resend's and Cloudflare's do not say
  where. So the owner email on each of the three accounts must be a mailbox Chris reads. Chris also
  subscribes to each status page, which reports outages and is a second, weaker signal. Treat a notice
  from either as "reason to believe" and start step 1. The three are Supabase, Resend and Cloudflare,
  the processors that can hold an email address with a live sign-in credential.

### Notice to an affected person: template

Adapted from the model letter in the FTC's "Data Breach Response: A Guide for Business" (August 2023).
The FTC model is written for stolen Social Security numbers. We hold none, so its credit bureau, fraud
alert and credit freeze paragraphs are left out. Put them back only if financial data was involved.
Fill every bracket. Say nothing you do not know to be true. Send from a support address people already
know, with no links other than our own site, so the notice does not read as phishing.

> **Subject: Notice of data breach**
>
> Dear [name],
>
> We are writing to tell you about a data breach at AEC Integrations that involved your information.
>
> **What happened.** [How it happened, in plain words. The date, or the estimated date range. Whether we
> know the information was misused.]
>
> **What information was involved.** [Each kind of information, for example your email address together
> with a sign-in link that was still valid, or your name together with the IP address recorded when you
> claimed a listing.] It did not include a password, because we do not use passwords, or any payment
> card number, because our payment provider holds those.
>
> **What we are doing.** [What we did to stop it. What we changed so it does not happen again. For a
> sign-in credential: that every session was ended and every outstanding sign-in link cancelled.]
>
> **What you can do.** [For a sign-in credential: sign in again, and check your account page for
> anything you did not do. For any breach: be careful with emails that claim to come from us. We will
> only write to you from [address], and we will never ask for a password or payment details.]
>
> **For more information.** Write to [support address] or [postal address]. You may also ask us what
> information we hold about you. We will post updates at [page].
>
> [Name], The WBS Project, Inc.

### Recorded checks (AECI-1674)

These are the three checks counsel asked for. Re-check each one when the thing it describes changes.

**Production magic-link lifetime (checked 2026-11-12): 3600 seconds, one hour.** Chris read
Authentication → Providers → Email → "Email OTP Expiration" in the Supabase dashboard for the shared
auth project `ktuhnlypztujpsseujzx`, which serves every environment. It matches local config
(`otp_expiry = 3600` in `supabase/config.toml`). A link taken from a log is dead an hour after it was
sent, so a breach of logged links older than that is not notifiable. The dashboard caps it at 24 hours. Only the Management API
can set more, which Supabase strongly discourages. The same setting governs every Supabase email link:
magic link, signup confirmation, recovery, email change, invite. Counsel: keep it short.

**Google provider tokens (checked 2026-11-11).** None are stored server-side. Supabase docs: "Provider
tokens are intentionally not stored in your project's database"
([social sign-in](https://supabase.com/docs/guides/auth/social-sign-in)). Our sign-in asks Google for
default scopes only, with no offline access (`signInWithGoogle` in `apps/web/src/app/auth/auth.service.ts`),
so no Google refresh token is issued, and no code of ours reads or saves `provider_token`. A short-lived
Google access token can sit in the user's own session cookie after sign-in. That is on their device, not
in any store of ours.

**Processor notice channels (set 2026-11-26).** Chris confirmed the owner or admin email on the
Supabase, Cloudflare and Resend accounts is a mailbox he reads, subscribed to both status pages
(`status.supabase.com`, `resend-status.com`), and added a Cloudflare **Incident Alerts** notification
under Alerts → Platform Notifications. Re-check when an account owner or that mailbox changes.

**Processor breach-notice terms (checked 2026-11-11 against each public DPA).** Counsel says a processor
must tell us within 10 days. Two agreements meet that. Stripe meets it for GDPR data only. Six fix no
deadline at all. Spur's is unread. Listed on AECI-310. **Accepted as they stand (ruling 67, 2026-11-26).**
The 10 days is the processor's own duty under 501.171(6)(a), these are self-serve agreements we cannot
negotiate, and step 6 runs our clock without relying on them.

| Processor | Agreement term | Meets 10 days? |
|---|---|---|
| Microsoft 365 | [Products and Services DPA](https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA), November 2026: without undue delay, and within 72 hours | Yes |
| Anthropic | [DPA](https://www.anthropic.com/legal/data-processing-addendum) §G.1: without undue delay, and within 48 hours | Yes |
| Stripe | [DPA](https://stripe.com/legal/dpa) §3.1(f): within 48 hours for GDPR or UK GDPR data only; otherwise without undue delay | Partly. Not fixed for US data |
| Supabase | [DPA](https://supabase.com/legal/dpa) §10: without undue delay, "where feasible" within 48 hours | No fixed deadline |
| Cloudflare | [Customer DPA](https://www.cloudflare.com/cloudflare-customer-dpa/) v6.4 §3.1(e): without undue delay | No fixed deadline |
| PostHog | [DPA](https://posthog.com/dpa) §7.1: without undue delay | No fixed deadline |
| Resend | [DPA](https://resend.com/legal/dpa) §8.6: without undue delay | No fixed deadline |
| Linear | [DPA](https://linear.app/dpa) §7.5: without undue delay | No fixed deadline |
| Algolia | [DPA](https://www.algolia.com/policies/data-processing-addendum) §3.2.1: without undue delay | No fixed deadline |
| Spur | DPA exists but is behind an access request at trust.spur.us | Unknown |

"Without undue delay" is the standard term in self-serve DPAs, and none of these vendors negotiates it
at our size. What to do about the gap is a decision for Chris and counsel, tracked on AECI-310.

**The Privacy Policy single-use link sentence.** The "Edge request log" and "Debugging record"
bullets used to say single-use links "stop working within days". Since Privacy Policy 1.1 (legal
branch 6, AECI-1363, 2026-11-18) they name three links and their lifetimes: "A sign-in link stops
working within a day, a confirmation link after 7 days, and a seat invite 14 days after it was last
sent." The lifetimes behind that sentence:

| Link | Lifetime | Source |
|---|---|---|
| Sign-in (magic link) | 1 hour (3600 s, read 2026-11-12) | Supabase Auth "Email OTP Expiration" |
| Claim and listing confirmation | 7 days | `request_confirmations.expires_at`, swept by `cron-schedules.ts` |
| Seat invite | 14 days, reset on a re-send | `INVITE_TTL_DAYS` in `apps/api/src/lib/vendor-seat-invites.ts` |

**Verdict.** The sentence now holds for all three. It names each lifetime, and the seat invite is
counted from the last send, so a re-send moves the date and the text says so. This was the open text item AECI-1681.
A seat invite also needs a sign-in to the invited mailbox to use, so a leaked invite link alone opens
nothing. Check the sentence again if `INVITE_TTL_DAYS`, the confirmation expiry or the Supabase
OTP expiry changes. A longer lifetime makes the text false.

## Accessibility barrier report (AECI-1673)

Use this when someone tells the support inbox (`support@aecintegrations.com`) that something on the site stops them from using it. The statement at `/accessibility` says "We reply within 10 business days." It is hidden until AECI-1687, but treat a barrier report the same way now. Ruling 22 set that window, and a missed self-set deadline is evidence against us (counsel Q40). `STAGE_1_SPEC.md` §27.6 governs the page.

1. Reply within 10 business days of receipt, every time. Count from the day the email arrives. Thank them and restate the barrier as you understand it. Say what happens next. Do not promise a fix date unless you can meet it.
2. File a Linear issue in the **Bugs** project. Put the page address, the browser and assistive technology, and the reporter's words in it. Never put their email address in it.
3. If the report needs a workaround to reach the content, such as a review, a correction or a claim, offer to do it for them by email.
4. When the fix ships, tell the reporter.
5. A letter that cites the ADA, threatens suit or comes from a lawyer is not a barrier report. Follow [Accessibility demand letter](#accessibility-demand-letter) below: there is no insurer to notify today, so send the hold notice, then retain an attorney. Do not reply to the substance yourself.

## Accessibility demand letter

A letter, usually from a plaintiff's firm, that says the site is not accessible and asks for money or a
fix by a date. A plain report of a barrier, with no legal threat, is not one: use
[Accessibility barrier report](#accessibility-barrier-report-aeci-1673) above. Counsel (Q40): the ADA probably does not reach a website-only business in the Eleventh
Circuit, but a plaintiff can sue where any reader lives. Treat every letter as real.

1. **Open the Linear issue.** Record the date received, the sender, and the deadline the letter gives.
   If it gives none, the deadline is 14 days after receipt.
2. **Insurer.** None to notify today. Revisit when a policy exists (see the top of this file).
3. **Send the litigation hold notice** below, the same day.
4. **Save the accessibility records now.** Where they live:

   | Record | Where | How long it lasts |
   |---|---|---|
   | Dated manual and tool-assisted audits | `docs/ACCESSIBILITY_AUDIT.md`, with git history as the date record | Permanent |
   | The manual pass checklist | `docs/a11y-manual-testing-checklist.md` | Permanent |
   | Every CI axe run | GitHub Actions artifacts from `.github/workflows/deploy.yml` | 7 to 30 days, then GitHub deletes them |

   Download every CI artifact that still exists into the hold folder on receipt. Those are the only
   per-run axe records, and they expire. A durable per-run record is AECI-1682.
5. **Retain an attorney before replying.** Counsel did not say what the reply should contain. It
   depends on the letter. Do not reply without one, and do not promise a fix date or a standard in
   writing without the attorney.
6. **Reply by the deadline.** Record the reply and its date on the issue.

## Copyright notice or counter-notice (AECI-1665)

Use this when a notice of claimed copyright infringement, or a counter-notice, reaches our designated agent. The address and the email `copyright@thewbsproject.com` are printed in the Terms' "Copyright complaints" section. The registration and its renewal date are in `apps/web/src/content/legal/README.md` "DMCA designated agent". A copyright notice sent to the support inbox counts too, so move it to the same handling.

The Terms promise four things here. We promptly notify the person who posted the material. We forward a counter-notice to the person who sent the notice. We restore the material between 10 and 14 business days after we receive the counter-notice, unless they tell us they have filed a court action. We keep a log of every notice and counter-notice, and terminate repeat infringers in appropriate circumstances. Counsel set these in Q38 (`docs/LEGAL_COUNSEL_RECORD.md`).

**The log is `/admin/dmca`.** Every notice and every counter-notice gets a row there, the same day it arrives, complete or not. A counter-notice is logged against the notice it answers. The page shows each counter-notice's restore window and whether it is overdue. You do not have to open it to find out: the "Copyright restores" item on `/admin/overview` counts the counter-notices that are overdue, in their window, or not yet forwarded, and the 04:00 data-quality digest counts them under `dmca_restore_due` and lists up to ten examples (AECI-1944). Business days are Monday to Friday, excluding US federal holidays, in New York time (`apps/api/src/lib/business-days.ts`). The table is `dmca_notices` (`docs/DATABASE_SCHEMA.md` §8.14). It is never public.

**A notice**

1. **Check the notice.** A valid notice has the six elements of 17 U.S.C. 512(c)(3): a physical or electronic signature, the copyrighted work, the material that infringes it and where it is on the service, the sender's contact details, a statement of good-faith belief that the use is not authorized, and a statement that the notice is accurate and, under penalty of perjury, that the sender is the owner or may act for the owner. If it names the work, the material and how to reach the sender, but lacks another element, write back promptly and say what is missing. Log the row as it is. Leave blank what the notice did not give: the name, the contact details or the material. The page shows a missing name as "Not given". An incomplete notice is logged with `no_action` (step 2). The page will not save a `removed` or `disabled` row until the material is identified.
2. **Remove or disable the material, then log it.** Use the tool for the kind of material:

   | Material | Tool | Can it be put back? |
   |---|---|---|
   | A published review | **Remove** on `/admin/reviews` (`docs/ADMIN_PANEL_SPEC.md` §5.21) | Not from the panel. Remove is final there. The row stays in D1 with status `removed`. |
   | A logo | **Remove on objection** in the logo editor (`listing-submissions.md` §6a) | Only by uploading it again. The action deletes the stored file, so save a copy to the hold folder first. |
   | One text value on a vendor-held record | The value hide (`catalog.md` "Hide a value") | Yes. Restoring the hide puts the value back. The daily `field_hide_decision_overdue` check warns after five business days, so expect it. |
   | Anything else | No tool. Tell Chris the same day. | |

   Set `action` to `removed` or `disabled`, with `action_at`. Set `account_id` to the account that posted the material, and `vendor_id` when it is a vendor's logo, screenshot or text. An incomplete notice, or one about material that is not on our service, is `no_action`. A `no_action` notice never counts against an account.
3. **Promptly notify the person who posted it.** Email them from the copyright mailbox. Say what was removed and why. Do not name the person who sent the notice, give their contact details or attach the notice. The Privacy Policy says we tell the poster only that the material was removed because of a copyright notice. Say they may send a counter-notice to the address in the Terms, and what it must contain. Stamp `forwarded_at` on the notice when you send it.

**A counter-notice**

4. **Check the counter-notice.** A valid counter-notice has the elements of 17 U.S.C. 512(g)(3): a signature, the removed material and where it was, a statement under penalty of perjury of good-faith belief that it was removed by mistake or misidentification, the sender's name, address and phone number, consent to the federal district court for their address (the Southern District of Florida if they are outside the United States, as the Terms say), and a statement that they will accept service from the person who sent the notice. If one is missing, write back and say what. The clock does not start until a complete counter-notice arrives.
5. **Log it against the notice.** Create a counter-notice row with "Counter-notice to…" set to the notice, and `received_at` set to the day it arrived. The restore window counts from that day.
6. **Forward it to the person who sent the notice, promptly.** Send them a copy. Say we will restore the material in 10 business days unless they tell us they have filed a court action seeking to restrain the poster. Stamp `forwarded_at` on the counter-notice.
7. **Watch the clock.** Before business day 10 the page shows "Restore window opens" with the day-10 date. From day 10 it shows "Restore by" with the day-14 date. A forwarded counter-notice past day 14 with no outcome shows "Overdue". Until you stamp `forwarded_at`, it shows as waiting to be forwarded, whatever the day. If the sender of the notice tells us they have filed a court action before we restore, stamp `court_action_at`, keep the material down, and record `not_restored`. A counter-notice stays on the Overview's "Copyright restores" count and fails the `dmca_restore_due` data-quality check from the day it is logged until it is forwarded, and again from business day 10 until it has an outcome or a court action. Clear it by doing the step, never by stamping a date you did not act on. Closing the row does not clear it either: a counter-notice closed with no outcome stays on the count, and the digest line says "closed with no outcome recorded".
8. **Restore, or record why not.** With no court action, put the material back between business day 10 and business day 14, never before day 10. Then set `restore_outcome` to `restored` with its date. A takedown restored this way no longer counts against the account. A removed review has no restore route in the panel. Tell Chris by business day 10, because putting it back needs an ops script.
9. **Close the notice.** Stamp `closed_at` on each row when nothing more will happen: a `no_action` notice once you have replied, a counter-notice once its outcome is recorded, a notice once its counter-notice is closed. A takedown with no counter-notice can still draw one, so close it when you judge nothing more will come, and say why in `notes`. The three-year retention counts from `closed_at`. The job that deletes rows after three years is AECI-1905, not built yet. No row can fall due before late 2029.

**Repeat infringers**

10. **Review the account after every takedown.** Open `/admin/users/:id`. "Copyright takedowns" counts that account's notices that led to a removal or a disabling. A `no_action` notice and a takedown restored after a counter-notice do not count. The counter-notices the account filed show beside it. There is no fixed threshold. The Terms say "in appropriate circumstances". Counsel said no threshold is required, but the policy must be applied. Decide each time. Write the decision and its reason in the notice's `notes`, and in a Linear issue assigned to Chris. A reader account is banned on `/admin/users/:id` (`docs/ADMIN_PANEL_SPEC.md` §5.8). A vendor's access ends only through Suspend, then Terminate, on `/admin/vendors/:id`.

A deleted account loses its link to its notices, and a re-created account starts at zero (Chris's ruling of 2026-11-17). The rows themselves stay.

## Subpoena or legal process for a reviewer's identity

A party, usually a vendor suing a reviewer for defamation, asks us to identify the person behind a
review. Counsel (Q25). Our public promise: we disclose information that identifies a user only in
response to legal process, and we tell the user first where the law permits, in time for them to
object where practicable (Privacy Policy "How we share data", Terms of Service).

**An informal request, a letter or an email from a lawyer is not legal process.** Do not disclose.
Reply that we disclose only in response to valid legal process, and log the request on a Linear issue.

### 1. Intake and validity

Open the Linear issue and record:

- who issued it, the court, the case number, and the date served;
- the return date, the day we must produce by;
- exactly which records it asks for;
- whether it is a court order or a lawyer-issued subpoena. A lawyer-issued subpoena is not a court
  finding on the reviewer's right to speak anonymously;
- whether it, or any order with it, says we must not tell the user.

Retain an attorney now. The attorney decides whether it is valid and whether to object.

### 2. Preserve, the same day

A litigation hold overrides routine deletion. Destroying records after a subpoena arrives risks
spoliation, a court sanction for destroying evidence. Do all of this before anything else ages out.

**a. Export the reviewer's D1 records.** Find the reviewer's profile id from the review (`reviews.reviewer_id`).
Then run each read against production, and move the output into the hold folder:

```bash
cd /tmp
export REVIEWER_ID=paste-the-profile-id-here
npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT * FROM profiles WHERE id = '$REVIEWER_ID'" > profile.json
npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT * FROM profile_details WHERE profile_id = '$REVIEWER_ID'" > profile_details.json
npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT * FROM reviews WHERE reviewer_id = '$REVIEWER_ID'" > reviews.json
npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT * FROM review_updates WHERE review_id IN (SELECT id FROM reviews WHERE reviewer_id = '$REVIEWER_ID')" > review_updates.json
npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT * FROM audit_log WHERE actor_id = '$REVIEWER_ID' OR entity_id = '$REVIEWER_ID' OR entity_id IN (SELECT id FROM reviews WHERE reviewer_id = '$REVIEWER_ID')" > audit_log.json
npx wrangler d1 execute aeci-app-production-us --remote --json --command "SELECT * FROM agreement_acceptances WHERE profile_id = '$REVIEWER_ID'" > agreement_acceptances.json
```

The email address is not in D1. It is in Supabase Auth. Read the account with the service-role key, as
in `docs/runbooks/alerts.md` "Erasure left an `auth.users` row behind":

```bash
curl -s "$SUPABASE_URL/auth/v1/admin/users/$REVIEWER_ID" -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" > auth_user.json
```

Then search `feedback`, `mailing_list`, `vendor_requests` and `listing_requests` for that email address,
and export any rows found the same way.

**b. Account deletion during the hold.** If the reviewer deletes their account, erasure nulls
`reviews.reviewer_id` and `reviewer_firm` and stamps `anonymized_at` (`apps/api/src/routes/account.ts`), which breaks the link to the review. The export in
step a is the record of that link. Nothing in the code blocks a self-serve deletion during a hold. Whether it should is AECI-1683, a decision.

**c. Copy the raw page-view envelopes out of their 400-day lifecycle.** The hashed IP lives only in
the raw page-view store (`docs/ANALYTICS.md` §11), whose R2 lifecycle deletes each object at 400 days.
Copy every `page_views/year=…/month=…/day=…/` folder for the months in question into
`legal-hold/` plus the Linear issue id in the archive bucket `aeci-page-views-archive-production`. That
bucket has no lifecycle rule. Never add one. Use the R2 S3 API with a token that can read the raw bucket
and write the archive bucket.

**d. Freeze the IP hash key: do not touch `PAGE_VIEW_IP_HASH_SECRET`.** There is no per-month key to
freeze. `monthlyIpHash` (`apps/api/src/lib/hash.ts`) derives each month's key as
`HMAC(secret, 'YYYY-MM')` when it is used, and stores none. "Monthly rotation" means the month name
changes, not that a key is destroyed. Every past month's hash can be recomputed from the one secret.
So the hold is: do not rotate, replace or delete the `PAGE_VIEW_IP_HASH_SECRET` Worker secret on any
environment until the hold ends. Write that on the Linear issue. No code switch is needed.

**e. Check the claim "we hold no raw address" before anyone says it.** Our own records keep raw IP
addresses in three places, so the claim depends on the reviewer and the dates:

| Where | What | How long |
|---|---|---|
| `agreement_acceptances.ip` | The IP of a person who accepted the Vendor Terms or a plan agreement | 90 days, then the evidence job nulls it |
| `request_confirmations.ip` | The IP of a person who submitted a claim or listing request | 7 days, then the sweep deletes the row |
| Workers Logs invocation logs | Raw IPs in request headers | On until 2026-11-09 (AECI-1594), 7-day retention. Off since |

Supabase Auth's own logs also record sign-in IPs for the retention of our Supabase plan. Read them in
the Supabase dashboard and save any that cover the dates. If any of these holds the reviewer's IP,
tell the attorney before the statement "we hold no raw address" is made.

**f. Send the litigation hold notice** below.

### 3. Tell the reviewer, where permitted

First check step 1's answer: if the process or an order bars notice, do not send it, and record why.
Otherwise email the reviewer at the account address as soon as the attorney agrees, so they have time
to move to quash before the return date. Template:

> Subject: Legal request about your review on AEC Integrations
>
> We have received a legal request from [party], in [court and case number], asking us to disclose
> information that identifies you as the author of your review of [product], posted on [date].
> It asks for: [records]. We must respond by [return date].
>
> We are telling you so you can take advice and, if you choose, object to the request in court before
> that date. We do not give legal advice. If we do not hear that you have objected, we may have to
> produce the information the request covers.
>
> AEC Integrations

Record the date sent on the Linear issue.

### 4. What we can produce

Only what we hold, in the form we keep it, if the process is valid and not quashed or limited:

- the email address on the account (Supabase Auth);
- the account and profile records (`profiles`, `profile_details`);
- the review and its submission and moderation records (`reviews`, `review_updates`, `audit_log`);
- the hashed IP, in the form kept, under a protective order only.

**What the hashed IP can and cannot show.** A raw page-view envelope carries no account id, and its
cookies are stripped, so no envelope says which visitor was the reviewer. Matching needs the
requesting party to supply a candidate IP address and month, which we would hash with that month's key
and look for. Whether to run that comparison is the attorney's call, not ours.

### 5. Object or ask for a protective order

As a non-party we may object, or ask the court for a protective order (Fla. R. Civ. P. 1.351, 1.410
and 1.280(c)). In unmasking cases Florida courts applying the Dendrite approach (Munson v. Scotland)
weigh notice to the speaker, the exact statements, a prima facie showing of defamation, and the
plaintiff's need against the right to speak anonymously. The attorney decides whether to object. If
the hashed IP is produced, ask for a protective order first. While the secret survives, a keyed hash
is pseudonymous, not anonymous. Tell the requesting party early that we hold no raw address, once step
2e confirms it.

### 6. The trail

On the Linear issue, dated: the process received, the hold sent, the exports and where they are, the
reviewer notice or why none was sent, every exchange with the requesting party, what was produced and
when, and when the hold ended.

## Litigation hold notice

Send this the day a demand letter, a subpoena, or any claim we reasonably expect to be sued over
arrives. It goes to everyone who can delete or change the records: today Chris, and every person with
production Cloudflare, Supabase, GitHub or PostHog access.

> Subject: Litigation hold: [matter], from [date]
>
> We have received [a demand letter / a subpoena / notice of a claim] about [subject]. Until you are
> told in writing that this hold has ended:
>
> - Do not delete, overwrite or edit any record about [subject], wherever it is: D1, R2, Supabase,
>   PostHog, GitHub, email, Linear, or your own files.
> - Do not rotate or delete the `PAGE_VIEW_IP_HASH_SECRET` Worker secret on any environment.
> - Do not run any ops script that deletes data without asking first.
> - Tell [Chris] at once about any record that a scheduled job is about to delete.
>
> The Linear issue for this matter is [AECI-N].

**Place the hold in the app the same day (AECI-1638).** The legal retention prune deletes audit
records four years after the action and acceptance records six years after a vendor account ends
(ADR 0058). Since AECI-1914 it also deletes an acceptance of a claim never approved six years
after the claim was rejected, an acceptance with no company or claim six years after it was given,
and the acceptances of a deleted company six years after the deletion. Since AECI-1971 it also
deletes, four years after the action, an acceptance audit record that no acceptance names any
more. A litigation hold is its off switch, and the only one any job has.

1. Open `/admin/legal` and scroll to **Litigation holds**. Choose **Place a hold**.
2. Pick the scope. For any real legal process, start with **Everything (global)**. Narrow it to
   one vendor only once the attorney confirms the scope, as "Unsure of the scope"
   below describes. **One vendor** when the matter is about one company: enter its vendor id from
   `/admin/vendors`. **Everything (global)** when the matter is wider, or you do not yet know its
   scope. Also choose global when the matter needs a record a vendor hold does not reach (see
   step 4): a row whose only link to the company is a product, integration or claim already
   deleted, or something a former team member did before October 2026.
3. Write the reason and the Linear issue id as the matter reference. Choose **Place the hold**.
4. What it stops. A vendor hold keeps that company's audit records and lets every other audit
   record be deleted on schedule, as the Privacy Policy says (ruling 55, AECI-1970). An audit
   record is the company's when it names the company, is about one of its products or their
   reviews, is about an integration or connector link it built or its products take part in,
   or a claim or attestation on one, is about a claim on the company, or was written
   by one of its current team members. The full list is `docs/DATABASE_SCHEMA.md` §8.4 "Whose row
   it is, for a hold". It also keeps old released holds on the same company. A vendor hold also
   keeps that vendor's agreement acceptances and subscription grants, including the acceptances of a
   rejected claim on that company and of a deleted company with that id. An acceptance with no
   company or claim, such as a listing request's, has no vendor to hold: only a global hold keeps
   it. An evidence-removed audit record whose acceptances are gone names no company either, so
   only a global hold keeps it (AECI-1971). A vendor hold also keeps that company's workflow history, the record of who moved its
   claims, contests, review moderation and seat bans, by the same kind of ties (AECI-1913,
   `docs/DATABASE_SCHEMA.md` §8.4). A global hold keeps everything: the
   nightly run records `skipped`. Check the next morning: `/admin/system` shows the
   `legal-retention-prune` row as `ok` for a vendor hold, with other records still deleted and the
   run metric tagged `audit:scoped`, or as `skipped` for a global hold.
5. Release it only when the attorney says the matter is closed (see "Ending a hold" below). Choose
   **Release hold**, give the reason, and the prune resumes on its next run.

The hold stops this one job. It does not stop the jobs in the next table.

**When the "Litigation hold open for N days" email arrives.** The legal retention job sends
`litigation-hold-reminder` to the support inbox for every hold open more than 90 days, and
again every 30 days while it stays open (AECI-1638). A hold nobody remembers keeps personal
data past the Privacy Policy period, so answer every one.

1. Open the Linear issue named as the matter, or ask the attorney, whether the matter is still
   open.
2. **Closed:** release the hold on `/admin/legal` with the reason, and follow "Ending a hold"
   below. The prune resumes on its next run.
3. **Still open:** keep the hold. Add a dated comment to the matter's Linear issue saying who
   confirmed it is still needed. The reminder comes back in 30 days.
4. **Unsure of the scope:** a global hold that only needs one vendor can be replaced. Place the
   vendor hold first, then release the global one, so no night runs unprotected.

**Routine deletes the hold must work around.** None of these has an off switch. Export the affected
records before they run, rather than stopping the job:

| Job | What it deletes | When |
|---|---|---|
| Retention prune | `page_views` older than 400 days, `job_runs` older than 90 | Daily 03:00 UTC. Each `page_views` day is archived to R2 first |
| Raw page-view store lifecycle | R2 objects older than 400 days | Continuous |
| Acceptance evidence removal | `agreement_acceptances.ip` and `user_agent` after 90 days | Daily 17:00 UTC |
| Request confirmation sweep | `request_confirmations` rows past `expires_at` (7 days) | Daily 14:30 UTC |
| Workers Logs and traces | Everything after 7 days | Continuous |
| GitHub Actions artifacts | Axe and e2e artifacts after 7 to 30 days | Continuous |
| Account deletion | The user's profile, and the link from their reviews | When the user asks |

**Records no job deletes.** The plan-change ranking snapshots under `evidence/` in each `UPLOADS`
bucket are under a 4-year R2 bucket lock (ADR 0056). Nobody can delete or overwrite them, so the hold
needs no step for them. Their ledger, `plan_change_snapshots` in D1, has no delete path either.
The acceptance chain files under `evidence/acceptance-chain/` (ADR 0057) are under their own
indefinite lock, and their ledger tables have no delete path. They hold fingerprints, not rows, so
they prove an acceptance row was not edited but cannot restore it. Export the acceptance rows
themselves for the hold.

**Ending a hold.** Only when the attorney says the matter is closed. Release the hold on
`/admin/legal`, record the end date on the Linear issue and tell everyone who got the notice.
Four years after the release, the legal retention prune deletes the hold record and its audit
rows, because the reason can name a person. Copy anything the matter file needs before then.

## Pull the ranking evidence for a product

Use this when a demand letter, a regulator or counsel asks us to show that a plan did not change a
product's ranking. The Terms promise it, and Florida's unfair trade practices law (FDUTPA) wants
records made at the time (counsel Q23). What exists and where is `docs/SEARCH_RANKING.md`
"Substantiation and retention".

Every time a plan starts or ends on a product, AECi records two ranking snapshots of it: one at the
event and one 30 days later. Each holds the product's ranking inputs, the search record, and its
position in `/products`, each taxonomy page it is on, and the home "most integrated" list. The
snapshots are JSON objects in the production `UPLOADS` bucket, under a 4-year lock. The D1 table
`plan_change_snapshots` is the index to them. ADR 0056.

1. Open a Linear issue for the matter, as for every legal event above.
2. Find the product id. Set `SLUG` in your shell to the product's slug from its URL, then run:

```
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT id, name FROM products WHERE slug = '$SLUG'"
```

3. Set `PRODUCT_ID` to that id. List its snapshots by date. Narrow `event_at` to the dates asked about.

```
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT event_at, kind, phase, cause, r2_key, written_at FROM plan_change_snapshots WHERE product_id = '$PRODUCT_ID' ORDER BY event_at, phase"
```

4. A retracted product has no `products` row. Its snapshots are still in the ledger. Take its id from
   the `product.deleted` audit row or from the request, and run step 3.
5. For each `r2_key`, set `KEY` to it and download the object into the matter's hold folder:

```
cd /tmp && npx wrangler r2 object get "aeci-uploads-production/$KEY" --remote --file "$(basename "$KEY")"
```

6. Each file is one snapshot. `positions` gives the rank and list size per list. `inputs` gives
   the ranking inputs. `plan_now` says whether a plan was live when it was taken. Compare the
   `event` snapshot with the `followup` one 30 days later. `commit_sha` names the ranking code
   that was running. That code and its tests are in git at that commit.
   Positions are computed from live D1 at `taken_at`, not from cached pages or Algolia search.
   Algolia uses whole-second timestamps and different tie breakers, and the index can lag D1.
   `algolia_record` is what the sync would write, not a read of the stored index record. Do not
   present the saved D1 rank as a search position (`SEARCH_RANKING.md` §7a).
7. A row with `r2_key` NULL was not written yet, or is failing. See `alerts.md`
   "Plan-change snapshot sweep". Say so in the reply rather than leave the date out.
8. Move the files out of `/tmp` into the hold folder.

## Prove an acceptance was not edited

Use this when a demand letter, a court or counsel asks us to show that an agreement acceptance or a
license grant is what was recorded at the time. Counsel asked for a tamper-evident record (Q5(c)),
and Chris ruled yes (ruling 15).

Each night at 18:00 UTC a job writes the SHA-256 fingerprint of every new or changed
`agreement_acceptances` and `license_grants` row to a file in the production `UPLOADS` bucket under
`evidence/acceptance-chain/`. Each file names the hash of the file before it, and DigiCert signs a
timestamp of each file's hash. The files hold fingerprints, ids and fields that are not personal.
The IP address and browser are not in the fingerprint. ADR 0057.

1. Open a Linear issue for the matter, as for every legal event above.
2. Run the verify after 18:15 UTC, so the night's export has run. It is read-only. It needs
   `openssl` on your PATH and a wrangler login with R2 and D1 read on the account.

```
pnpm --filter @aeci/api ops:verify-acceptance-chain -- --env production
```

3. Read the result. The verify ends with three separate lines: `LOCK:`, `CHAIN:` and `ROWS:`. A
   missing lock and a broken chain are different events with different remedies, so neither is
   folded into the other. `PASS` means `LOCKED`, `CHAIN INTACT` and `ROWS MATCH`. Each finding
   means:

| Finding | What it means | What to do |
|---|---|---|
| `LOCK MISSING` | No R2 lock rule covers the chain. Anyone with R2 write access could change it | Apply the lock in `docs/environments.md` "Acceptance chain lock", then re-run |
| `LOCK NOT INDEFINITE` (fail) | Only the 4-year `evidence/` rule covers it. Those files become deletable when it lapses | Apply the indefinite rule |
| `CHAIN BROKEN` | A file in R2 was changed, replaced, deleted or malformed. The seq named is the first file that no longer proves the ones before it | Stop. Tell Chris and counsel. Do not touch R2 |
| `CHAIN STALE` | Every link holds, but the newest file is more than 50 hours old. The export stopped, or the newest files were deleted | Check `job_runs` and `alerts.md` "Acceptance chain export". If the export ran, treat it as `CHAIN BROKEN` |
| `TIMESTAMP MISSING` | DigiCert was unreachable that night, or its reply failed the Worker's signature check and was not stored. Each run retries up to 7 outstanding earlier files, newest first, with no age cutoff | Check `alerts.md` "Acceptance chain export" if it persists |
| `TIMESTAMP INVALID` | `openssl ts -verify` failed. Usually DigiCert rotated its intermediate | See the header of `apps/api/scripts/certs/digicert-tsa-chain.pem` |
| `CHANGED` | The D1 row differs from its last fingerprint | Find its audit row. A write after the last export with an audit row is legitimate and shows in tomorrow's file. One with no audit row is an edit outside the app |
| `UNEXPORTED` (fail) | A row older than the last export is missing from the chain | Treat it as `CHANGED` |
| `ABSENT` | A row in the chain is missing from D1 | Restore it from D1 Time Travel if within 30 days, and tell Chris |
| `TOMBSTONE WITHOUT PRUNE AUDIT` | A row was deleted with no prune audit row naming it | Treat it as `ABSENT` |

4. To give the evidence for one acceptance, set `ID` to the acceptance id. Find the files that
   carry it. Each night's file only lists the rows that changed, so the latest file that names it
   holds its current fingerprint.

```
cd /tmp && npx wrangler d1 execute aeci-app-production-us --remote --command "SELECT seq, fingerprint, deleted FROM acceptance_chain_rows WHERE row_id = '$ID'"
```

5. Set `SEQ` to the six-digit seq, for example `000042`. Download that file and its timestamp token
   into the matter's hold folder. Then download every earlier file too, because each link proves the
   one before it. The verify in step 2 already walked them all.

```
cd /tmp && npx wrangler r2 object get "aeci-uploads-production/evidence/acceptance-chain/$SEQ.json" --remote --file "$SEQ.json"
```

```
cd /tmp && npx wrangler r2 object get "aeci-uploads-production/evidence/acceptance-chain/$SEQ.tsr" --remote --file "$SEQ.tsr"
```

6. Anyone can check the token. Run these two from the repo root. Set `SHA` to the file's SHA-256
   from the first, then run the check against the pinned DigiCert chain. It prints
   `Verification: OK`.

```
shasum -a 256 "/tmp/$SEQ.json"
```

```
openssl ts -verify -digest "$SHA" -in "/tmp/$SEQ.tsr" -CAfile apps/api/scripts/certs/digicert-tsa-chain.pem
```

7. The row's fingerprint is `sha256(canonicalJson(...))` over the columns in `COLUMN_MANIFEST`
   (`apps/api/src/lib/acceptance-chain.ts`). That code at the commit that wrote the file says
   exactly how to recompute it from the D1 row.
8. Move the files out of `/tmp` into the hold folder.

## A legal change notice did not go out

Not a paging alert. Use this when a published material version's card on `/admin/legal` shows a
company under "Not reached", when "Not yet delivered" stays above zero an hour after a send, when
the queue line says the notice did not finish, or when a company says it never got the notice
(AECI-1620, `VENDOR_SIGNUP_PROCESS.md` §3 step 12).

**Read the card.** Every state below is something the card shows. The company counts come from
`legal_notice_deliveries` (one row per company), the address counts from `notification_sends`
(each address once, by its latest send).

| The card shows | Meaning | Do |
|---|---|---|
| "The last send queued N companies", Not reached 0, Not yet delivered 0 | Every company was delivered | Nothing |
| Not yet delivered above 0 | Those companies' messages are waiting or retrying (10, 20, then 30 minutes apart) | Wait an hour. Each one ends as Delivered or under "Not reached" |
| "Waiting too long": a company with "Queued for more than two hours. Send the notice again." | Its row is still queued with no update for two hours, longer than the retries take. The message is gone (the consumer died on its last attempt, or its last write failed) | Press "Send the notice again" before the effective date. After it, the company moves to "Not reached" |
| "Delivered, with an address to check": "The email service did not confirm one of its addresses, so that email may not have arrived." | A send timed out or threw after it may have reached Resend. Its key is kept, so a re-send will not retry it | Check Resend's log for that message. If it did not go, contact the company directly |
| "Delivered, with an address to check": "One of its addresses was held by this tier's email rules and got nothing." | Off production the tier policy held an outside address. Expected on demo and local; never on production | On production, read the `email-suppressed-in-production` alert. Elsewhere, nothing |
| "The notice did not finish queuing" right after every company was queued | The delivery rows could not be written (`aeci.legal_notice: could not record …`), so the fan-out reported itself incomplete even though the messages went | Press "Send the notice again": it rewrites the rows, and the keys stop a second email |
| "The notice did not finish queuing. It stopped after queuing N companies" | The audience read or a queue send failed (`aeci.legal_notice.enqueue{outcome:failed}`), or `LEGAL_NOTICE_QUEUE` is unbound (`outcome:unbound`). The companies it could not queue are listed as "It could not be added to the send queue." | Press "Send the notice again". An unbound queue means a deploy missed the binding: check `wrangler-legal-notice.spec.ts` and the tier's deploy first |
| "No outcome is recorded yet" | Still queuing, or the outcome write failed after the queue took the messages | Refresh after a minute. If it stays, send again |
| Not reached: "The stored PDF did not match the published copy." | The object at `pdf_key` in `UPLOADS` is not the file the publish hashed, or it is gone | Restore the published file. Never re-run `legal-pdf.yml` over it (it refuses). Then send again |
| Not reached: "The seat email addresses could not be read." | Supabase Auth was down, or `SUPABASE_SERVICE_ROLE_KEY` is missing. Nothing was sent to that company | Fix Auth or the secret, then send again. On local dev without the key this is expected |
| Not reached: "The email service refused one or more of its addresses." | Resend answered non-2xx after every retry. The address line shows them under "Addresses failing" | Check Resend status and the sending domain, then send again |
| Not reached: "Email sending is not set up on this tier." | No `RESEND_API_KEY` or `EMAIL_FROM` on the tier | Set them, deploy, send again |
| Not reached: "The site address is not set, so the link could not be built." | `PUBLIC_SITE_URL` is unset | Set the var, deploy, send again |
| Not reached: "A database or service read failed." | A D1 or R2 read threw on every attempt | Check D1 and R2 health, then send again |
| Not reached: "No seat or billing email to send to." | The company has no unbanned seat (Vendor Terms) or owner seat (Managed plan) with an address, and no billing email | Ask the company for a billing email, or add a seat, then send again |
| Not reached: "Still waiting when the version took effect, so it was not sent." | The message was still queued at the effective moment. The card also says the notice was not completed | A legal question for Chris: that company had no notice from us. Re-send is refused once the version is in effect. For a Listing Accuracy Policy or Review Guidelines version (AECI-1969) the company stays on its earlier policy version, and its admin Billing tab says so |

**Read the logs** for detail. In PostHog Logs, search `aeci.legal_notice`. Each error names the
`legal_version_id`, the `vendor_id` and the version, and carries `reason_code`. The last attempt
says "the message is dropped".

**Send again is always safe.** It re-reads the audience and queues every company not yet
delivered. For a Terms of Service or Privacy Policy version (AECI-1637) the audience is accounts: it queues every account not yet delivered, each keyed `legal-account-change:{document}:{version}:{profileId}`, and the card says "accounts". Each address is keyed
`legal-terms-change:{document}:{version}:{vendorId}:{recipientHash}`, so an address already
reached for that company gets nothing. It refuses once the version has taken effect, because the
email says it has not.

**What went to one address.** Hash the address and read the ledger:

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --command "SELECT created_at, outcome, dedupe_key FROM notification_sends WHERE notification_id = 'legal-terms-change' AND recipient_hash = 'HASH' ORDER BY created_at DESC LIMIT 20"
```

## The day the first versions take effect (AECI-1870)

Not a paging alert. Use this on the effective day of the first in-force versions, after 12:00 UTC,
to confirm the day-of notice went out (counsel Q60, rulings 28 and 68).

**What goes out.** At 12:00 UTC the `legal_first_effective_notice` job runs from the protest
reminder's tick. For each moment in the last 7 days at which a document's first in-force version
took effect, it queues one `legal-first-effective` email per unbanned account, vendor seats
included, listing every document that took effect then. An owner seat also reads that the portal
will ask it to accept the Vendor Terms, when they are in the list. A billing email with no account
gets nothing. A later version sends nothing, and a moment more than 7 days old is never sent. The
job then stamps `legal_versions.first_effective_notice_enqueued_at` on each row of the moment, with
a `legal_version.first_effective_notice_enqueued` audit row, so a second run sends nothing.

**Check the run.** `/admin/system` shows the `legal-first-effective-notice` row. Its `detail` lists
each moment with its documents, the accounts queued and the rows stamped:

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --command "SELECT started_at, finished_at, outcome, detail FROM job_runs WHERE job = 'legal-first-effective-notice' ORDER BY id DESC LIMIT 3"
```

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --command "SELECT document, version, effective_at, first_effective_notice_enqueued_at FROM legal_versions ORDER BY effective_at"
```

**Check the sends.** Each account's send is keyed `legal-first-effective:{YYYY-MM-DD}:{profileId}`.
Count them by outcome an hour after the run:

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --command "SELECT outcome, count(*) AS n FROM notification_sends WHERE notification_id = 'legal-first-effective' GROUP BY outcome"
```

| You see | Meaning | Do |
|---|---|---|
| Run `ok`, a moment `enqueued`, rows stamped, sends `sent` near the account count | Done | Nothing |
| Run `ok` with no moment, and no row stamped | No first in-force version took effect at that moment: a version is not published, its date moved, or it is a later version | Check `/admin/legal` shows each version published with the same date. No email is owed for a later version |
| Run `failed`, a moment `failed` with `unbound` or `send_batch` | The fan-out did not finish, so nothing was stamped | Fix the queue binding or wait for the queue. The next 12:00 run queues it again inside the 7 days, and the keys stop a second email |
| `stale` above 0 | A first version took effect more than 7 days ago with no notice stamped | A question for Chris. The job will never send it. Any notice now is a manual decision |
| Sends `failed` or rows missing for some accounts | A send failed after its retries (10, 20, then 30 minutes) | Read PostHog Logs for `aeci.legal_notice` with `audience:first-effective`. Re-sending is a manual decision: the job does not re-queue a stamped moment |

The band is separate: a `kind: "in-force"` entry in `notices.json`, added in the bump-day change
(`apps/web/src/content/legal/README.md`, "Announcing a new version before it takes effect" step 7).

## A company is blocked on the acceptance screen and has no working owner seat (AECI-1677)

Once a Vendor Terms version is in force, a company with no acceptance of a version in force sees
only the acceptance screen, and only an owner seat can accept (ruling 24,
`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24). A company whose owners are all banned, or which has only
member seats, cannot unblock itself. Its member seats see "Your company has no owner seat that can
sign in." Find these companies before the effective date, not after.

1. **Before the effective date, list who has not accepted.** On `/admin/legal`, open "Who has
   accepted" and read the "Not yet" list for the version that will take effect. Each name links
   to `/admin/vendors/:id`.
2. **Check each company's seats.** On the vendor page, Seats tab: a company needs at least one
   seat marked owner that is not banned. Note every company with none.
3. **Find the person who should own it.** Use the claim on record or the member seats. Confirm
   with the company, in writing, who has authority to accept for it.
4. **Make that person an owner seat.** On the vendor page, provision a seat for their email
   (`POST /api/admin/vendors/:id/seats`, §5.7). It creates an owner seat, or promotes an
   existing member seat to owner, with its audit row.
5. **Tell them.** Reply to the company: an owner seat now exists, and the next sign-in shows the
   acceptance screen. Do not accept on their behalf: an acceptance is the company's act.
6. **After the effective date,** a member seat that writes in about the screen gets the same
   steps 2 to 5.

## The digest reports `legal_agreement_date_moved` (AECI-1689)

A Vendor Terms, Managed plan agreement, Terms of Service or Privacy Policy version (the last two since AECI-1637) was published with one effective date, and a later commit changed the upcoming entry's `effectiveOn`. The row is now in force nowhere: the page keeps the old version, new acceptances keep stamping it, and the acceptance screen asks nothing. The `/admin/legal` card shows the same alert. The notice that went out named the published date. Move the entry back to that date in a new commit and deploy it. If the published date is truly wrong, the fix is a new version, announced and published again (legal `README.md`).

## The digest reports `legal_agreement_unpublished` (AECI-1689)

An upcoming Vendor Terms, Managed plan agreement, Terms of Service or Privacy Policy version (the last two since AECI-1637) is 30 days or less from its effective moment, or past it, and has no `legal_versions` row on this tier. Without the row it never becomes the version in force: the page keeps "takes effect on <date>" and new acceptances keep the old version. Publish it on `/admin/legal` (legal `README.md` "Publishing an upcoming agreement version"). The publish needs 30 days of notice, so inside 30 days move the effective date instead, unless a Vendor Terms change is expedited. In demo and production the publish is off until `LEGAL_PUBLISH_ENABLED` is turned on, so there the line is expected until that release.
- **A hidden value is still in search.** The by-id sync failed. Check Workers Logs for the field-hide Algolia sync failure, then see "Algolia sync failed".
