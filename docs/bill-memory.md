# AEC Integrations — Project Primer

Drop this file into your Claude project (as a Project Knowledge file, or paste
into Claude Code as `CLAUDE.md`). It tells the AI what this business is, what
data it works with, and what kind of work you'll be asking it to do.

---

## 1. What AEC Integrations is

**AEC Integrations** is a directory + research product for the
Architecture / Engineering / Construction software market. It catalogs:

- **Vendors** — the companies that make AEC software (Autodesk, Procore,
  Bentley, Trimble, plus hundreds of smaller players).
- **Products** — the individual software products those vendors sell
  (Revit, AutoCAD, Procore Project Management, etc.).
- **Integrations** — how those products connect to each other (e.g. Revit
  → Navisworks, Procore → Sage 300, Bluebeam → SharePoint). Each
  integration records *what mechanism* connects them: native, iPaaS
  (Zapier / Make / Workato), marketplace app, public API, webhook, or
  partner-built.

The end goal is the public site at **aecintegrations.com** — a place where
an AEC firm evaluating software can answer "does Tool X talk to Tool Y, and
how well?" without spending two days on Google.

The database that powers it is in **Airtable**. The review/research tooling
sits on top of that Airtable base.

---

## 2. The two roles a co-founder might play

There are two distinct ways a non-engineer contributes to this project:

1. **Research and curation** — the bulk of the work. Adding new vendors and
   products, reviewing what the AI enrichment came back with, fixing up
   bad data, categorizing things into the right disciplines and project
   phases, and deciding which products are "ready to promote" to the
   public site.

2. **Marketing / SEO / content** — the landing site, blog posts, SEO
   pages, outreach copy. This is a different repo (`landing/`) and not
   what this primer covers.

This file is focused on **#1 — research and curation**.

---

## 3. The AECi Review MCP server (your main tool)

There is an MCP server already deployed at:

```
https://review.aecintegrations.com/mcp
```

Connect to it from Claude Desktop, claude.ai web (Connectors), or Claude
Code. Configuration for Claude Desktop / mcp-inspector:

```json
{
  "mcpServers": {
    "aeci-review": {
      "url": "https://review.aecintegrations.com/mcp",
      "transport": "streamable-http"
    }
  }
}
```

No auth right now — treat the URL as semi-private; don't paste it into
public places.

The server name is `aeci-review-mcp`. It exposes tools for reading and
writing the three core entities (vendors, products, integrations) plus a
read-only `list_taxonomy` tool for the closed vocabularies (categories,
disciplines, project phases).

**The single most important rule:** there is **no dedupe** at the create
layer. Before creating any new vendor or product, the AI must call the
matching `list_*` tool with a search query and confirm the record does not
already exist.

The full tool spec lives at `docs/mcp-server.md` in the main repo. If you
need to do anything beyond the standard playbooks below, ask Claude to
consult that file first.

---

## 4. Standard work the AI will do for you

### A. Research pending products

The most common task. Products that have been added to Airtable but not yet
researched have `research_status = "Pending"`. The AI's job is to:

1. Pull the list of pending products via `list_products({ research_status: "Pending" })`.
2. For each one, use built-in web search + web fetch to find:
   - A clean 1–3 sentence description.
   - The vendor (link to existing vendor record, or flag if missing).
   - Categories, disciplines, and supported project phases — chosen
     **only** from the closed vocabularies returned by `list_taxonomy`.
   - The product website and (if it exists) an integrations / API docs URL.
3. Write results back via `update_product` and flip `research_status` to `"Done"`.

There is a canonical playbook for this at
`playbooks/research-pending-products.md` in the main repo, and an MCP
prompt named `research_pending_products` that loads it. In Claude Code the
shortcut is the slash command `/researchproducts <scope>`.

Tell Claude something like:

> Research the first 15 pending products using the
> `research_pending_products` playbook.

### B. Add a brand-new vendor or product

When you hand the AI a name it has never seen:

1. **Always** call `list_vendors` / `list_products` with a search first.
2. If genuinely new, call `create_vendor_and_research` or
   `create_product_and_research`. This creates the Airtable row and
   automatically kicks off the enrichment workflow in the background.
3. Wait a few minutes, then `get_vendor` / `get_product` to see what came back.

### C. Fix or enrich an existing record

`update_vendor` / `update_product` / `update_integration` patch fields on
existing records. Linked fields (category, disciplines, vendors) take
arrays of Airtable record IDs — never names. Call `list_taxonomy` once at
the start of a session to build a name → ID map.

### D. Manually link two products as integrating

`create_integration` with the two product record IDs and a `listing_url`
where the evidence was observed. Most integrations are discovered
automatically, so use this only when you have direct, ironclad evidence
the automated discovery missed.

---

## 5. Closed vocabularies (do not invent)

Three fields on a product are linked to closed taxonomy lists:

- `category` — what kind of software it is (BIM Authoring, Project
  Management, Estimating, etc.).
- `supported_disciplines` — which AEC disciplines use it (Architecture,
  Structural, MEP, Civil, Construction Management, etc.).
- `supported_project_phases` — which project phases it supports
  (Schematic Design, Construction Documents, Bidding, Construction, etc.).

Always pick from the lists returned by `list_taxonomy`. If nothing fits,
leave the array empty — **except** that `category` should contain at least
one entry; pick the closest match.

If you genuinely think a new category / discipline / phase is missing,
tell Chris — adding to the vocabulary is a deliberate decision, not
something the AI should do unilaterally.

---

## 6. Conventions worth knowing

- **All identifiers are Airtable record IDs** (start with `rec…`). Never
  pass a user-facing name where an ID is expected.
- **Field names are snake_case** matching the Airtable schema
  (`company_name`, `research_status`, `mechanism_kind`).
- **Names**: send the brand name as it appears on the vendor's site
  (`Procore`, not `Procore Technologies, Inc.`). Drop legal suffixes.
- **Websites**: send the apex marketing site (`https://acme.com`), not a
  deep link, docs subdomain, or LinkedIn URL. A wrong URL poisons every
  enrichment leaf downstream.
- **`promotion_status`** controls whether a product appears on the public
  site. The values are `pending` → `ready` → `promoted`, with
  `retracted` / `rejected` as exits. Most curation work is moving things
  from `pending` to `ready`.

---

## 7. When to stop and ask

The AI should stop and ask you (or Chris) when:

- A product seems to need a new category / discipline / phase that isn't in
  the taxonomy.
- A vendor seems to overlap with an existing record but the names are
  different (e.g. a renamed company, a parent / subsidiary).
- The web research turns up contradictory facts (different "founded year",
  different HQ, different ownership).
- A `create_*_and_research` call fails repeatedly, or an enrichment run
  comes back mostly empty.

It should **not** stop and ask for routine batch research — once you've
agreed on the scope, let it run.

---

## 8. Where the source of truth lives

- **Database**: Airtable base "AECi Review".
- **Tool spec**: `docs/mcp-server.md` in the `aec-integrations-landing` repo.
- **Research playbook**: `playbooks/research-pending-products.md` in the
  same repo.
- **Public site**: aecintegrations.com (driven by the `promoted` rows).
- **Review UI**: review.aecintegrations.com (where Chris and Bill see the
  records, run workflows by hand, and approve / reject products).

If something in this primer conflicts with `docs/mcp-server.md`, the
`mcp-server.md` is newer and wins — ping Chris to update this primer.
