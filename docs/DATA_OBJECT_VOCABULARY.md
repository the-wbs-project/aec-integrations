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
  seeded rows to the vendor portal's `data_object` picker
  (`STAGE_2_ATTESTATIONS_SPEC.md` §6). It carries `slug` / `name` / `description` only — see §3 for
  why `aliases` stays server-side. The endpoint serves `display_order`; **the picker itself renders
  the terms alphabetically** — see §4.1.

## 1. What a `data_object` is

A `data_object` is the **noun that flows between two integrated AEC products** — the *what* of an
integration. When Product A syncs with Product B, it is some `data_object` (RFIs, Budgets, Models…)
that moves. In the Stage 1.5 model a claim's identity is the triple **`integration` + `data_object`
+ `direction`**, so this vocabulary is load-bearing: claim identity, the sync headline, and the
Stage 2 attestation detectors all key off these terms.

> **Correction (AECI-608, 2026-08-18).** This sentence used to name "(later) cross-grain detection"
> as the third consumer. That detector was **dropped at build** (AECI-302 —
> `STAGE_2_ATTESTATIONS_SPEC.md` §7.1 / §11) and no longer belongs in a list of things this
> vocabulary feeds. It was never defined anywhere in this repo, and the only definition proposed —
> contradictory directions for one `data_object` across different mechanism rows on the same
> product pair — describes legitimate data rather than a fault, since two mechanisms genuinely can
> move the same object in opposite directions. Reviving it needs a definition with a
> false-positive floor, not just a query.

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

### 2.1 Expansion, 2026-09-06 — 20 terms → 27 (AECI-793)

Seven terms were added: `projects`, `prime-contracts`, `job-costs`, `general-ledger`, `equipment`,
`employees`, `compliance-documents`. This was the §2 vocabulary-change PR, not an exception to it —
the list stays closed and find-only.

They were derived from **both** of Agave's published surfaces, crawled off its sitemap and combined:
`useagave.com/integrations/<system>` (21 pages, unified-API objects per system) and
`useagave.com/sync/<pm>-<erp>` (19 pages, per-pair direction matrices). Combining is load-bearing —
either surface read alone gets two terms wrong. `/sync/` understates general ledger and vendor
compliance; `/integrations/` understates prime contracts; `employees` and `equipment` only clear the
bar once both are counted.

Three boundaries the descriptions encode, because they are the ones a curator will otherwise blur:
`prime-contracts` is owner-side **revenue**, distinct from cost-side `commitments`; `job-costs` is
the actual cost **transaction**, distinct from the `invoices-payments` that document it; and
`employees` is the payroll master record, distinct from the `directory-contacts` project directory.

Alias collisions were checked against all 20 pre-existing terms and their aliases under the same
`safeSlugify` normalisation both resolvers apply: **zero collisions**. The full working — including
the candidates deliberately **not** added and why — is `docs/data-object-vocabulary-expansion.md` in
the **`aec-integrations-review`** repo (commit `58bf69d`). The five Stage 1.5 held-out terms listed
above were not revisited here and remain held out.

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

## 4. The frozen vocabulary (27 terms)

`display_order` runs in tens, slugs are kebab-case, names are Title Case with `&` for combined
terms — matching the `taxonomy_*` convention. The "starter 18" from AECI-287, plus the two
confirmed additions (`commitments`, `meetings`), plus the **seven added 2026-09-06** (see §2.1).

Those seven took the **gaps** — 5, 55, 85, 95, 185, 205, 210 — which is exactly what "room to
insert" was reserved for. **Nothing existing was renumbered**, and nothing existing may be: a term's
`display_order` is presentation metadata, but shifting one silently reorders every claim lane on
every product-PAIR page. Insert into a gap or open a new one at the end.

| display_order | slug | name | description | aliases |
|---:|------|------|-------------|---------|
| 5 | `projects` | Projects & Jobs | The project / job master record that every cost and field artifact is coded to. | Project, Job, Jobs, Sub Jobs, Subjobs, Job Setup, Project Setup, Project Master, Job Master, JC Jobs |
| 10 | `models` | Models | BIM / 3D models exchanged between authoring and coordination tools. | Model, BIM, BIM Models, 3D Models, IFC, Revit Models, Federated Model, Coordination Model |
| 20 | `drawings` | Drawings | 2D sheets and plans (DWG/PDF) shared across design and field tools. | Drawing, Sheets, 2D Drawings, Plans, Construction Drawings, DWG, CAD |
| 30 | `specifications` | Specifications | Specification sections defining materials, products, and execution standards. | Specification, Specs, Spec, Spec Sections, CSI Specs, Project Manual |
| 40 | `bids-tenders` | Bids & Tenders | Bid / tender packages and procurement solicitations exchanged during buyout. | Bids, Bid, Tenders, Tender, Bid Packages, Tendering, ITB, Invitation to Bid, Procurement |
| 50 | `commitments` | Commitments & Contracts | Executed commitments — subcontracts and purchase orders — that draw down the budget. | Commitment, Contracts, Contract, Subcontracts, Subcontract, Purchase Orders, PO, POs |
| 55 | `prime-contracts` | Prime Contracts | Owner-side (revenue) contracts and their value, as distinct from cost-side commitments. | Prime Contract, Main Contract, Main Contracts, Owner Contract, Owner Contracts, Head Contract, Client Contract, Revenue Contract, Revenue Budget, Job Contracts |
| 60 | `budgets` | Budgets | The project budget and its budget line items. | Budget, Project Budget, Budget Line Items, Original Budget |
| 70 | `cost-codes` | Cost Codes | The cost-code / cost-breakdown structure that line items are coded to. | Cost Code, Cost Breakdown Structure, CBS, WBS Codes, Budget Codes |
| 80 | `change-orders` | Change Orders | Change orders and potential change events that adjust scope or cost. | Change Order, CO, PCO, Potential Change Order, Change Events, Change Event |
| 85 | `job-costs` | Job Costs | Actual cost transactions posted against a budget line, separate from the invoices that document them. | Job Cost, Job Costing, Actual Costs, Direct Costs, Expenses, Expense, Cost Transactions, Job Cost Detail, Job Cost Transactions, Item Receipts, Project Transactions |
| 90 | `invoices-payments` | Invoices & Payments | Invoices, pay applications, and payment records. | Invoices, Invoice, Payments, Pay Applications, Pay App, Applications for Payment, Billings, AP |
| 95 | `general-ledger` | General Ledger | Ledger accounts, journals, journal entries, and bank accounts behind the job cost ledger. | GL, Ledger, Ledger Accounts, Chart of Accounts, COA, Journal Entries, Journals, General Journal, Bank Accounts, Cost Centers |
| 100 | `schedules` | Schedules | Project schedules (CPM / Gantt) and their activities. | Schedule, Project Schedule, Gantt, CPM Schedule, Activities, P6, Programme |
| 110 | `rfis` | RFIs | Requests for Information and their responses. | RFI, Requests for Information, Request for Information, Information Requests |
| 120 | `submittals` | Submittals | Submittal packages (shop drawings, product data, samples) and their review. | Submittal, Submittal Package, Shop Drawings, Product Data, Samples |
| 130 | `meetings` | Meetings & Minutes | Project meetings and their minutes, agendas, and action items. | Meeting, Meeting Minutes, Minutes, Meeting Notes, Meeting Agenda, Agendas |
| 140 | `daily-logs` | Daily Logs | Daily field logs / site diaries (manpower, weather, progress). | Daily Log, Field Logs, Daily Reports, Site Diary, Field Reports |
| 150 | `photos` | Photos | Site and progress photos. | Photo, Site Photos, Progress Photos, Images, Field Photos |
| 160 | `inspections` | Inspections | Quality and field inspections and their results. | Inspection, Quality Inspections, Field Inspections, QA/QC Inspections |
| 170 | `punch-lists` | Punch Lists | Punch / snag lists tracking deficiencies to close out. | Punch List, Punchlist, Snag List, Snags, Deficiency List, Punch Items |
| 180 | `time-labor` | Time & Labor | Timesheets and labor hours. | Timesheets, Timesheet, Labor, Time Tracking, Timecards, Crew Hours, Manpower |
| 185 | `equipment` | Equipment & Assets | Owned and rented equipment, plant, and tracked assets. | Equipments, Assets, Asset, Fleet, Plant, Machinery, Equipment Tracking, Asset Tracking, EM Equipment |
| 190 | `documents` | Documents | General project documents and files under document management. | Document, Files, Project Documents, Document Management, Attachments |
| 200 | `directory-contacts` | Directory & Contacts | The project / company directory of people and companies. | Directory, Contacts, Contact, Company Directory, Project Directory, People, Companies |
| 205 | `employees` | Employees & Payroll | Employee master records and payroll data, as distinct from the project contact directory. | Employee, Payroll, Employee Records, Personnel, Workers, Crew, Human Resources, HR, Payroll Records, PR Employees |
| 210 | `compliance-documents` | Compliance Documents | Insurance certificates, lien waivers, W-9s, and other vendor compliance documents tracked against a contract. | Compliance, Vendor Compliance, Vendor Compliances, Insurance Certificates, Certificates of Insurance, COI, Lien Waivers, W-9, Subcontractor Compliance, Compliance Codes |

### 4.1 `display_order` is a *reading* order — the picker sorts alphabetically

`display_order` is the **project-lifecycle sequence** (design documents → procurement → cost →
schedule → field → records), not an arbitrary index. That order is what the `data_object` **claim
lanes** render in, on both the public product-PAIR page and the vendor portal's Integrations tab
(`apps/api/src/routes/vendor-attestations.ts`), and it is the order
`GET /api/vendor/data-objects` serves — see `listDataObjectTerms` in
`apps/api/src/lib/data-object-vocabulary.ts`, whose NULLs-last clause exists to keep the two
identical.

**The "Add a data flow" picker deliberately diverges and renders the terms alphabetically by
`name`** (`dataObjectOptions` in
`apps/web/src/app/vendor/components/vendor-add-claim-form.ts`). The two lists do different jobs:

- A **lane list is read.** The lifecycle grouping is the information — it says what kind of
  integration this is.
- A **picker is searched.** The vendor arrives already knowing they want "Submittals", and
  `AecSelect` is a non-editable Aria combobox with no type-to-filter, so an unfamiliar semantic
  order turns finding a known label into a 27-item linear scan with no anchor.

Two properties of that divergence matter to anyone editing it. It is **client-side only** — the wire
order is unchanged and still pinned by `apps/api/src/routes/vendor-data-objects.spec.ts`, so a
future consumer that renders these rows *as lanes* still gets lifecycle order for free. And the sort
key is the **rendered `name`** through `localeCompare`, not the slug and not a SQL `ORDER BY`,
because the terms are translatable copy (§2) and alphabetical order is per-locale.

## 5. Seeding conventions (for the downstream consumers)

When I8 / AECI-290 materialise this list, mirror the existing taxonomy pattern
(`apps/api/seed/taxonomy.sql`):

- **`id`** — deterministic **UUIDv5 derived from the `slug`**, so ids are stable across re-runs and
  across both apps (the same convention `taxonomy.sql` uses). Ids are therefore **not** stored in
  this file or the JSON mirror — they are derived from the `slug`.
- **Idempotent UPSERT keyed on `slug`** (`ON CONFLICT(slug) DO UPDATE`) — re-seeding updates
  `name` / `description` / `display_order` / `aliases` in place; it never deletes.
- **`display_order`** carried through verbatim (5, 10, 20, … 205, 210) — including the
  in-gap values, which are meaningful, not placeholders.

## 6. Keeping the mirror in sync

[`data-object-vocabulary.json`](./data-object-vocabulary.json) is a **generated mirror** of the
table in §4. It is an object carrying `vocabulary` / `stage` / `closed` metadata plus a `terms`
array — one object per row, in `display_order` order. The markdown table is the human-edited
canonical source; **edit the table, then regenerate the JSON**, never the reverse. A row in §4 ⇔ an
object in `terms`: same `slug`, `name`, `description`, `display_order`, and `aliases`.
