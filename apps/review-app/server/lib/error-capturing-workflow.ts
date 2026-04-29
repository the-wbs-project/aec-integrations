// ---------------------------------------------------------------------------
// Base class for workflows that surface their actual thrown error to the
// runs UI. Cloudflare's instance.status() only returns a generic
// WorkflowFatalError, so we capture the real cause to KV before re-throwing.
//
// Subclasses implement `runImpl` instead of `run`. The wrapper here catches
// any error, persists `{ name, message, stack }` via putCapturedError, and
// re-throws so Cloudflare still marks the instance as errored.
// ---------------------------------------------------------------------------
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../env';
import type { RunParams } from './workflow-meta';
import { putCapturedError } from '../services/run-errors';

export abstract class ErrorCapturingWorkflow extends WorkflowEntrypoint<Env, RunParams> {
  protected abstract runImpl(
    event: WorkflowEvent<RunParams>,
    step: WorkflowStep,
  ): Promise<unknown>;

  override async run(event: WorkflowEvent<RunParams>, step: WorkflowStep): Promise<unknown> {
    try {
      return await this.runImpl(event, step);
    } catch (err) {
      // Surface the real error to wrangler tail — Cloudflare's
      // WorkflowFatalError wrapper hides the underlying message/stack
      // otherwise, and the KV-persisted copy is only visible in the runs UI.
      const name = err instanceof Error ? err.name : 'Error';
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error(
        `[workflow-error] runId=${event.instanceId} ${name}: ${message}${stack ? `\n${stack}` : ''}`,
      );

      // Best-effort persistence — never let a KV failure swallow the
      // original error. waitUntil keeps the write alive past the throw.
      this.ctx.waitUntil(
        putCapturedError(this.env, event.instanceId, err).catch(() => {}),
      );
      throw err;
    }
  }
}
