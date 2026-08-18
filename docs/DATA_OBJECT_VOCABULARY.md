# `data_object` Controlled Vocabulary

**Status:** Frozen (Stage 1.5). **Source of truth** for the `data_object` term list.
**Issue:** AECI-287. **Stage:** 1.5 — Integration Redesign.
**Machine-readable mirror:** [`data-object-vocabulary.json`](./data-object-vocabulary.json).

This document is the single canonical artifact for the `data_object` controlled vocabulary.
Everything downstream seeds from it:

- **AECI-288** — `docs/STAGE_1_5_SPEC.md` §2 **references this file** (it does not duplicate the
  table) so there is exactly one source of truth.
- **AECI-290** — the Review-app (bamako) Airtable `data_objects` table is seeded from this list.
- **"I8"** — the main app's D1 `taxonomy_data_objects` table + `apps/api/seed/data-objects.sql`
  are seeded from this list.
- **AECI-606** — the vocabulary's first **wire surface**: `GET /api/vendor/data-objects` serves the
  seeded rows to the vendor dashboard's `data_object` picker
  (`STAGE_2_ATTESTATIONS_SPEC.md` §6). It carries `slug` / `name` / `description` only — see §3 for
  why `aliases` stays server-side.

## 1. What a `data_object` is

A `data_object` is the **noun that flows between two integrated AEC products** — the *what* of an
integration. When Product A syncs with Product B, it is some `data_object` (RFIs, Budgets, Models…)
that moves. In the Stage 1.5 model a claim's identity is the triple **`integration` + `data_object`
+ `direction`**, so this vocabulary is load-bearing: claim identity, the sync headline, and (later)
cross-grain detection all key off these terms.

It mirrors the existing taxonomy vocabularies (`taxonomy_categories`, `taxonomy_audiences`,
`taxonomy_phases`) in shape — `slug` / `name` / `description` / `display_order` — and adds one new
field, `aliases` (see §3).

## 2. Governance — the vocabulary is closed

The list is **closed and frozen**. This is a deliberate constraint, not an oversight:

- **Promote resolves it find-only.** During promotion a free-text data-object value is matched
  against the canonical `slug` set (directly or via an alias). An **unmatched term is rejected** —
  it is **not** auto-created. A curator cannot mint a new term by typing one.
- **Adding, removing, or renaming a term is a deliberate vocabulary change** — a PR that edits this
  file and re-seeds **both** apps (main D1 + Review Airtable). It is reviewed as a vocabulary change,
  with awareness that it affects claim identity across both repos.
- **`slug` is the immutable identity key.** Once a term ships, its `slug` never changes (renaming a
  slug would orphan existing claims). `name`, `description`, and `aliases` **may** be edited freely —
  they are presentation/matching metadata, not identity.
- **Five terms that confirmed staff held out** of the closed set must clear this same bar to be
  added: `issues` (Issues / Observations), `transmittals`, `materials-deliveries`,
  `safety-incidents`, and `forms` (Forms / Checklists) were considered and **deliberately excluded**
  from the Stage 1.5 freeze.
- **Since AECI-606 the closure is visible to vendors as an exhaustive picker**, not only enforced
  server-side on free text. A vendor whose flow the list cannot express has **no in-product escape
  hatch** — the remedy is the vocabulary-change PR above, and the UI must never imply the vendor can
  extend the list. Two consequences worth stating plainly: this raises the practical cost of the five
  held-out terms, and `name` / `description` are now **user-facing copy** rather than only matching
  metadata (they are still freely editable, but they are read by vendors).

## 3. How `aliases` is used

`aliases` is **new to this vocabulary** — none of the sibling taxonomy tables carry it. It is a list
of synonyms the **seeding AI** and the **promote resolver** map onto a closed term. For example,
"Requests for Information" → `rfis`. Aliases let curators and source data use natural phrasing while
the system still resolves to one canonical slug.

Matching is case-insensitive; both the `name` and every `alias` resolve to the same `slug`. Aliases
are **resolver metadata**. The open I8 question here is settled: D1 **does** materialise an
`aliases` column on `taxonomy_data_objects` (`apps/api/src/db/schema.ts`), read by the shared
find-only matcher in `apps/api/src/lib/data-object-vocabulary.ts`.

**Aliases are deliberately not on the wire** (AECI-606). The vendor picker submits a canonical
`slug`, which always resolves, so a client never needs to match; shipping the aliases would invite a
client-side match that has to reimplement `safeSlugify`'s normalisation, and a second matcher is
precisely the drift that matcher was extracted from `promote.ts` to eliminate. They are also raw
curation strings ("ITB", "P6", "AP") rather than translatable copy. Contrast `taxonomy_trades`, where
aliases *are* dual-purpose (`TRADES_VOCABULARY.md` §"Aliases"); the difference is that only this
vocabulary is rendered to vendors as a closed list.

## 4. The frozen vocabulary (20 terms)

`display_order` increments by 10 (room to insert), slugs are kebab-case, names are Title Case with
`&` for combined terms — matching the `taxonomy_*` convention. The "starter 18" from AECI-287 plus
the two confirmed additions (`commitments`, `meetings`).

| display_order | slug | name | description | aliases |
|---:|------|------|-------------|---------|
| 10 | `models` | Models | BIM / 3D models exchanged between authoring and coordination tools. | Model, BIM, BIM Models, 3D Models, IFC, Revit Models, Federated Model, Coordination Model |
| 20 | `drawings` | Drawings | 2D sheets and plans (DWG/PDF) shared across design and field tools. | Drawing, Sheets, 2D Drawings, Plans, Construction Drawings, DWG, CAD |
| 30 | `specifications` | Specifications | Specification sections defining materials, products, and execution standards. | Specification, Specs, Spec, Spec Sections, CSI Specs, Project Manual |
| 40 | `bids-tenders` | Bids & Tenders | Bid / tender packages and procurement solicitations exchanged during buyout. | Bids, Bid, Tenders, Tender, Bid Packages, Tendering, ITB, Invitation to Bid, Procurement |
| 50 | `commitments` | Commitments & Contracts | Executed commitments — subcontracts and purchase orders — that draw down the budget. | Commitment, Contracts, Contract, Subcontracts, Subcontract, Purchase Orders, PO, POs |
| 60 | `budgets` | Budgets | The project budget and its budget line items. | Budget, Project Budget, Budget Line Items, Original Budget |
| 70 | `cost-codes` | Cost Codes | The cost-code / cost-breakdown structure that line items are coded to. | Cost Code, Cost Breakdown Structure, CBS, WBS Codes, Budget Codes |
| 80 | `change-orders` | Change Orders | Change orders and potential change events that adjust scope or cost. | Change Order, CO, PCO, Potential Change Order, Change Events, Change Event |
| 90 | `invoices-payments` | Invoices & Payments | Invoices, pay applications, and payment records. | Invoices, Invoice, Payments, Pay Applications, Pay App, Applications for Payment, Billings, AP |
| 100 | `schedules` | Schedules | Project schedules (CPM / Gantt) and their activities. | Schedule, Project Schedule, Gantt, CPM Schedule, Activities, P6, Programme |
| 110 | `rfis` | RFIs | Requests for Information and their responses. | RFI, Requests for Information, Request for Information, Information Requests |
| 120 | `submittals` | Submittals | Submittal packages (shop drawings, product data, samples) and their review. | Submittal, Submittal Package, Shop Drawings, Product Data, Samples |
| 130 | `meetings` | Meetings & Minutes | Project meetings and their minutes, agendas, and action items. | Meeting, Meeting Minutes, Minutes, Meeting Notes, Meeting Agenda, Agendas |
| 140 | `daily-logs` | Daily Logs | Daily field logs / site diaries (manpower, weather, progress). | Daily Log, Field Logs, Daily Reports, Site Diary, Field Reports |
| 150 | `photos` | Photos | Site and progress photos. | Photo, Site Photos, Progress Photos, Images, Field Photos |
| 160 | `inspections` | Inspections | Quality and field inspections and their results. | Inspection, Quality Inspections, Field Inspections, QA/QC Inspections |
| 170 | `punch-lists` | Punch Lists | Punch / snag lists tracking deficiencies to close out. | Punch List, Punchlist, Snag List, Snags, Deficiency List, Punch Items |
| 180 | `time-labor` | Time & Labor | Timesheets and labor hours. | Timesheets, Timesheet, Labor, Time Tracking, Timecards, Crew Hours, Manpower |
| 190 | `documents` | Documents | General project documents and files under document management. | Document, Files, Project Documents, Document Management, Attachments |
| 200 | `directory-contacts` | Directory & Contacts | The project / company directory of people and companies. | Directory, Contacts, Contact, Company Directory, Project Directory, People, Companies |

## 5. Seeding conventions (for the downstream consumers)

When I8 / AECI-290 materialise this list, mirror the existing taxonomy pattern
(`apps/api/seed/taxonomy.sql`):

- **`id`** — deterministic **UUIDv5 derived from the `slug`**, so ids are stable across re-runs and
  across both apps (the same convention `taxonomy.sql` uses). Ids are therefore **not** stored in
  this file or the JSON mirror — they are derived from the `slug`.
- **Idempotent UPSERT keyed on `slug`** (`ON CONFLICT(slug) DO UPDATE`) — re-seeding updates
  `name` / `description` / `display_order` / `aliases` in place; it never deletes.
- **`display_order`** carried through verbatim (10, 20, … 200).

## 6. Keeping the mirror in sync

[`data-object-vocabulary.json`](./data-object-vocabulary.json) is a **generated mirror** of the
table in §4. It is an object carrying `vocabulary` / `stage` / `closed` metadata plus a `terms`
array — one object per row, in `display_order` order. The markdown table is the human-edited
canonical source; **edit the table, then regenerate the JSON**, never the reverse. A row in §4 ⇔ an
object in `terms`: same `slug`, `name`, `description`, `display_order`, and `aliases`.
