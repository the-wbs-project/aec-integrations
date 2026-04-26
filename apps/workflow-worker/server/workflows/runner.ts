// ---------------------------------------------------------------------------
// runWorkflowStep — pure-ish state machine that the WorkflowRun DO calls
// from its alarm() method.
//
// Inputs:  current WorkflowRunState
// Outputs: next WorkflowRunState + when to schedule the next alarm
//
// State transitions:
//   pending           → submit initial work (LLM batch OR custom inline)
//   in_progress       → poll the outstanding batch and advance records
//   completed/failed  → no further work
//
// Per-record state inside in_progress:
//   queued            → waiting for first batch result
//   in_progress       → tool_use round in flight (SerpAPI mode only)
//   done / error      → terminal
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import type { WorkflowRunState, RecordState } from '../durable-objects/WorkflowRun';
import { WORKFLOWS } from './registry';
import type { Workflow, ParseResult } from './types';
import { getRecord, updateRecord } from '../services/airtable';
import { AnthropicBatchClient, type MessageBatchIndividualResponse } from '../services/anthropic';
import {
  buildInitialBatchRequest,
  buildContinuationBatchRequest,
  interpretMessage,
  executeSearchTool,
  type MessageParam,
} from '../tasks/searchWithLlm';

export interface StepResult {
  state: WorkflowRunState;
  /** Milliseconds from now to schedule the next alarm. undefined = no more alarms. */
  scheduleNextPollMs?: number;
}

export interface StepOptions {
  maxTurns: number;
}

const POLL_BACKOFF_MS = [30_000, 60_000, 120_000]; // 30s → 60s → 120s

export async function runWorkflowStep(
  env: Env,
  state: WorkflowRunState,
  opts: StepOptions,
): Promise<StepResult> {
  const workflow = WORKFLOWS[state.workflow] as Workflow | undefined;
  if (!workflow) {
    return failRun(state, `Unknown workflow: ${state.workflow}`);
  }

  if (state.status === 'pending') {
    return startRun(env, state, workflow, opts);
  }

  if (state.status === 'in_progress' && state.batchId) {
    return advanceLlmRun(env, state, workflow, opts);
  }

  // Custom workflows complete inside startRun, so reaching here without a
  // batchId means something is wrong.
  return failRun(state, 'Run is in progress but has no outstanding batch');
}

// ---------------------------------------------------------------------------
// Phase 1: start
// ---------------------------------------------------------------------------
async function startRun(
  env: Env,
  state: WorkflowRunState,
  workflow: Workflow,
  _opts: StepOptions,
): Promise<StepResult> {
  // Fetch every record up front. Failures here mark the whole run as failed.
  const fetched: Record<string, Awaited<ReturnType<typeof getRecord>>> = {};
  const records = state.records.map((r) => ({ ...r }));
  for (const record of records) {
    try {
      fetched[record.recordId] = await getRecord(env, workflow.table, record.recordId);
      record.status = 'in_progress';
    } catch (err) {
      record.status = 'error';
      record.error = err instanceof Error ? err.message : String(err);
    }
  }

  if (workflow.kind === 'custom') {
    // Run the custom workflow synchronously per record. No batch API.
    for (const record of records) {
      if (record.status !== 'in_progress') continue;
      const r = fetched[record.recordId];
      if (!r) {
        record.status = 'error';
        record.error = 'Record not fetched';
        continue;
      }
      try {
        const result = await workflow.run(env, r);
        await applyParseResult(env, workflow, record.recordId, result);
        record.result = result.fields;
        record.fieldsUpdated = result.fieldsUpdated;
        record.status = result.status === 'error' ? 'error' : 'done';
        if (result.note) record.error = result.note;
      } catch (err) {
        record.status = 'error';
        record.error = err instanceof Error ? err.message : String(err);
      }
    }
    return finalizeIfTerminal({ ...state, records, status: 'in_progress' });
  }

  // LLM workflow: build initial batch from each fetched record.
  const requests = [];
  for (const record of records) {
    if (record.status !== 'in_progress') continue;
    const r = fetched[record.recordId];
    if (!r) continue;
    const built = workflow.buildPrompt(r);
    const customId = `${record.recordId}-t0`;
    record.customId = customId;
    record.turns = 0;
    record.messages = [{ role: 'user', content: built.userPrompt }];
    requests.push(
      buildInitialBatchRequest({
        customId,
        model: state.model,
        systemPrompt: built.systemPrompt,
        userPrompt: built.userPrompt,
        outputSchema: built.outputSchema,
        searchTool: state.searchTool,
      }),
    );
  }

  if (requests.length === 0) {
    return finalizeIfTerminal({ ...state, records, status: 'in_progress' });
  }

  const client = new AnthropicBatchClient(env, { runId: state.runId, workflow: state.workflow });
  const batch = await client.create(requests);

  return {
    state: {
      ...state,
      records,
      status: 'in_progress',
      step: state.step + 1,
      batchId: batch.id,
      pollIntervalS: POLL_BACKOFF_MS[0] / 1000,
    },
    scheduleNextPollMs: POLL_BACKOFF_MS[0],
  };
}

// ---------------------------------------------------------------------------
// Phase 2: advance (poll batch, parse results, optionally submit follow-up)
// ---------------------------------------------------------------------------
async function advanceLlmRun(
  env: Env,
  state: WorkflowRunState,
  workflow: Workflow,
  opts: StepOptions,
): Promise<StepResult> {
  if (workflow.kind !== 'llm') {
    return failRun(state, 'Custom workflow has an outstanding batch — invariant broken');
  }

  const client = new AnthropicBatchClient(env, { runId: state.runId, workflow: state.workflow });
  const batch = await client.retrieve(state.batchId!);

  if (batch.processing_status !== 'ended') {
    const interval = nextBackoffMs(state.pollIntervalS);
    return {
      state: { ...state, pollIntervalS: interval / 1000 },
      scheduleNextPollMs: interval,
    };
  }

  const responses = await client.results(state.batchId!);
  const responseByCustomId = new Map(responses.map((r) => [r.custom_id, r]));

  const records = state.records.map((r) => ({ ...r }));
  const followUpRequests = [];

  for (const record of records) {
    if (record.status !== 'in_progress') continue;
    if (!record.customId) {
      record.status = 'error';
      record.error = 'Missing custom_id';
      continue;
    }
    const response = responseByCustomId.get(record.customId);
    if (!response) {
      record.status = 'error';
      record.error = `No batch result for ${record.customId}`;
      continue;
    }
    if (response.result.type !== 'succeeded') {
      record.status = 'error';
      record.error = `Batch result ${response.result.type}`;
      continue;
    }

    const interpreted = interpretMessage(response.result.message);

    // Update the conversation history regardless of branch.
    const priorMessages = (record.messages as MessageParam[] | undefined) ?? [];
    const withAssistant = [...priorMessages, interpreted.assistantMessage];

    if (interpreted.emitted) {
      // Final answer for this record. Persist + write back.
      try {
        const r = await getRecord(env, workflow.table, record.recordId);
        const parsed = await workflow.parseResult(env, r, interpreted.emitted);
        await applyParseResult(env, workflow, record.recordId, parsed);
        record.result = parsed.fields;
        record.fieldsUpdated = parsed.fieldsUpdated;
        record.status = parsed.status === 'error' ? 'error' : 'done';
        if (parsed.note) record.error = parsed.note;
      } catch (err) {
        record.status = 'error';
        record.error = err instanceof Error ? err.message : String(err);
      }
      record.messages = undefined;
      record.customId = undefined;
      continue;
    }

    if (interpreted.pendingSearch && state.searchTool === 'serpapi') {
      // Multi-turn SerpAPI loop. Execute the tool, queue continuation.
      if (record.turns + 1 >= opts.maxTurns) {
        record.status = 'error';
        record.error = `Exceeded maxTurns (${opts.maxTurns}) without emit_result`;
        continue;
      }
      try {
        const toolResultMsg = await executeSearchTool(env, interpreted.pendingSearch);
        const messages: MessageParam[] = [...withAssistant, toolResultMsg];
        record.messages = messages;
        record.turns += 1;
        const built = workflow.buildPrompt(await getRecord(env, workflow.table, record.recordId));
        const customId = `${record.recordId}-t${record.turns}`;
        record.customId = customId;
        followUpRequests.push(
          buildContinuationBatchRequest({
            customId,
            model: state.model,
            systemPrompt: built.systemPrompt,
            outputSchema: built.outputSchema,
            priorMessages: messages,
          }),
        );
      } catch (err) {
        record.status = 'error';
        record.error = err instanceof Error ? err.message : String(err);
      }
      continue;
    }

    if (interpreted.pendingSearch && state.searchTool === 'web') {
      // Should not happen — built-in web_search executes server-side, so the
      // model should not return a client-handled tool_use for it.
      record.status = 'error';
      record.error = 'Unexpected client tool_use in web_search mode';
      continue;
    }

    // No tool was called — treat as error.
    record.status = 'error';
    record.error = `Model returned without emit_result (stop_reason=${interpreted.stopReason})`;
  }

  if (followUpRequests.length > 0) {
    const client2 = new AnthropicBatchClient(env, { runId: state.runId, workflow: state.workflow });
    const followUp = await client2.create(followUpRequests);
    return {
      state: {
        ...state,
        records,
        step: state.step + 1,
        batchId: followUp.id,
        pollIntervalS: POLL_BACKOFF_MS[0] / 1000,
      },
      scheduleNextPollMs: POLL_BACKOFF_MS[0],
    };
  }

  return finalizeIfTerminal({ ...state, records, batchId: undefined, pollIntervalS: undefined });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function finalizeIfTerminal(state: WorkflowRunState): StepResult {
  const allTerminal = state.records.every((r) => r.status === 'done' || r.status === 'error');
  if (!allTerminal) {
    // Shouldn't happen: in_progress without batch and not all terminal.
    return { state, scheduleNextPollMs: 60_000 };
  }
  return {
    state: { ...state, status: 'completed', finishedAt: new Date().toISOString() },
    scheduleNextPollMs: undefined,
  };
}

function failRun(state: WorkflowRunState, message: string): StepResult {
  return {
    state: { ...state, status: 'failed', error: message, finishedAt: new Date().toISOString() },
    scheduleNextPollMs: undefined,
  };
}

function nextBackoffMs(currentS: number | undefined): number {
  const currentMs = (currentS ?? POLL_BACKOFF_MS[0] / 1000) * 1000;
  const idx = POLL_BACKOFF_MS.indexOf(currentMs);
  if (idx === -1 || idx >= POLL_BACKOFF_MS.length - 1) return POLL_BACKOFF_MS[POLL_BACKOFF_MS.length - 1];
  return POLL_BACKOFF_MS[idx + 1];
}

async function applyParseResult(
  env: Env,
  workflow: Workflow,
  recordId: string,
  result: ParseResult,
): Promise<void> {
  if (result.fieldsUpdated.length === 0) return;
  await updateRecord(env, workflow.table, recordId, result.fields);
}
