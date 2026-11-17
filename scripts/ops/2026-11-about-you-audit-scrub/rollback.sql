-- AECI-1869: there is no rollback SQL, by design.
-- apply.sql deletes personal values the Privacy Policy says are gone. Nothing in the
-- database holds a copy to restore from. The only way back is the D1 Time Travel
-- bookmark taken in README step 1, and only to recover from a broken scrub. Run
-- apply.sql again straight after any restore.
SELECT 'no rollback: see README' AS note;
