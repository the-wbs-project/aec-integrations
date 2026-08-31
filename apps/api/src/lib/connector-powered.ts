/**
 * "Did neither endpoint vendor build this connection?" — the single definition
 * (AECI-705 / `STAGE_2_ATTESTATIONS_SPEC.md` §14).
 *
 * The §2 attestation spine assumes every edge has two accountable endpoint
 * vendors: `vendor_a` owns `source_product_id`, `vendor_b` owns
 * `target_product_id`. On a **connector-powered** edge that assumption fails —
 * Zapier, Workato or Agave built the plumbing, and the connector has no
 * attestation seat (`STAGE_2_SPEC.md` §8.8(5), which names AECI-705 as the owner
 * of the gap). Prompting an endpoint vendor to confirm or deny such an edge asks
 * about work it did not do, and a denial on true curation is worse than silence.
 *
 * ── WHY THE PREDICATE IS A UNION, AND NOT EITHER HALF ───────────────────────
 * Two columns describe connector delivery and **nothing cross-validates them**:
 * `integrations.mechanism_kind` is a property of the EDGE, `products.product_role`
 * a property of the PRODUCT, and `powered_by_product_id` is the only link between
 * them. Measured against production D1 on **2026-08-31** (946 edges):
 *
 *   | predicate                          | edges | share |
 *   | ---------------------------------- | ----- | ----- |
 *   | `powered_by_product_id IS NOT NULL` |    79 |  8.4% |
 *   | `mechanism_kind = 'iPaaS'`          |   114 | 12.1% |
 *   | both                                |    61 |  6.4% |
 *   | **union — this predicate**          | **132** | **14.0%** |
 *
 * Neither half alone is the set:
 *
 *   - **53 edges are `iPaaS` with a NULL FK** — Zapier (23), Workato, n8n, Make,
 *     Boomi, Trimble AppXchange. The FK is NULL because promote only sends
 *     `poweredByProduct` once the connector is itself a promoted product, and
 *     those are not. AECI-706's sweep puts `backfillable` at **0**: this is
 *     promotion coverage blocked on the `on_hold` connector decision, not a data
 *     defect a script can repair. An FK-only gate would keep prompting on exactly
 *     the edges where "we didn't build it" is most obviously true, indefinitely.
 *   - **18 edges carry the FK but are typed `marketplace-app` (17) or `partner`
 *     (1)**. All 79 FK targets are `product_role` `connector` (77) or `hybrid`
 *     (2), so those are provably connector-powered whatever the edge is typed.
 *
 * The union over-includes roughly ten edges an endpoint vendor genuinely built on
 * an iPaaS (Autodesk's Forma Construction Connect on Workato). That is the
 * accepted direction: over-inclusion costs a vendor an attestation it could have
 * made, under-inclusion breaks the acceptance criterion outright. It is the same
 * fail-safe choice §4.5 made when it resolved a self-contradicting voter to
 * `unverified` rather than guessing.
 *
 * ── WHAT AECI-721 CHANGES, AND WHAT IT DOES NOT ─────────────────────────────
 * `integrator` joins `iPaaS` in the kind disjunct (see `CONNECTOR_MECHANISM_KINDS`).
 * The table above is UNCHANGED by that: zero rows carry `integrator` today, because
 * the app-DB CHECK still refuses it — which is exactly why the enum addition and
 * this line ship together.
 *
 * The FK disjunct also shrinks in meaning once AECI-721's migration runs: 19 of the
 * 79 FK-carrying prod edges LEAVE `integrations` for `connector_evidenced_pairs`,
 * so they stop reaching this predicate at all — an evidenced pair is structurally
 * connector-delivered and has no attestation seat to gate. The 60 that remain are
 * Convention-A self-references (Aquifer 31, Kroo 29), which keep their `powered_by`
 * and keep matching here.
 *
 * ── WHY THERE IS NO SQL FORM OF THIS ────────────────────────────────────────
 * Deliberately a pure predicate with **no Drizzle `SQL` fragment**: every caller
 * (the three §5 write handlers via `AttestationAuthority`, the §5 list handler,
 * the §7 detector sweep) already has the integration row in memory, so nothing
 * needs to filter *on* it in SQL. Two forms of one rule is how the direction
 * helpers drifted once already (`STAGE_1_5_SPEC.md` §7.1), and a SQL form would
 * invite someone to fold this into `ownedEndpointJoin` — which is the scoping
 * predicate the AECI-627 freshness cursor must match exactly
 * (`STAGE_2_REALTIME_SPEC.md` §2.2). Ownership and attestability are separate
 * questions and stay separate.
 */

/**
 * The `mechanism_kind` values that mean a third party delivers the connection.
 *
 * `iPaaS` — a connector platform generates it. `integrator` (AECI-698, which
 * replaces `partner`) — an SI or consultancy built and maintains it, and the
 * rubric's test is verbatim *"neither vendor did"*, which is this predicate's
 * question word for word. It is listed here in the SAME change that adds it to
 * the enums (AECI-721 PR-A) rather than later: an `integrator` edge carries no
 * `powered_by` by definition, so without this it would fall through both
 * disjuncts, and the ~117 rows waiting on the upstream re-key would start
 * prompting endpoint vendors to attest to work an SI did. Zero rows carry it
 * today, so the change is inert now and correct at re-key time.
 *
 * Deliberately NOT here: `partner`. It is the dumping ground AECI-698 exists to
 * empty (a sample of six held an app-center listing, a support tutorial and a
 * directory page), so treating it as third-party delivery would suppress
 * attestation on edges an endpoint vendor really did build. The rows become
 * `integrator` — or `native`, or `marketplace-app` — one at a time, upstream,
 * under the rubric.
 */
const CONNECTOR_MECHANISM_KINDS: readonly string[] = ['iPaaS', 'integrator'];

/**
 * Whether neither endpoint vendor built this edge's plumbing, and so neither may
 * be asked to attest to it.
 *
 * Takes the two raw columns rather than a row type so every grain can call it —
 * `AttestationAuthority`, a `db.query` result, a detector claim's hydrated
 * integration. `mechanism_kind` is nullable in the schema (the CHECK constrains
 * only non-null values), and a NULL kind is not connector delivery.
 */
export function isConnectorPoweredEdge(edge: {
  poweredByProductId: string | null;
  mechanismKind: string | null;
}): boolean {
  return (
    edge.poweredByProductId !== null ||
    (edge.mechanismKind !== null && CONNECTOR_MECHANISM_KINDS.includes(edge.mechanismKind))
  );
}
