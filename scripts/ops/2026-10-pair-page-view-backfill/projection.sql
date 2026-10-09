-- AECI-929: the dry-run projection for backfill.sql. Same WITH block, byte for byte.
-- One row: how many candidate pair-page rows there are, how many would resolve on
-- both sides, on one side, or not at all, and the created_at window they span.
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
SELECT count(*) AS candidates,
       coalesce(sum(CASE WHEN r.hi IS NOT NULL THEN 1 ELSE 0 END), 0) AS resolved_both,
       coalesce(sum(CASE WHEN r.lo IS NOT NULL AND r.hi IS NULL THEN 1 ELSE 0 END), 0) AS resolved_one,
       coalesce(sum(CASE WHEN r.lo IS NULL THEN 1 ELSE 0 END), 0) AS unresolved,
       min(v.created_at) AS first_created_at,
       max(v.created_at) AS last_created_at
  FROM resolved r
  JOIN page_views v ON v.id = r.id;
