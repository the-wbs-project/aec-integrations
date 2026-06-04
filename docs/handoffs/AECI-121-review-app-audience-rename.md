# Handoff — Review App: rename promote facet `disciplines` → `audiences` (AECI-121)

**For:** whoever maintains the **review application** (the curator app that calls `POST /api/promote`).
**From:** AECi platform team.
**Status:** action required before the AECi API change ships. Coordinated, **atomic** cutover (no transitional alias) — read §4 "Cutover protocol" before deploying.
**Date:** 2026-06-04.

---

## 0. TL;DR

AECi renamed the taxonomy facet **"Discipline" → "Audience"** (AECi spec `docs/STAGE_1_SPEC.md` §5.5). The only thing that is a **binding contract change for you** is the promote payload/response key:

| | Old | New |
|---|---|---|
| Request: `product.disciplines` | `"disciplines": ["Architecture"]` | `"audiences": ["Architecture"]` |
| Response: `taxonomy.disciplines` | `"disciplines": [ … ]` | `"audiences": [ … ]` |

Everything else (the 21 facet values, their slugs, the find-or-create-by-slug semantics) is unchanged. We chose an **atomic cutover with no backward-compat alias**, so the AECi API and the review app must ship together with a short **promote freeze** — see §4. There is a **silent data-loss trap** if you skip the freeze (§4.1).

---

## 1. What changed and why

A separate "Roles" facet was rejected (~55% of proposed roles duplicated existing disciplines, others duplicated categories). Instead, the existing **Discipline** facet was renamed to **Audience** ("who is this for?") and expanded with cross-cutting job personas. One axis, no overlap to police. See AECi `docs/STAGE_1_SPEC.md` §5.5 for the canonical definition.

On the AECi (Supabase) side this is a pure rename plus 9 new vocabulary rows:

- Tables `taxonomy_disciplines → taxonomy_audiences`, `product_disciplines → product_audiences` (rows + ids preserved).
- Public routes `/disciplines/:slug → /audiences/:slug` (old URLs **301-redirect**, so nothing you've linked breaks).
- The promote contract key `disciplines → audiences` (this doc).

The **21 existing facet values keep their exact slugs**, so a product already promoted with `["Architecture"]` keeps the same `architecture` term and the same public URL.

---

## 2. The binding change — promote payload + response

The `POST /api/promote` contract is documented in `docs/REVIEW_APP_PROMOTE_API.md`. Two edits on your side:

### 2.1 Request — `product.audiences`

The product object's taxonomy array `disciplines` is renamed to `audiences`. Values are still **names or slugs**, still find-or-created by canonical slug, still order-independent, and still **fully replace** the product's audience set on every push (omit a term to remove it).

```diff
 {
   "product": {
     "ref": "p1",
     "name": "Revit",
     "categories": ["BIM", "Design Authoring"],
-    "disciplines": ["Architecture"]
+    "audiences": ["Architecture"]
   }
 }
```

> **Do not send both keys.** The renamed AECi API uses a strict-free Zod object that **silently ignores** an unknown `disciplines` key — it will not error, it will just treat audiences as empty and (because promote replaces join sets) wipe the product's audiences on the next re-push. Send exactly `audiences`. See §4.1.

### 2.2 Response — `taxonomy.audiences`

The response's `taxonomy.disciplines` array is renamed to `taxonomy.audiences` (same `{ slug, id, operation }` element shape). Update wherever you read it.

```diff
   "taxonomy": {
     "categories":  [ { "slug": "bim", "id": "d01…", "operation": "reused" } ],
-    "disciplines": [ { "slug": "architecture", "id": "e02…", "operation": "created" } ],
+    "audiences":   [ { "slug": "architecture", "id": "e02…", "operation": "created" } ],
     "phases":      []
   }
```

---

## 3. The 9 new persona audiences — add them to your vocabulary

Your Airtable "Disciplines" vocabulary currently holds exactly the **21 domain items** (Accounting & Finance … Surveying/Geomatics) and **none of the new personas**. The AECi reference data now seeds **30** audience terms: the same 21 domains **plus** 9 cross-cutting personas.

For curators to be able to tag products with the personas, **add these 9 rows to your facet vocabulary** (the same vocabulary you rename in §5). Send the **name** (or the slug) at promote time — the AECi API matches them to the already-seeded rows by canonical slug, so they come back `operation: "reused"`, not duplicated:

| Persona name (send this) | Canonical slug (what AECi stores) |
|---|---|
| Project Manager | `project-manager` |
| Project Engineer | `project-engineer` |
| Superintendent | `superintendent` |
| Estimator | `estimator` |
| Scheduler | `scheduler` |
| Foreman / Field Supervisor | `foreman-field-supervisor` |
| Designer / Drafter | `designer-drafter` |
| BIM Manager | `bim-manager` |
| BIM Coordinator | `bim-coordinator` |

If you skip this step, nothing breaks — the public taxonomy still lists the personas; curators just can't assign them. (And if you ever send a brand-new audience name AECi hasn't seeded, AECi will find-or-create it by slug, same as today for any taxonomy value.)

---

## 4. Cutover protocol (atomic — no alias)

The AECi API change is a **hard rename**: after it deploys, `POST /api/promote` accepts **only** `audiences` and emits **only** `taxonomy.audiences`. There is no dual-accept window. So the two repos must be coordinated.

### 4.1 ⚠️ The silent-wipe hazard (read this)

`POST /api/promote` validates the body with a Zod object that **strips unknown keys without erroring**, and a promote **replaces** each join set to exactly match the payload. Therefore, during any window where the two sides disagree:

- **API renamed, review app still sends `disciplines`:** the API drops the unknown `disciplines` key → resolves `audiences = []` → and a re-push of an already-promoted product **wipes that product's audience links** (no error, `200 OK`).
- **Review app sends `audiences`, API not yet renamed:** symmetric — the old API drops `audiences`, wipes the discipline links.

This only bites **re-pushes of already-promoted products** during the window (a first-time promote defaults to empty either way, so no data is lost there).

### 4.2 Safe sequence

Promotes are curator-initiated and low-frequency (pre-launch), so the simplest safe cutover is a **brief promote freeze**:

1. **Freeze promotes.** Pause the curator "Promote" action (or just agree not to click it) for the deploy window.
2. **Deploy both.** Ship the AECi API rename and the review-app change (§2). Order doesn't matter while frozen.
3. **Verify** (§4.3) against staging, then production.
4. **Unfreeze.** Resume promotes.

If a re-push *did* happen mid-window before the freeze, just re-push that product again once both sides are aligned — the audiences set is restored from the (correct) payload.

### 4.3 Post-deploy verification

- Push a test product with `"audiences": ["Architecture", "Project Manager"]`.
- Confirm the response returns `taxonomy.audiences` containing `{ "slug": "architecture", … }` and `{ "slug": "project-manager", … }`.
- Confirm the public pages render: `https://<aeci-host>/audiences/architecture` shows the product, and `https://<aeci-host>/disciplines/architecture` **301-redirects** to it.
- Confirm a re-push of an existing product **keeps** its audiences (not wiped).

---

## 5. Recommended (not required): rename your internal model

The binding contract is only the payload/response keys in §2. For consistency you *may* also rename, on your side:

- The Airtable **"Disciplines"** field/table → **"Audience"**.
- The review-app MCP surface: `list_taxonomy` `disciplines` key, the `discipline_id` filter on `list_products`, and the `disciplines`/`discipline_ids` arg on `update_product` → `audience*`.

This is cosmetic on your side and can land before, with, or after the contract change — it does not affect the AECi API, which only sees the promote payload. Do it whenever it's convenient; the personas in §3 are the only functional addition.

---

## 6. Checklist

- [ ] Rename the promote **request** key `product.disciplines` → `product.audiences` (§2.1).
- [ ] Rename the promote **response** read `taxonomy.disciplines` → `taxonomy.audiences` (§2.2).
- [ ] Never send both keys in one payload (§2.1 note).
- [ ] Add the 9 persona rows to your facet vocabulary so curators can assign them (§3).
- [ ] Coordinate the deploy with AECi: freeze promotes → deploy both → verify → unfreeze (§4.2).
- [ ] Run the §4.3 verification on staging, then production.
- [ ] (Optional) Rename your internal Airtable field + MCP surface to "Audience" (§5).

---

## 7. References

- AECi promote contract: `docs/REVIEW_APP_PROMOTE_API.md` (canonical; already updated to `audiences`).
- Facet definition: `docs/STAGE_1_SPEC.md` §5.5 "Taxonomy facets (Categories, Audiences, Phases)".
- DB shape: `docs/DATABASE_SCHEMA.md` §5–§6 (`taxonomy_audiences`, `product_audiences`).
- Reference vocabulary (the 30 audience terms): `supabase/reference-data/taxonomy.sql`.
- Linear issue: **AECI-121**.
