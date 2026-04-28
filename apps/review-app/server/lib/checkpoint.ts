// ---------------------------------------------------------------------------
// Tiny wrapper around `step.do` that hides the framework's recursive
// `Serializable<T>` constraint. Our payloads are JSON at runtime, but their
// static types include `unknown` slots (Anthropic message blocks, Airtable
// record fields) that the recursive check rejects.
// ---------------------------------------------------------------------------
import type { WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';

export function checkpoint<T>(
  step: WorkflowStep,
  name: string,
  fn: () => Promise<T>,
): Promise<T>;
export function checkpoint<T>(
  step: WorkflowStep,
  name: string,
  config: WorkflowStepConfig,
  fn: () => Promise<T>,
): Promise<T>;
export function checkpoint<T>(
  step: WorkflowStep,
  name: string,
  configOrFn: WorkflowStepConfig | (() => Promise<T>),
  fn?: () => Promise<T>,
): Promise<T> {
  // Note: WorkflowStep is an RPC stub — do NOT use Function.prototype.bind on
  // its methods (the stub raises "RPC receiver does not implement the method
  // 'bind'"). Call step.do directly and cast the result.
  const stepAny = step as unknown as {
    do: (name: string, configOrFn: unknown, fn?: unknown) => Promise<T>;
  };
  // Wrap the user fn so we log every throw immediately to wrangler tail.
  // Cloudflare's step.do retries failed steps and only the final
  // WorkflowFatalError reaches the run-level catch — so logging here is the
  // only reliable way to surface the underlying error name/message/stack.
  // Also log a start marker: if the runtime drops failed-invocation logs,
  // the last [checkpoint-start] before "Exception Thrown" still tells us
  // which step blew up.
  const wrap = <U>(userFn: () => Promise<U>): (() => Promise<U>) => async () => {
    console.log(`[checkpoint-start] step=${name}`);
    try {
      const result = await userFn();
      console.log(`[checkpoint-end] step=${name}`);
      return result;
    } catch (err) {
      const errName = err instanceof Error ? err.name : 'Error';
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      console.error(
        `[checkpoint-error] step=${name} ${errName}: ${errMsg}${errStack ? `\n${errStack}` : ''}`,
      );
      throw err;
    }
  };
  if (typeof configOrFn === 'function') {
    return stepAny.do(name, wrap(configOrFn));
  }
  return stepAny.do(name, configOrFn, wrap(fn as () => Promise<T>));
}
