// ---------------------------------------------------------------------------
// T00 — Tool orchestrator (v1 simplification).
// Source: artifacts/n8n-workflows/AECi-T00-Orchestrator.json
//
// NOTE: Running individual leaf workflows from this orchestrator is DEFERRED
// from v1. In n8n the orchestrator chained the T01–T07 sub-workflows; in
// columbus-v2 each leaf workflow is its own batch run, and the upstream caller
// (the WorkflowRun DO) is responsible for dispatching them.
//
// For now this orchestrator just delegates to the T08 score logic so that
// invoking the "tool-orchestrator" workflow on a record gives you a fresh set
// of priority scores without re-running the leaf enrichments.
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import { workflow as scoreWorkflow } from './score';

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description:
    'V1 orchestrator stub — recomputes tool priority scores only. Leaf-workflow chaining is deferred.',
  table: 'tools',

  async run(env, record) {
    return scoreWorkflow.run(env, record);
  },
};
