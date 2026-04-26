// ---------------------------------------------------------------------------
// V00 — Vendor orchestrator (v1 simplification).
// Source: artifacts/n8n-workflows/AECi-V00-Orchestrator.json
//
// NOTE: Running individual leaf workflows from this orchestrator is DEFERRED
// from v1. In n8n the orchestrator chained the V01–V06 sub-workflows; in
// columbus-v2 each leaf workflow is its own batch run, and the upstream caller
// (the WorkflowRun DO) is responsible for dispatching them.
//
// For now this orchestrator just delegates to the V07 score logic so that
// invoking the "vendor-orchestrator" workflow on a record gives you a fresh
// vendor_data_completeness reading without re-running the leaf enrichments.
// ---------------------------------------------------------------------------
import type { CustomWorkflow } from '../types';
import { workflow as scoreWorkflow } from './score';

export const workflow: CustomWorkflow = {
  kind: 'custom',
  description:
    'V1 orchestrator stub — recomputes vendor completeness only. Leaf-workflow chaining is deferred.',
  table: 'vendors',

  async run(env, record) {
    return scoreWorkflow.run(env, record);
  },
};
