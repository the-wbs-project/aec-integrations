-- AECI-929 / ADMIN_PANEL_SPEC.md §7.3 + §13 D25: attribute pre-0067 integration
-- pair-page views to both endpoint products.
--
-- Parses page_views.concrete_path the way ingest's parsePairPagePath does
-- (^/products/<a>/integrations/<b>$, no further segment, a <> b), resolves each slug
-- against products.slug, and stores the two ids lower-first. min()/max() on text
-- compare BINARY, which is the same order canonicalPairIds uses (`<`). When only one
-- slug resolves its id goes in side A and side B stays NULL, as at ingest. When
-- neither resolves the row is left untouched.
--
-- Idempotent: only rows with BOTH pair columns NULL are candidates, so a re-run
-- changes nothing it already set. It never touches product_id or any other column.
-- No audit row: page_views is log-class (CLAUDE.md "Audit logging").
--
-- The WITH block is byte-identical to projection.sql's, which the spec asserts, so
-- the dry-run numbers describe exactly the rows this statement writes.
-- substr(concrete_path, 11) starts after '/products/'; 14 = length('/integrations/').
WITH split AS (
  SELECT id,
         substr(concrete_path, 11) AS rest,
         instr(substr(concrete_path, 11), '/integrations/') AS k
    FROM page_views
   WHERE pair_product_a_id IS NULL
     AND pair_product_b_id IS NULL
     AND concrete_path GLOB '/products/*/integrations/*'
),
parsed AS (
  SELECT id, substr(rest, 1, k - 1) AS a_slug, substr(rest, k + 14) AS b_slug
    FROM split
   WHERE k > 1
),
candidates AS (
  SELECT id, a_slug, b_slug
    FROM parsed
   WHERE instr(a_slug, '/') = 0
     AND b_slug <> ''
     AND instr(b_slug, '/') = 0
     AND a_slug <> b_slug
),
resolved AS (
  SELECT c.id,
         min(p.id) AS lo,
         CASE WHEN count(p.id) = 2 THEN max(p.id) END AS hi
    FROM candidates c
    LEFT JOIN products p ON p.slug IN (c.a_slug, c.b_slug)
   GROUP BY c.id
)
UPDATE page_views
   SET pair_product_a_id = (SELECT r.lo FROM resolved r WHERE r.id = page_views.id),
       pair_product_b_id = (SELECT r.hi FROM resolved r WHERE r.id = page_views.id)
 WHERE id IN (SELECT id FROM resolved WHERE lo IS NOT NULL);
