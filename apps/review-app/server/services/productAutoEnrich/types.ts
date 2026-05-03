// ---------------------------------------------------------------------------
// Product auto-enrich queue contract.
//
// Producer: scheduled() handler in server/app.scheduled.ts (every 12 min) and
// any future ad-hoc HTTP endpoint.
// Consumer: queue() handler in server/app.queues.ts → runProductAutoEnrich.
//
// `model` is optional on the wire so manual injections can omit it; the
// consumer falls back to env.DEFAULT_MODEL.
// ---------------------------------------------------------------------------

export type ProductAutoEnrichJob = {
  kind: 'product-auto-enrich';
  count: number;
  model?: string;
  triggeredBy: 'cron' | 'http';
};

export const PRODUCT_AUTO_ENRICH_QUEUE_NAME = 'aeci-product-auto-enrich';
