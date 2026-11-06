# Field caption backfill (AECI-1614)

Fills the edit stamps and plan-end mirrors that public field captions read, for records
written before migration 0104. Live writers keep them true from then on.

**Not run on staging or production in AECI-1614.** Each tier waits for Chris's go-ahead.
Until it runs, a record with an older vendor write shows no caption, which is the safe
direction, and `plan_end_mirror_drift` lists the vendors and products still to fill.

The dry run below reads the local D1 and writes nothing.

```bash
node scripts/ops/2026-11-field-caption-backfill/run.mjs --env local
```

This command writes production, and needs the go-ahead first.

```bash
node scripts/ops/2026-11-field-caption-backfill/run.mjs --env production --apply --allow-production
```

Run it after the API Worker that writes the columns is live. It only fills a NULL, so
running later costs nothing and a re-run writes nothing new.

## What it reads

| Column | Source |
|---|---|
| `products.description_edited_at` | Latest vendor-portal `product.updated` or `product.created` row whose audit diff moved `description`, since the last return to AECi |
| `products.profile_edited_at` | The same for `website` and categories |
| `products.usefulness_edited_at` | The same for `usefulness`. The cut-off applies only while `usefulness_source` is NULL, because a set source is one-way |
| `products.managed_edited_at` | The same for the two doc URLs, trades, audiences and phases, since the last return |
| `integrations.vendor_edited_at`, `connector_evidenced_pairs.vendor_edited_at` | Latest write by the row's current holder since it last changed hands: owner edit, owner contest accept, create, or a public per-side link |
| `vendors.plan_ended_at` | Latest `licenses.ended_at`, where no license is live |
| `products.managed_ended_at` | The later of the latest ended license naming the product and an early unassign in `audit_log`, where no license holds it |

Stamps use the audit diff rather than `metadata.fields`, because `fields` lists what the
vendor sent, and a product resend with the same value is not an edit. An AECi write has a
different `metadata.source`, so "Looks right", promote, overrides and AECi contest accepts
never count.

## What it writes

Only the eight columns above, only where NULL. It writes no audit row: these are derived
columns, kept out of every audit diff like `updated_at`, and the run's output is the record.
`updated_at` does not move, so Algolia and public sorts do not see it. Nothing here purges
the cache. Cached pages pick the captions up as their tags next purge or their TTL ends.

## How to undo

Set the column back to NULL where it equals a backfilled value. There is no rollback flag.
