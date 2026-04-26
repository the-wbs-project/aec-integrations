// ---------------------------------------------------------------------------
// WorkflowRun Durable Object
//
// One DO instance per workflow run. Owns persistent state across the lifetime
// of a run (which can span minutes while the Anthropic Batch API processes
// requests). Drives the workflow forward via storage alarms.
//
// State machine:
//   pending → in_progress → completed / failed
//
// Per record: queued → in_progress → done / error
//
// The DO calls into a workflow's `run()` function (registry.ts) for each
// step. Workflow functions are pure — they describe what to do next; the DO
// owns I/O, batch submission, and polling.
// ---------------------------------------------------------------------------
import type { Env, SearchProvider, SearchTool } from '../env';
import { WORKFLOWS, type WorkflowName } from '../workflows/registry';
import { runWorkflowStep } from '../workflows/runner';

export interface StartRunInput {
  runId: string;
  workflow: WorkflowName;
  model: string;
  searchTool: SearchTool;
  searchProvider: SearchProvider;
  recordIds: string[];
}

export interface RecordState {
  recordId: string;
  status: 'queued' | 'in_progress' | 'done' | 'error';
  turns: number;
  result?: unknown;
  error?: string;
  fieldsUpdated?: string[];
  // Conversation accumulator (assistant + tool_result blocks across turns).
  // Stored only while the record is in_progress on the SerpAPI multi-turn path.
  messages?: unknown[];
  // Per-record custom_id used in the current outstanding batch.
  customId?: string;
}

export interface WorkflowRunState {
  runId: string;
  workflow: WorkflowName;
  model: string;
  searchTool: SearchTool;
  searchProvider: SearchProvider;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  step: number;
  batchId?: string;
  records: RecordState[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
  // Internal: next-poll backoff in seconds (30 → 60 → 120, capped).
  pollIntervalS?: number;
}

const STATE_KEY = 'state';
const MAX_TURNS = 6; // safety cap on SerpAPI tool loop

export class WorkflowRun {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/start' && request.method === 'POST') {
      return this.handleStart(request);
    }
    if (url.pathname === '/status' && request.method === 'GET') {
      return this.handleStatus();
    }
    return new Response('Not found', { status: 404 });
  }

  private async handleStart(request: Request): Promise<Response> {
    const input = await request.json<StartRunInput>();
    const existing = await this.state.storage.get<WorkflowRunState>(STATE_KEY);
    if (existing) {
      return new Response(JSON.stringify({ error: 'Run already started', runId: existing.runId }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!(input.workflow in WORKFLOWS)) {
      return new Response(JSON.stringify({ error: `Unknown workflow: ${input.workflow}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const initial: WorkflowRunState = {
      runId: input.runId,
      workflow: input.workflow,
      model: input.model,
      searchTool: input.searchTool,
      searchProvider: input.searchProvider,
      status: 'pending',
      step: 0,
      records: input.recordIds.map((id) => ({
        recordId: id,
        status: 'queued',
        turns: 0,
      })),
      startedAt: new Date().toISOString(),
    };

    await this.state.storage.put(STATE_KEY, initial);
    // Kick off the first step immediately by setting an alarm in the past.
    await this.state.storage.setAlarm(Date.now());

    return new Response(JSON.stringify({ accepted: true, runId: input.runId }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.state.storage.get<WorkflowRunState>(STATE_KEY);
    if (!state) {
      return new Response(JSON.stringify({ error: 'Run not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Alarm fires when:
   *   - the run is starting (initial step submission)
   *   - we previously scheduled a batch poll
   *   - we need to advance the loop after tool execution
   *
   * Each fire calls runWorkflowStep, which is responsible for:
   *   - submitting the initial Anthropic batch (step 0)
   *   - polling an in-flight batch
   *   - parsing batch results
   *   - executing custom-tool calls (SerpAPI mode)
   *   - submitting follow-up batches
   *   - writing back to Airtable when records finish
   *   - updating state.records[*].status accordingly
   */
  async alarm(): Promise<void> {
    const state = await this.state.storage.get<WorkflowRunState>(STATE_KEY);
    if (!state) return;
    if (state.status === 'completed' || state.status === 'failed') return;

    try {
      const next = await runWorkflowStep(this.env, state, { maxTurns: MAX_TURNS });
      await this.state.storage.put(STATE_KEY, next.state);
      if (next.scheduleNextPollMs !== undefined) {
        await this.state.storage.setAlarm(Date.now() + next.scheduleNextPollMs);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`WorkflowRun ${state.runId} alarm error:`, err);
      const failed: WorkflowRunState = {
        ...state,
        status: 'failed',
        error: message,
        finishedAt: new Date().toISOString(),
      };
      await this.state.storage.put(STATE_KEY, failed);
    }
  }
}
