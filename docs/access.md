# Cloudflare Access — non-prod environments

How `staging.aecintegrations.com` and `*.aec-integrations.workers.dev` PR previews are gated, and how to manage the allowlist and rotate the service token over time.

**Referenced by:** [`CICD_PLAN.md`](./CICD_PLAN.md) § 2.2; Linear AECI-75 (this setup), AECI-71 (consumer — staging deploy + smoke tests).

---

## Scope

- **Gated:** `staging.aecintegrations.com` and any preview Worker on `*.aec-integrations.workers.dev`.
- **Not gated:** production (`aecintegrations.com`). Production is public by design.

Access is a *network-level* gate in front of the non-prod hostnames. Once a user is past the Access challenge they still have to log into AECi itself with a staging-test Supabase account — Access is additional auth, not a replacement (per the AECI-71 spec note).

---

## Locked decisions

These were settled by AECI-75. Don't deviate without raising the issue first.

- **One Access application** covers both staging and previews. Splitting the app per-surface has been observed to break Worker requests even when the wildcard is intact (see Cloudflare's workers.dev guidance) — keep them combined.
- **Identity provider:** One-Time PIN (OTP) to email. No SSO required, no IdP dependency, no failure mode that takes both admins offline at once. Swap to Google OAuth later by adding a second IdP and flipping `allowed_idps` on the app — current setup keeps that door open.
- **Allowlist policy** by explicit email, not domain. Adding someone is a one-line change; nobody gets through by accident from a `@thewbsproject.com` typo.
- **Single service token** (`aeci-gh-actions`) for all GitHub Actions workflows that need to bypass Access. No per-workflow tokens.
- **No Access on production.** Don't gate `aecintegrations.com`; that's the public site.

---

## 1. Current configuration (recorded)

The Cloudflare resources as deployed. If any of these change, update this section in the same PR.

| Item | Value |
|---|---|
| Cloudflare account | `AEC Integrations` — `e62ec9d8012c3e0c225f8e4dbab76b79` |
| Access app | `AECi Non-Prod` — `5e36ee8f-33e1-4f60-b525-77d87e0a103c` |
| App AUD tag | `6d89b8089d435389e9d1bdcc5bdb5a85e7b6938aa155d411fe1729d53dd98643` |
| Allow policy | `AECi allowlist` — `4c6b7bbd-6371-4a21-a5db-a3ae9c3c9afd` |
| OTP identity provider | `c31649de-3c54-40aa-829c-d424e74c0f7f` |
| Service token | `aeci-gh-actions` (Client ID + Secret in GitHub repo secrets as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) |
| Destinations | `staging.aecintegrations.com`, `*.aec-integrations.workers.dev` |
| Session duration | `24h` |
| Allowlist emails | `chrisw@thewbsproject.com`, `billh@thewbsproject.com` |

---

## 2. Adding someone to the allowlist

Two paths. Pick whichever is in front of you.

**Dashboard (preferred for one-offs):**

1. https://one.dash.cloudflare.com → **Access** → **Applications** → **AECi Non-Prod** → **Policies**.
2. Edit `AECi allowlist`.
3. Under **Include**, add a row: **Emails** → the address to add.
4. **Save**. Takes effect within ~30 seconds.

**API (preferred for scripts, or when you want a change log):**

```bash
ACCOUNT_ID='e62ec9d8012c3e0c225f8e4dbab76b79'
POLICY_ID='4c6b7bbd-6371-4a21-a5db-a3ae9c3c9afd'

# Fetch the current policy.
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/policies/$POLICY_ID" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result' > policy.json

# Edit policy.json to append a new include entry, then PUT it back.
# Each entry has the shape { "email": { "email": "person@example.com" } }.
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/policies/$POLICY_ID" \
  --request PUT \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json @policy.json | jq '.success, .errors'
```

The API token needs `Access: Apps and Policies Write`, account-scoped.

After the change, ask the new user to visit a covered URL (browser private window). They'll get an OTP at the email you added.

---

## 3. Removing someone

Same two paths as § 2, in reverse — drop the email from the **Include** list. Save / PUT.

> Active sessions continue until the 24-hour token expires. For immediate revocation: **One** → **My Team** → **Users** → find the user → **Revoke**.

If you remove your own email by accident, see § 6 (Lockout recovery) — account-owner dashboard access bypasses Access on the dashboard itself, so you can always log back in via dashboard to fix the policy.

---

## 4. Rotating the `aeci-gh-actions` service token

**Cadence:** at least annually. Immediately on suspected compromise or when someone with `gh` access to the repo's secrets leaves the team.

Create the new token first, swap secrets, confirm, *then* delete the old one. Don't delete first — workflows in flight will 403.

1. **Create the replacement token.**
   https://one.dash.cloudflare.com → **Access** → **Service Auth** → **Service Tokens** → **Create Service Token**.
   - Name: `aeci-gh-actions-YYYYMMDD` (date-stamp so it's distinguishable from the live one).
   - Duration: 1 year.
   - **Copy Client ID + Client Secret immediately** — the Secret is shown once.

2. **Attach a Service Auth policy** for the new token on the `AECi Non-Prod` app.
   App → **Policies** → **Add a policy** → Action: **Service Auth** → Selector: **Service Token** → Value: the new token. Save.
   (You can also edit the existing `aeci-gh-actions service auth` policy and add the new token as an additional include — that keeps the policy count flat.)

3. **Update GitHub repo secrets.**

   ```bash
   gh secret set CF_ACCESS_CLIENT_ID     --repo the-wbs-project/aec-integrations --body "$NEW_CLIENT_ID"
   gh secret set CF_ACCESS_CLIENT_SECRET --repo the-wbs-project/aec-integrations --body "$NEW_CLIENT_SECRET"
   ```

   Or paste them via the GitHub UI: https://github.com/the-wbs-project/aec-integrations/settings/secrets/actions

4. **Confirm a staging workflow passes** before tearing down the old token. Trigger `refresh-staging.yml` (or any workflow that hits a staging URL) and watch it succeed.

5. **Delete the old token.**
   Service Tokens → old token → ⋯ → **Delete**. Also remove its include entry from the Service Auth policy if you split policies in step 2.

---

## 5. Verification

Once `staging.aecintegrations.com` resolves to a Worker (post-AECI-71), all three of these should hold:

**Browser flow (negative case):** open `https://staging.aecintegrations.com` in a private window.
→ Cloudflare Access challenge with OTP prompt. Enter an **allowlisted** email, receive PIN, enter it, get admitted. **Not allowlisted** addresses receive no PIN and are denied.

**`curl` flow without headers (negative case):**

```bash
curl -I https://staging.aecintegrations.com
# Expect: HTTP/2 302  → Location: https://<team>.cloudflareaccess.com/...
```

**`curl` flow with the service token (positive case):**

```bash
curl -H "CF-Access-Client-Id:     $CF_ACCESS_CLIENT_ID" \
     -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
     https://staging.aecintegrations.com/api/version
# Expect: HTTP/2 200 with JSON body { sha, deployedAt, environment }.
```

If the curl-with-headers case returns the Cloudflare login HTML instead of a 200, the Service Auth policy isn't attached to the app — recheck step 2 of § 4.

Before AECI-71 brings `staging.aecintegrations.com` online, the challenge will still fire — Cloudflare evaluates Access *before* it tries to reach an upstream, so this configuration is testable against any covered hostname the moment that hostname has a DNS record.

---

## 6. Lockout recovery

Tiered by how much you broke.

**You removed your own email from the allowlist.** No real lockout — Cloudflare account owners (Chris, Bill) bypass Access on `dash.cloudflare.com` itself. Sign in to the dashboard, fix the policy.

**The OTP IdP is misconfigured / no IdP is reachable.** Add a temporary domain-fallback policy via the API or dashboard so any `@thewbsproject.com` address gets in:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/policies" \
  --request POST \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  --json '{
    "name": "temp domain fallback",
    "decision": "allow",
    "include": [{ "email_domain": { "domain": "thewbsproject.com" } }]
  }'
```

Then attach it to `AECi Non-Prod` via PUT on the app's `policies` array. Remove the temp policy once the OTP IdP is back.

**Both Chris and Bill locked out of the dashboard.** Cloudflare support recovers account-owner email — this is the whole reason OTP-to-email is the IdP rather than SSO (no failure mode that takes both admins out simultaneously). Contact: https://dash.cloudflare.com/support.

---

## 7. Architectural notes

**Why Access is non-prod only.** Production is the public site — gating it would block the entire purpose of AECi. Non-prod is for in-progress work and CI smoke tests; the cost of accidental public exposure there is high.

**Why OTP over Google OAuth.** OTP requires no IdP config, no SAML, no app registrations, and no admin sharing a Google Workspace. It also has no single-point-of-failure that locks out both admins. Migrating to Google OAuth later is a one-line addition: create a second identity provider, append its ID to the app's `allowed_idps` array, optionally remove OTP. No data migration needed — Cloudflare looks up users by email regardless of which IdP issued the session.

**Why a single Access app.** Cloudflare's `*.<account>.workers.dev` documentation specifically warns against creating multiple Access apps that overlap on Worker hostnames — they have been observed to block requests even when the broader app is intact (`opennextjs-cloudflare#1171`). Single app, multiple `destinations`, multiple policies.

**Why `*.aec-integrations.workers.dev` not `*.aeci-web.workers.dev`.** `aeci-web` is the Worker name, not the account subdomain. workers.dev URLs are flat: `<worker>.<account-subdomain>.workers.dev`. The account subdomain is `aec-integrations`. Earlier Linear text mentioning `*.aeci-web.workers.dev` is wrong; Cloudflare rejects it with code `12130: domain does not belong to zone`.

**Belt-and-suspenders auth.** Even past Access, a request still hits the SSR Worker, the SSR Worker still calls the API Worker via service binding, and the API still requires Supabase JWT auth for any user-scoped endpoint. Access is one layer of network-level isolation, not the auth model.
