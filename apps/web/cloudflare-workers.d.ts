// Types for the `#cloudflare-workers` subpath import (see this package's
// `imports` map, `types` condition). TypeScript resolves the import through
// here, so `WorkerEntrypoint` keeps its real generic signature (`<Env>`) from
// the `cloudflare:workers` ambient module declared in `worker-configuration.d.ts`
// — the Node stub (`cloudflare-workers.stub.mjs`) is only used at runtime during
// Angular's route extraction, never for types. See ADR 0020 §2 (WC-4).
export { WorkerEntrypoint } from 'cloudflare:workers';
