# Runbooks

Every operator procedure for AECi, one file per kind of event. Open the file that matches what just
happened. Each file keeps its `##` headings stable, because alerts, code comments and other docs cite
them by name.

| File | Open it when |
|---|---|
| [`alerts.md`](./alerts.md) | An alert, a failed-job email, or the CI liveness sweep paged you. Its "Alert → runbook" table maps every signal to a section |
| [`catalog.md`](./catalog.md) | A promote job failed or stuck, the strand audit is red, retractions are pending, you retracted a product or vendor by hand, you promote a connector and its pairs or withdraw one, the review-app mirror drifted, someone asked for a removal, a data flow on a Sync Service integration is wrong, a live slug must change, or a deploy added an Algolia record field |
| [`subscriptions.md`](./subscriptions.md) | A Stripe refund, opt-out, webhook or reconcile issue, a pilot or granted term, or a vendor must be suspended or ended |
| [`legal.md`](./legal.md) | A data breach, an accessibility barrier report or demand letter, a copyright notice or counter-notice, a subpoena for a reviewer's identity, a matter that needs a litigation hold, a request to show a plan did not change a product's ranking or that an acceptance was not edited, a legal change notice that did not go out, a company stuck on the acceptance screen, or a digest report about a legal version |
| [`listing-submissions.md`](./listing-submissions.md) | Someone asked to be listed: who may list what, identity proof, reply templates; a Sync Service integration veto that arrives by email (§6b) |
| [`gsc-reindex.md`](./gsc-reindex.md) | Working the Google Search Console re-crawl queue |
| [`launch-cutover.md`](./launch-cutover.md) | A DNS or launch cutover |

Post-launch daily and weekly checks are not here. They are in
[`../POST_LAUNCH_MONITORING.md`](../POST_LAUNCH_MONITORING.md).
