# Runbooks

Every operator procedure for AECi, one file per kind of event. Open the file that matches what just
happened. Each file keeps its `##` headings stable, because alerts, code comments and other docs cite
them by name.

| File | Open it when |
|---|---|
| [`alerts.md`](./alerts.md) | An alert, a failed-job email, or the CI liveness sweep paged you. Its "Alert → runbook" table maps every signal to a section |
| [`catalog.md`](./catalog.md) | A promote job failed or stuck, the strand audit is red, retractions are pending, the review-app mirror drifted, someone asked for a removal, or a live slug must change |
| [`subscriptions.md`](./subscriptions.md) | A Stripe refund, opt-out, webhook or reconcile issue, a pilot or granted term, or a vendor must be suspended or ended |
| [`legal.md`](./legal.md) | A data breach, an accessibility barrier report or demand letter, a subpoena for a reviewer's identity, a matter that needs a litigation hold, a legal change notice that did not go out, a company stuck on the acceptance screen, or a digest report about a legal version |
| [`listing-submissions.md`](./listing-submissions.md) | Someone asked to be listed: who may list what, identity proof, reply templates |
| [`gsc-reindex.md`](./gsc-reindex.md) | Working the Google Search Console re-crawl queue |
| [`launch-cutover.md`](./launch-cutover.md) | A DNS or launch cutover |

Post-launch daily and weekly checks are not here. They are in
[`../POST_LAUNCH_MONITORING.md`](../POST_LAUNCH_MONITORING.md).
