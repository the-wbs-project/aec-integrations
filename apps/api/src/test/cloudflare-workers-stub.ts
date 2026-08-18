/**
 * Node stand-in for the `cloudflare:workers` / `cloudflare:workflows` built-in modules,
 * aliased in `vitest.config.ts`.
 *
 * The API Worker's unit lane runs in plain Node (`environment: 'node'`), not the Workers
 * pool, and Node cannot resolve the `cloudflare:*` module specifiers at all. Two files
 * reach them: `workflows/promote-workflow.ts` (which extends `WorkflowEntrypoint` and
 * throws `NonRetryableError`) and, transitively, `src/index.ts` — which `ssr-binding.spec.ts`
 * imports. Without this alias every one of those specs fails to load.
 *
 * Both exports are faithful to the parts the code actually depends on: the entrypoint's
 * `(ctx, env)` constructor contract, and `NonRetryableError`'s second argument becoming the
 * error's `name` (which is what carries the `ApiErrorCode` through to the poll response).
 * Nothing here simulates the Workflows *engine* — the workflow spec drives
 * `runPromoteWorkflow` with its own fake `step`, which is the seam that exists for it.
 */

export class WorkflowEntrypoint<Env = unknown, T = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
  /** Declared so the generic parameter is used, mirroring the real class's shape. */
  declare protected readonly __params?: T;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class NonRetryableError extends Error {
  constructor(message: string, name = 'NonRetryableError') {
    super(message);
    this.name = name;
  }
}
