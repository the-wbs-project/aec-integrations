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
      max_tokens: input.maxTokens ?? 1024,
      temperature: 0,
      system: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt }],
      tools: tools as unknown as SdkToolArray,
      tool_choice: { type: 'any' },
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
      max_tokens: input.maxTokens ?? 1024,
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

export interface InterpretedResult {
  /** Set when the model called emit_result — final structured answer. */
  emitted?: Record<string, unknown>;
  /** Set when the model called the custom 'web_search' tool. */
  pendingSearch?: { toolUseId: string; query: string };
  /** True when the model returned without calling any tool. */
  noTool?: boolean;
  stopReason?: string | null;
  /** Full assistant message — append to the conversation before next turn. */
  assistantMessage: MessageParam;
}

export function interpretMessage(message: Message): InterpretedResult {
  let emitted: Record<string, unknown> | undefined;
  let pendingSearch: { toolUseId: string; query: string } | undefined;

  for (const block of message.content) {
    if (block.type !== 'tool_use') continue;
    const tu = block as ToolUseBlock;
    if (tu.name === 'emit_result') {
      emitted = tu.input as Record<string, unknown>;
    } else if (tu.name === 'web_search') {
      const input = tu.input as { query?: unknown };
      if (typeof input.query === 'string') {
        pendingSearch = { toolUseId: tu.id, query: input.query };
      }
    }
  }

  return {
    emitted,
    pendingSearch,
    noTool: !emitted && !pendingSearch,
    stopReason: message.stop_reason,
    assistantMessage: { role: 'assistant', content: message.content },
  };
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
