# Cloudflare Access — environment gating

How `staging.aecintegrations.com`, `aeci-*.thewbsproject.workers.dev` PR previews, and — until launch — web production `demo.aecintegrations.com` are gated, and how to manage the allowlist and rotate the service token over time.

> **As-built (effective at the 2026-10-03 cutover, AECI-1161, [ADR 0036](./adr/0036-move-to-the-wbs-project-cloudflare-account.md)).** Access now lives in **The WBS Project** Zero Trust org (`the-wbs-project.cloudflareaccess.com`), not the old AEC Integrations org. The old account's separate agent-production Access app is folded into the one app below. The ids, AUD and the `aeci-*.thewbsproject.workers.dev` pattern in this file are the new ones. Where this file says "Locked decisions", they still hold.

> **Per [ADR 0017](./adr/0017-single-supabase-auth-project-across-environments.md):** all environments share a single Supabase **auth** project, so per-environment isolation is enforced **here, by Cloudflare Access** — not by Supabase project separation. Production is gated to the allowlist throughout pre-launch and **opened at launch** by removing its Access destination.

**Referenced by:** [`CICD_PLAN.md`](./CICD_PLAN.md) § 2.2; Linear AECI-75 (this setup), AECI-71 (consumer — staging deploy + smoke tests).

---

## Scope

- **Gated:** `staging.aecintegrations.com`, any preview Worker on `aeci-*.thewbsproject.workers.dev`, and — **until launch (ADR 0017)** — web production `demo.aecintegrations.com`. A temporary `stage2.aecintegrations.com` destination existed on this app 2026-08 → 2026-09 (AECI-637) and was removed at teardown (AECI-808). Any such hostname goes on **this same app as a new destination**, never a new app: per "Locked decisions" below, splitting the app per-surface has been observed to break Worker requests.
- **Not gated:** the landing site (`aecintegrations.com` + `www.`), public by design. Web production becomes public **at launch**, when its Access destination is removed.

> **The catalog-agent spike Worker needs no new Access app or destination (ADR 0034).** `apps/agent` runs with `workers_dev: true` on both its tiers, so it answers on `aeci-agent.thewbsproject.workers.dev` and `aeci-agent-production.thewbsproject.workers.dev`. Both match the existing `aeci-*.thewbsproject.workers.dev` destination on the `AECi Non-Prod` app recorded in §1, so they are already gated — including the production-named one, because the wildcard is a hostname pattern and carries no tier semantics. Do **not** add a second app for it: per "Locked decisions" above, splitting the app per-surface has been observed to break Worker requests. That Worker also runs its **own** in-Worker gate on every route (a byte-for-byte copy of `apps/datatool`'s), so a direct origin hit still fails closed; it reads the same `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` values recorded in §1, and accepts an `Authorization: Bearer <TOOL_TOKEN>` fallback for `curl`. A scripted call must satisfy **both** layers: the `aeci-gh-actions` service-token headers for Access, plus the bearer token for the Worker.

Access is a *network-level* gate in front of these hostnames. Once a user is past the Access challenge they still have to log into AECi itself with a Supabase account — Access is additional auth, not a replacement (per the AECI-71 spec note).

---

## Locked decisions

These were settled by AECI-75. Don't deviate without raising the issue first.

- **One Access application** covers both staging and previews. Splitting the app per-surface has been observed to break Worker requests even when the wildcard is intact (see Cloudflare's workers.dev guidance) — keep them combined.
- **Identity provider:** One-Time PIN (OTP) to email. No SSO required, no IdP dependency, no failure mode that takes both admins offline at once. Swap to Google OAuth later by adding a second IdP and flipping `allowed_idps` on the app — current setup keeps that door open.
- **Allowlist policy** by explicit email, not domain. Adding someone is a one-line change; nobody gets through by accident from a `@thewbsproject.com` typo.
- **Single service token** (`aeci-gh-actions`) for all GitHub Actions workflows that need to bypass Access. No per-workflow tokens. The token must be allowed on the production app/policy too (the `promote-to-prod` smoke now reaches a gated prod — ADR 0017).
- **Production gated until launch (ADR 0017).** `demo.aecintegrations.com` is behind Access during pre-launch (full lockdown to the allowlist), then **opened at launch** by removing its Access destination. The landing site (`aecintegrations.com` + `www.`) is always public. _(Supersedes the earlier "No Access on production" stance — that predated the single-auth-project model, in which Supabase-project separation no longer isolates environments.)_

---

## 1. Current configuration (recorded)

The Cloudflare resources as deployed. If any of these change, update this section in the same PR.

| Item | Value |
|---|---|
| Cloudflare account | `The WBS Project` — `004dc1af737b22a8aa83b3550fa9b9d3` (was `AEC Integrations`, `e62ec9d8012c3e0c225f8e4dbab76b79`, until the 2026-10-03 cutover) |
| Access app | `AECi Non-Prod` — `53dccd08-c97b-46ba-a96e-750a419d749f`, self-hosted. It also gates the agent spike's production-named Worker, which had its own app on the old account |
| Zero Trust team domain | `the-wbs-project.cloudflareaccess.com` (issues the Access JWT `iss` + serves the JWKS at `/cdn-cgi/access/certs`; consumed by `apps/datatool` `ACCESS_TEAM_DOMAIN`) |
| App AUD tag | `cccc1e20ad7d9da26dd5a7fe67716b39102bc74e4eceb9eab66afb5786d7b632` |
| Allow policy | `One Time Pin` (`AECi allowlist` on the old org). Policy id and OTP identity provider id on the new org: read them from the dashboard or `GET /accounts/{id}/access/policies`; they are not recorded in the runbook. The old ids (`4c6b7bbd-…`, `c31649de-…`) are dead |
| Service Auth policy | Service token `aeci-gh-actions` |
| Service token | `aeci-gh-actions` (Client ID + Secret in GitHub repo secrets as `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`) |
| Destinations | `aeci-*.thewbsproject.workers.dev`; `staging.aecintegrations.com` is added at the cutover, once the WBS zone is Active. `demo.aecintegrations.com` is listed in the pre-launch text below and is not a destination now (production is public) |
| Session duration | `24h` |
| Allowlist emails | `chrisw@thewbsproject.com`; `billh@thewbsproject.com` is to be added (runbook, 2026-10-01) |

> **Cutover note (ADR 0017):** adding `demo.aecintegrations.com` to the **Destinations** above (same app, same allowlist + service-token policies) is what gates production. The `aeci-gh-actions` service token must be allowed on the policy covering it so the `promote-to-prod` smoke (`verify-version.sh` / `verify-health.sh`) can reach prod. At launch, delete the `demo.aecintegrations.com` destination to make production public — no code change needed (the prod `CF_ACCESS_*` workflow vars then become a harmless no-op).

---

## 2. Adding someone to the allowlist

Two paths. Pick whichever is in front of you.

**Dashboard (preferred for one-offs):**

1. https://one.dash.cloudflare.com → **Access** → **Applications** → **AECi Non-Prod** → **Policies**.
2. Edit the `One Time Pin` policy.
3. Under **Include**, add a row: **Emails** → the address to add.
4. **Save**. Takes effect within ~30 seconds.

**API (preferred for scripts, or when you want a change log):**

```bash
ACCOUNT_ID='004dc1af737b22a8aa83b3550fa9b9d3'
POLICY_ID='<the One Time Pin policy id from the dashboard>'

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

**Why production is gated until launch.** Pre-launch, AECi isn't ready for the public, and (ADR 0017) all environments share one Supabase auth project — so environment isolation is enforced here, at the network edge, not by separate auth backends. Production is therefore gated to the allowlist during pre-launch and opened at launch by removing its Access destination. Non-prod (staging + previews) stays gated permanently. The landing site is always public. Either way, the cost of accidental public exposure of in-progress work is high, so the default is to gate.

**Why OTP over Google OAuth.** OTP requires no IdP config, no SAML, no app registrations, and no admin sharing a Google Workspace. It also has no single-point-of-failure that locks out both admins. Migrating to Google OAuth later is a one-line addition: create a second identity provider, append its ID to the app's `allowed_idps` array, optionally remove OTP. No data migration needed — Cloudflare looks up users by email regardless of which IdP issued the session.

**Why a single Access app.** Cloudflare's `*.<account>.workers.dev` documentation specifically warns against creating multiple Access apps that overlap on Worker hostnames — they have been observed to block requests even when the broader app is intact (`opennextjs-cloudflare#1171`). Single app, multiple `destinations`, multiple policies.

**Why `aeci-*.thewbsproject.workers.dev` not `*.thewbsproject.workers.dev`.** The `thewbsproject` subdomain is shared with other WBS apps, and a bare `*.` wildcard would put them all behind this app. Access takes a partial-label wildcard, so `aeci-*.` gates every AECi Worker and every PR preview (`aeci-web-pr-<N>`) and nothing else. Also note that `aeci-web` is the Worker name, not the account subdomain: workers.dev URLs are flat, `<worker>.<account-subdomain>.workers.dev`. Cloudflare rejects `*.aeci-web.workers.dev` with code `12130: domain does not belong to zone`. _(Until the cutover the subdomain was `aec-integrations` and the pattern was `*.aec-integrations.workers.dev`.)_

**Open issue (2026-10-01): the hostname app did not send one-time codes.** The self-hosted app on the `aeci-*` pattern sent no OTP code to the allowlisted address. The workaround was per-Worker **Worker Access** on `aeci-web-production` (Workers, then the Worker, then Access), set to "All traffic: require login on every URL". That setting also covers the custom domains. It must be scoped to workers.dev and previews only, or turned off, **before** `www.aecintegrations.com` binds, or the public site demands a login. It is step 6a of the cutover in `scripts/ops/2026-09-wbs-account-move/README.md`. Once the hostname app sends codes, remove the per-Worker Access and keep this one app. The `ACCESS_AUD` in `apps/agent` and `apps/datatool` is the app AUD above.

**Belt-and-suspenders auth.** Even past Access, a request still hits the SSR Worker, the SSR Worker still calls the API Worker via service binding, and the API still requires Supabase JWT auth for any user-scoped endpoint. Access is one layer of network-level isolation, not the auth model.

**Access-gated tiers measure only themselves.** Worth knowing before reading the admin panel (`ADMIN_PANEL_SPEC.md`) on staging or a PR preview: everything past the allowlist is, by construction, an operator or a CI service token, so **100% of a gated tier's `page_views` rows are internal traffic**. Numbers there prove the queries run; they are not a sample of anything. Production is the only tier whose traffic is real, which is also why the `ANALYTICS_INTERNAL_ASNS` read-time filter (§13 **D10**) is a *production* instrument — it subtracts the operator's own ISP from real traffic, a distinction that has no meaning behind Access. The var is declared and **ships unset on every tier**; see [`environments.md` → "Declared-but-unset knobs"](./environments.md) for its format and the three constraints binding it.
