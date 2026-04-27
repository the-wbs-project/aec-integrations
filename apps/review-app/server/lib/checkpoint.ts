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
  return typeof configOrFn === 'function'
    ? stepAny.do(name, configOrFn)
    : stepAny.do(name, configOrFn, fn);
}
