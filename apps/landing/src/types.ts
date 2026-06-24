export interface Env {
  ASSETS: Fetcher;
  ANALYTICS: AnalyticsEngineDataset;
  // Service binding to the API Worker (aeci-api-*). Lead-capture forms persist to
  // D1 through it (ADR 0016 / AECI-257) instead of writing Supabase Postgres
  // directly. Resolves in-account (same Cloudflare account as aeci-api-*).
  API: Fetcher;
  RESEND_API_KEY: string;
  NOTIFICATION_FROM: string;
  NOTIFICATION_TO: string;
}
