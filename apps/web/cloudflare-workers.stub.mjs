// Node-side stub for `cloudflare:workers`, resolved via the `#cloudflare-workers`
// subpath import (see this package's `imports` map) under the **`node`** export
// condition ONLY. It exists for one reason: Angular's `outputMode: "server"`
// route-extraction step runs the built SSR bundle in plain **Node**, whose ESM
// loader rejects the `cloudflare:` URL scheme (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).
// Route extraction only enumerates Angular routes — it never instantiates or
// calls the `Renderer` WorkerEntrypoint — so an inert base class is safe here.
//
// The real Workers runtime (and wrangler's bundler) resolve `#cloudflare-workers`
// under the `workerd` condition to the genuine `cloudflare:workers` module, so
// this stub is NEVER part of a deployed Worker. See `apps/web/wrangler.jsonc`
// and ADR 0020 §2 (WC-4).
export class WorkerEntrypoint {}
