// ---------------------------------------------------------------------------
// LLM helpers: batch request building, response interpretation, SerpAPI tool
// execution. Each workflow composes these inside its run() method.
// ---------------------------------------------------------------------------
import type Anthropic from '@anthropic-ai/sdk';
import type { Env, SearchTool } from '../env';
import {
  WEB_SEARCH_TOOL,
  serpToolSchema,
  emitResultTool,
  type Tool,
} from '../services/llm-tools';
import { runSerpSearch, pickOrganicResults } from '../services/search';
import {
  AnthropicBatchClient,
  type MessageBatchIndividualResponse,
  type AnthropicMessageBatch,
} from '../services/anthropic';

export type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;
export type Message = Anthropic.Messages.Message;
export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlockParam = Anthropic.Messages.ContentBlockParam;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;

type SdkToolArray = Anthropic.Messages.BatchCreateParams.Request['params']['tools'];

export interface OutputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
}

export interface BuildInitialBatchRequestInput {
  customId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: OutputSchema;
  searchTool: SearchTool;
  maxTokens?: number;
}

export function buildInitialBatchRequest(
  input: BuildInitialBatchRequestInput,
): BatchRequest {
  const tools: Tool[] = [
    input.searchTool === 'web' ? WEB_SEARCH_TOOL : serpToolSchema(),
    emitResultTool(input.outputSchema),
  ];
  return {
    custom_id: input.customId,
    params: {
      model: input.model,
      max_tokens: input.maxTokens ?? 8192,
      temperature: 0,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
      tools: tools as unknown as SdkToolArray,
      tool_choice: { type: 'auto' },
    },
  };
}

export interface BuildContinuationBatchRequestInput {
  customId: string;
  model: string;
  systemPrompt: string;
  outputSchema: OutputSchema;
  priorMessages: MessageParam[];
  maxTokens?: number;
}

export function buildContinuationBatchRequest(
  input: BuildContinuationBatchRequestInput,
): BatchRequest {
  const tools: Tool[] = [serpToolSchema(), emitResultTool(input.outputSchema)];
  return {
    custom_id: input.customId,
    params: {
      model: input.model,
      max_tokens: input.maxTokens ?? 8192,
      temperature: 0,
      system: input.systemPrompt,
      messages: input.priorMessages,
      tools: tools as unknown as SdkToolArray,
      tool_choice: { type: 'any' },
    },
  };
}

// ---------------------------------------------------------------------------
// Batch I/O — small wrappers around the AnthropicBatchClient with workflow
// metadata baked in.
// ---------------------------------------------------------------------------

export interface BatchContext {
  runId: string;
  workflow: string;
}

export async function submitBatch(
  env: Env,
  ctx: BatchContext,
  requests: BatchRequest[],
): Promise<{ batchId: string }> {
  const client = new AnthropicBatchClient(env, ctx);
  const batch = await client.create(requests);
  return { batchId: batch.id };
}

export async function pollBatch(
  env: Env,
  ctx: BatchContext,
  batchId: string,
): Promise<AnthropicMessageBatch> {
  const client = new AnthropicBatchClient(env, ctx);
  return client.retrieve(batchId);
}

export async function getBatchResults(
  env: Env,
  ctx: BatchContext,
  batchId: string,
): Promise<MessageBatchIndividualResponse[]> {
  const client = new AnthropicBatchClient(env, ctx);
  return client.results(batchId);
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

/**
 * One built-in web_search invocation, paired with its result. Populated for
 * Anthropic's server-side `web_search_20250305` tool. Errors come back as
 * `web_search_tool_result_error` blocks (max_uses_exceeded, too_many_requests,
 * invalid_tool_input, etc.) — captured in `error`.
 */
export interface SearchActivity {
  query: string;
  resultCount: number;
  error?: string;
}

export interface InterpretedResult {
  /** Set when the model called emit_result — final structured answer. */
  emitted?: Record<string, unknown>;
  /** Set when the model called the custom 'web_search' tool. */
  pendingSearch?: { toolUseId: string; query: string };
  /** True when the model returned without calling any tool. */
  noTool?: boolean;
  stopReason?: string | null;
  /** Built-in web_search activity for this turn, in invocation order. */
  searches: SearchActivity[];
  /** Full assistant message — append to the conversation before next turn. */
  assistantMessage: MessageParam;
}

export function interpretMessage(message: Message): InterpretedResult {
  let emitted: Record<string, unknown> | undefined;
  let pendingSearch: { toolUseId: string; query: string } | undefined;
  const queriesById = new Map<string, string>();
  const searches: SearchActivity[] = [];

  // SDK 0.36.x doesn't yet type `server_tool_use` / `web_search_tool_result`
  // in the ContentBlock union, so we widen here to read them off the wire.
  // The shapes match the Anthropic Messages API server-tool spec.
  type WideBlock = { type: string; [k: string]: unknown };
  for (const block of message.content as unknown as WideBlock[]) {
    if (block.type === 'tool_use') {
      const tu = block as unknown as ToolUseBlock;
      if (tu.name === 'emit_result') {
        emitted = tu.input as Record<string, unknown>;
      } else if (tu.name === 'web_search') {
        const input = tu.input as { query?: unknown };
        if (typeof input.query === 'string') {
          pendingSearch = { toolUseId: tu.id, query: input.query };
        }
      }
    } else if (block.type === 'server_tool_use') {
      const name = block['name'];
      const id = block['id'];
      const input = block['input'] as { query?: unknown } | undefined;
      if (name === 'web_search' && typeof id === 'string' && typeof input?.query === 'string') {
        queriesById.set(id, input.query);
      }
    } else if (block.type === 'web_search_tool_result') {
      const toolUseId = block['tool_use_id'];
      const content = block['content'];
      const query = typeof toolUseId === 'string' ? (queriesById.get(toolUseId) ?? '') : '';
      if (Array.isArray(content)) {
        searches.push({ query, resultCount: content.length });
      } else if (
        content &&
        typeof content === 'object' &&
        (content as { type?: string }).type === 'web_search_tool_result_error'
      ) {
        const errorCode = (content as { error_code?: unknown }).error_code;
        searches.push({
          query,
          resultCount: 0,
          error: typeof errorCode === 'string' ? errorCode : 'unknown_error',
        });
      }
    }
  }

  return {
    emitted,
    pendingSearch,
    noTool: !emitted && !pendingSearch,
    stopReason: message.stop_reason,
    searches,
    assistantMessage: { role: 'assistant', content: message.content },
  };
}

/**
 * Emit a single structured log line summarising one model turn — searches
 * issued, results returned, errors, stop reason, whether emit_result fired.
 * Cloudflare observability ties these to the worker invocation. This is the
 * canonical visibility hook for built-in web_search activity; tail
 * `wrangler tail` or filter on `[llm-turn]` in the dashboard.
 */
export function logTurnSummary(
  ctx: BatchContext,
  turn: number,
  interpreted: InterpretedResult,
): void {
  const summary = {
    runId: ctx.runId,
    workflow: ctx.workflow,
    turn,
    stopReason: interpreted.stopReason,
    emitted: Boolean(interpreted.emitted),
    searches: interpreted.searches.map((s) => ({
      query: s.query,
      resultCount: s.resultCount,
      ...(s.error ? { error: s.error } : {}),
    })),
    pendingSerp: interpreted.pendingSearch?.query,
  };
  console.log(`[llm-turn] ${JSON.stringify(summary)}`);
}

/**
 * Run the SerpAPI custom tool for one tool_use block. Returns the
 * tool_result message that gets appended before the next turn.
 */
export async function executeSearchTool(
  env: Env,
  search: { toolUseId: string; query: string },
): Promise<MessageParam> {
  const result = await runSerpSearch(env, { q: search.query });
  let content: string;
  if (result.status !== 200) {
    content = JSON.stringify({
      error: 'search_failed',
      status: result.status,
      body: result.body,
    });
  } else {
    const organic = pickOrganicResults(result.body, 5);
    content = JSON.stringify({
      query: search.query,
      results: organic,
      cached: result.cached,
    });
  }
  const toolResult: ContentBlockParam = {
    type: 'tool_result',
    tool_use_id: search.toolUseId,
    content,
  };
  return { role: 'user', content: [toolResult] };
}
