// Real target for the `#cloudflare-workers` subpath import under the `workerd` /
// `worker` export conditions (wrangler + the Workers runtime). It re-exports the
// genuine `cloudflare:workers` built-in via a **literal** import so wrangler's
// bundler intercepts the `cloudflare:` scheme (a scheme arriving via an
// imports-map remap is NOT intercepted, so pointing the condition straight at
// `"cloudflare:workers"` fails to resolve — hence this thin shim). Node's route
// extraction never loads this file; it resolves the `node` condition to
// `cloudflare-workers.stub.mjs` instead. See ADR 0020 §2 (WC-4).
export { WorkerEntrypoint } from 'cloudflare:workers';
