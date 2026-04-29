// ---------------------------------------------------------------------------
// Auto-enrich queue contract.
//
// Producer: scheduled() handler in server/index.ts (every 12 min) and any
// future ad-hoc HTTP endpoint.
// Consumer: queue() handler in server/index.ts → runVendorAutoEnrich.
//
// `model` is optional on the wire so manual injections can omit it; the
// consumer falls back to env.DEFAULT_MODEL.
// ---------------------------------------------------------------------------

export type AutoEnrichJob = {
  kind: 'vendor-auto-enrich';
  count: number;
  model?: string;
  triggeredBy: 'cron' | 'http';
};

export const AUTO_ENRICH_QUEUE_NAME = 'aeci-vendor-auto-enrich';
