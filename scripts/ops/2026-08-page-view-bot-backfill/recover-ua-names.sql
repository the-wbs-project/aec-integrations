-- AECI-582 — recover TRUE crawler names for historical page_views rows, by User-Agent hash.
--
-- Runs BEFORE ../backfill-page-view-bots.sql (the ASN rule). Both are gated on
-- `is_bot IS NULL`, so whichever runs first claims the row — and a name the crawler
-- gave us beats a datacenter label inferred from its hosting provider.
--
-- WHY THIS IS SOUND. The raw User-Agent is discarded at capture, but its SHA-256 hash
-- persists, and the same UA always hashes the same. `classifyTraffic()` tests the UA
-- BEFORE the ASN (apps/api/src/lib/bot-classification.ts), so any row the live
-- classifier labelled with a NAMED_BOTS name or 'Other bot' was decided by the UA
-- alone. That verdict is a property of the UA string, not of the network the request
-- came from, so it transfers to every older row sharing the hash — whatever its ASN.
--
-- The hash→name map below was READ OFF PRODUCTION on 2026-08-13: every UA hash that
-- the live classifier has since named, that also appears on unclassified rows. UA
-- hashes are environment-independent (same crawler, same UA, same hash), so the same
-- map is correct on every tier; on a tier that never saw a given crawler it simply
-- matches nothing.
--
-- 'Censys (scanner)' is deliberately ABSENT from the map: it is the one label that is
-- both a NAMED_BOTS name and a DATACENTER_ASNS label, so a row carrying it cannot be
-- proven UA-derived. Censys ASNs (398324 / 398722) are in the ASN rule, which catches
-- those rows in the next statement anyway.
--
-- Idempotent: only touches rows where is_bot IS NULL.
--
-- Rows recovered on production, 2026-08-13 (4941 total):
--    2519  Bingbot      a8f0ea17e4b67ac3…
--     885  Applebot     dca56b5d5fcb14f9…
--     660  Other bot    9d7770ec49691cca…
--     167  Other bot    8f42af6f304383bb…
--     155  OpenAI       469674db40cfb8e9…
--     132  Other bot    774749795d93ebf7…
--     120  OpenAI       623fb17e8d51ba00…
--      57  Googlebot    043937ea8abaea32…
--      55  Googlebot    40024f4d859edeb5…
--      46  MJ12bot      15e76e83175a7bca…
--      29  DuckDuckBot  4c56cd2527b36674…
--      27  Bingbot      15dea2bf0fe347c6…
--      20  Other bot    12bd583dd25b868e…
--      19  Other bot    d028d97d630b7904…
--      13  Other bot    1f1b3ca2fffd75a5…
--      11  Googlebot    3a477e8837166157…
--      10  Other bot    8828b706bdd52f2a…
--       6  Other bot    b7aaba617f69e5ae…
--       3  DuckDuckBot  4f565703c89bd1da…
--       3  Other bot    b3a600ce36c9757e…
--       2  Other bot    37f8b8b52d72d4d7…
--       1  Meta         51a44dcb93aff9dd…
--       1  Other bot    b4e4223b54ca18fb…

UPDATE page_views
SET is_bot = 1,
    bot_name = CASE user_agent_hash
      WHEN 'a8f0ea17e4b67ac36953bcefe8a780c06327a13cfa0e0a247ed332fa6ee7ef0d' THEN 'Bingbot'
      WHEN 'dca56b5d5fcb14f964a009d42e7eca1b4a1576a59d430ab42b57f2a704f9b975' THEN 'Applebot'
      WHEN '9d7770ec49691ccad0bd6f39c2149987b49604da2015725f267a6867488f0fc3' THEN 'Other bot'
      WHEN '8f42af6f304383bbe22bc11b9f1c9ce77bb37478b15b0b0d93224e249f36e68e' THEN 'Other bot'
      WHEN '469674db40cfb8e9362f6a8a066e601aa7ca2b253f373cdf5c3eafb8a4eccf62' THEN 'OpenAI'
      WHEN '774749795d93ebf7f3f610640506c301c5049a115e02e85c926158979953b32b' THEN 'Other bot'
      WHEN '623fb17e8d51ba005123242aeaff81ade124731715a8e397e85f5deb5b1e0835' THEN 'OpenAI'
      WHEN '043937ea8abaea325dbde1020b1bdd9f921dcbae7450dc9141c47a7d3473c917' THEN 'Googlebot'
      WHEN '40024f4d859edeb50bdb02b5d883a957c5aaf55129b91284251f0ff097693d56' THEN 'Googlebot'
      WHEN '15e76e83175a7bcac800a0a8ecf7a5018899d204d6b1ae8392f48d5f2667c56f' THEN 'MJ12bot'
      WHEN '4c56cd2527b36674977c96d813a1a807becf087ef322e6b222a760c3b0414aae' THEN 'DuckDuckBot'
      WHEN '15dea2bf0fe347c64cfabdfd2ae290cf2a6ff693906ad03385adb5aa33fcd0cd' THEN 'Bingbot'
      WHEN '12bd583dd25b868e6423d8f04cc19fd17185f7ab56cb79750e1f58d4541632e2' THEN 'Other bot'
      WHEN 'd028d97d630b7904fd8608dcbed3cd1b3914d94fd2bd4ab1bb687b0c8dfac7f1' THEN 'Other bot'
      WHEN '1f1b3ca2fffd75a5b8a5f5b294ee07198f8e5e1e2c83ff331b24eccb8899b954' THEN 'Other bot'
      WHEN '3a477e8837166157ca63150476f5a18ab665b2f1ec531a6a7f4b1ac59552e435' THEN 'Googlebot'
      WHEN '8828b706bdd52f2a93e84929e06411ae8287f20c3de6fc1270d71ce68e635173' THEN 'Other bot'
      WHEN 'b7aaba617f69e5aebda720590e2db17bc716b5a4ed65e5594e209fa7a22c5fa7' THEN 'Other bot'
      WHEN '4f565703c89bd1da1c1b46179a462332d78ec083ce4b755439031417170d273d' THEN 'DuckDuckBot'
      WHEN 'b3a600ce36c9757eef4f9a1ccd4950390a9e353e4e417edc679aff90ea286e34' THEN 'Other bot'
      WHEN '37f8b8b52d72d4d78d629ac2b84ba3e8e6988f1043f97bc27903dc8985df246c' THEN 'Other bot'
      WHEN '51a44dcb93aff9ddfcb0188bc28ffe3b853a62712f28d4d157f9857aaea67bd0' THEN 'Meta'
      WHEN 'b4e4223b54ca18fbc7c008c78cda7a7dc11796fafdfd55bfff7de4031afac93f' THEN 'Other bot'
    END
WHERE is_bot IS NULL
  AND user_agent_hash IN (
    'a8f0ea17e4b67ac36953bcefe8a780c06327a13cfa0e0a247ed332fa6ee7ef0d',
    'dca56b5d5fcb14f964a009d42e7eca1b4a1576a59d430ab42b57f2a704f9b975',
    '9d7770ec49691ccad0bd6f39c2149987b49604da2015725f267a6867488f0fc3',
    '8f42af6f304383bbe22bc11b9f1c9ce77bb37478b15b0b0d93224e249f36e68e',
    '469674db40cfb8e9362f6a8a066e601aa7ca2b253f373cdf5c3eafb8a4eccf62',
    '774749795d93ebf7f3f610640506c301c5049a115e02e85c926158979953b32b',
    '623fb17e8d51ba005123242aeaff81ade124731715a8e397e85f5deb5b1e0835',
    '043937ea8abaea325dbde1020b1bdd9f921dcbae7450dc9141c47a7d3473c917',
    '40024f4d859edeb50bdb02b5d883a957c5aaf55129b91284251f0ff097693d56',
    '15e76e83175a7bcac800a0a8ecf7a5018899d204d6b1ae8392f48d5f2667c56f',
    '4c56cd2527b36674977c96d813a1a807becf087ef322e6b222a760c3b0414aae',
    '15dea2bf0fe347c64cfabdfd2ae290cf2a6ff693906ad03385adb5aa33fcd0cd',
    '12bd583dd25b868e6423d8f04cc19fd17185f7ab56cb79750e1f58d4541632e2',
    'd028d97d630b7904fd8608dcbed3cd1b3914d94fd2bd4ab1bb687b0c8dfac7f1',
    '1f1b3ca2fffd75a5b8a5f5b294ee07198f8e5e1e2c83ff331b24eccb8899b954',
    '3a477e8837166157ca63150476f5a18ab665b2f1ec531a6a7f4b1ac59552e435',
    '8828b706bdd52f2a93e84929e06411ae8287f20c3de6fc1270d71ce68e635173',
    'b7aaba617f69e5aebda720590e2db17bc716b5a4ed65e5594e209fa7a22c5fa7',
    '4f565703c89bd1da1c1b46179a462332d78ec083ce4b755439031417170d273d',
    'b3a600ce36c9757eef4f9a1ccd4950390a9e353e4e417edc679aff90ea286e34',
    '37f8b8b52d72d4d78d629ac2b84ba3e8e6988f1043f97bc27903dc8985df246c',
    '51a44dcb93aff9ddfcb0188bc28ffe3b853a62712f28d4d157f9857aaea67bd0',
    'b4e4223b54ca18fbc7c008c78cda7a7dc11796fafdfd55bfff7de4031afac93f'
  );

-- One crawler, no recoverable name. A single UA hash served 440 views across 16 paths
-- in ONE day (2026-07-06) from two different China Mobile ASNs (9808 + 56045). One
-- client, one burst, two consumer networks, never seen again — a crawl, not 440 people.
--
-- It is recorded here as its own statement, keyed on the UA hash, because the
-- alternative considered (adding AS9808/AS56045 to DATACENTER_ASNS) would have taught
-- the LIVE classifier that China Mobile's consumer network is a datacenter and thrown
-- away real humans from every future digest. This targets the one client instead.
-- It is the only judgement call in this file: drop this statement and 440 rows stay
-- human. See docs/POST_LAUNCH_HEALTH_REPORT.md, 2026-08-13 entry.
UPDATE page_views
SET is_bot = 1, bot_name = 'Other bot'
WHERE is_bot IS NULL
  AND user_agent_hash = 'b2975c76be9610b929c9adbe7634f38bec65b72db10ecfda546b75dc89e50fef';
