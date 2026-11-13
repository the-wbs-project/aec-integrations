# Legal runbooks

Procedures for a legal event that carries its own deadline: a data breach, an accessibility barrier
report or demand letter, a subpoena for a reviewer's identity. The last four sections run our published legal versions: the
change notice, the acceptance screen, and the two digest checks on a version's effective date. No alert pages any of them. Alert runbooks are in
[`alerts.md`](./alerts.md). Subscription and billing procedures are in
[`subscriptions.md`](./subscriptions.md). Counsel's answers are verbatim in
`docs/LEGAL_COUNSEL_RECORD.md` (Q25, Q40, Q41). Where counsel did not say something, these steps say
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

**2. Decide whether it is notifiable.** Under 501.171, "personal information" that matters for us is an
email address together with a credential that would let someone into the account. Counsel (Q41):

| What was taken | Notifiable? |
|---|---|
| Email addresses with live magic-link tokens | Yes |
| Email addresses with live session tokens (the `sb-*-auth-token` cookie, a Supabase refresh token) | Yes |
| Email addresses with stored Google OAuth tokens | Yes. We hold none server-side; see the recorded checks |
| Email addresses alone | No |
| Names, work emails and claim records alone | No |
| IP addresses | No |
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

**5. What the individual notice says.** The date, or the estimated date range, of the breach. What
information was involved. How to contact us. The statute also sets what the Department notice holds.
The attorney drafts that one.

**6. Our processors.** A processor that holds our data must tell us of a breach on its side. Counsel
says within 10 days. The recorded checks below list which processor agreements say so.

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

**Processor breach-notice terms (checked 2026-11-11 against each public DPA).** Counsel says a processor
must tell us within 10 days. Two agreements meet that. Stripe meets it for GDPR data only. Six fix no
deadline at all. Spur's is unread. Listed on AECI-310.

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

**The Privacy Policy "stop working within days" sentence.** The "Edge request log" and "Debugging
record" bullets say single-use links, "such as a sign-in or confirmation link", "stop working within
days". The lifetimes behind that sentence:

| Link | Lifetime | Source |
|---|---|---|
| Sign-in (magic link) | 1 hour (3600 s, read 2026-11-12) | Supabase Auth "Email OTP Expiration" |
| Claim and listing confirmation | 7 days | `request_confirmations.expires_at`, swept by `cron-schedules.ts` |
| Seat invite | 14 days, reset on a re-send | `INVITE_TTL_DAYS` in `apps/api/src/lib/vendor-seat-invites.ts` |

**Verdict.** The sentence holds for sign-in and confirmation links, the two it names: one hour and 7
days. The seat invite is the weak case. It lives 14 days
and moves forward on every re-send, which is a stretch for "within days". It also needs a sign-in to the
invited mailbox to use, so a leaked invite link alone opens nothing. Raised as a text item for Chris to
rule: AECI-1681.

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

**Ending a hold.** Only when the attorney says the matter is closed. Record the end date on the Linear
issue and tell everyone who got the notice.

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
| Not reached: "Still waiting when the version took effect, so it was not sent." | The message was still queued at the effective moment. The card also says the notice was not completed | A legal question for Chris: that company had no notice from us. Re-send is refused once the version is in effect |

**Read the logs** for detail. In PostHog Logs, search `aeci.legal_notice`. Each error names the
`legal_version_id`, the `vendor_id` and the version, and carries `reason_code`. The last attempt
says "the message is dropped".

**Send again is always safe.** It re-reads the audience and queues every company not yet
delivered. Each address is keyed
`legal-terms-change:{document}:{version}:{vendorId}:{recipientHash}`, so an address already
reached for that company gets nothing. It refuses once the version has taken effect, because the
email says it has not.

**What went to one address.** Hash the address and read the ledger:

```bash
pnpm --filter @aeci/api exec wrangler d1 execute aeci-app-production --env production --remote --command "SELECT created_at, outcome, dedupe_key FROM notification_sends WHERE notification_id = 'legal-terms-change' AND recipient_hash = 'HASH' ORDER BY created_at DESC LIMIT 20"
```

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

A Vendor Terms or Managed plan agreement version was published with one effective date, and a later commit changed the upcoming entry's `effectiveOn`. The row is now in force nowhere: the page keeps the old version, new acceptances keep stamping it, and the acceptance screen asks nothing. The `/admin/legal` card shows the same alert. The notice that went out named the published date. Move the entry back to that date in a new commit and deploy it. If the published date is truly wrong, the fix is a new version, announced and published again (legal `README.md`).

## The digest reports `legal_agreement_unpublished` (AECI-1689)

An upcoming Vendor Terms or Managed plan agreement version is 30 days or less from its effective moment, or past it, and has no `legal_versions` row on this tier. Without the row it never becomes the version in force: the page keeps "takes effect on <date>" and new acceptances keep the old version. Publish it on `/admin/legal` (legal `README.md` "Publishing an upcoming agreement version"). The publish needs 30 days of notice, so inside 30 days move the effective date instead, unless a Vendor Terms change is expedited. In demo and production the publish is off until `LEGAL_PUBLISH_ENABLED` is turned on, so there the line is expected until that release.
- **A hidden value is still in search.** The by-id sync failed. Check Workers Logs for the field-hide Algolia sync failure, then see "Algolia sync failed".
