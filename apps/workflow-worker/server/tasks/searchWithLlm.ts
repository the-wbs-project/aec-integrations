// ---------------------------------------------------------------------------
// searchWithLlm — the core reusable task type. Workflows feed it a record +
// prompt + output schema; it produces:
//   - a single batch request (initial submission)
//   - helpers to interpret the model's response
//   - helpers to build a follow-up turn when the model called the custom
//     SerpAPI tool
//
// This task abstracts the difference between the Anthropic built-in
// web_search tool (server-side, single batch round-trip) and our custom
// SerpAPI tool (client-side loop, multiple batch round-trips).
// ---------------------------------------------------------------------------
import type Anthropic from '@anthropic-ai/sdk';
import type { Env, SearchTool } from '../env';
import type { OutputSchema } from '../workflows/types';
import { WEB_SEARCH_TOOL, serpToolSchema, emitResultTool, type Tool } from '../services/llm-tools';
import { runSerpSearch, pickOrganicResults } from '../services/search';

// SDK doesn't always export a `ToolUnion` name across versions — we cast at
// the boundary into the SDK's accepted shape. The tools are runtime-valid
// either way; the cast just lets us pass our typed objects through.
type SdkToolArray = Anthropic.Messages.BatchCreateParams.Request['params']['tools'];

export interface BuildRequestInput {
  customId: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: OutputSchema;
  searchTool: SearchTool;
  /** Override max_tokens. Default 1024. */
  maxTokens?: number;
}

export type BatchRequest = Anthropic.Messages.BatchCreateParams.Request;
export type ToolUseBlock = Anthropic.Messages.ToolUseBlock;
export type Message = Anthropic.Messages.Message;
export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlockParam = Anthropic.Messages.ContentBlockParam;

export function buildInitialBatchRequest(input: BuildRequestInput): BatchRequest {
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

/**
 * Build a follow-up batch request after the model called the custom SerpAPI
 * tool. The conversation history is `priorMessages` (assistant + user
 * tool_result blocks alternating); we just submit it as-is and let the model
 * continue.
 */
export function buildContinuationBatchRequest(args: {
  customId: string;
  model: string;
  systemPrompt: string;
  outputSchema: OutputSchema;
  priorMessages: MessageParam[];
  maxTokens?: number;
}): BatchRequest {
  const tools: Tool[] = [serpToolSchema(), emitResultTool(args.outputSchema)];
  return {
    custom_id: args.customId,
    params: {
      model: args.model,
      max_tokens: args.maxTokens ?? 1024,
      temperature: 0,
      system: args.systemPrompt,
      messages: args.priorMessages,
      tools: tools as unknown as SdkToolArray,
      tool_choice: { type: 'any' },
    },
  };
}

// ---------------------------------------------------------------------------
// Response interpretation
// ---------------------------------------------------------------------------

export interface InterpretedResult {
  /** True when the model called emit_result — final answer. */
  emitted?: Record<string, unknown>;
  /** Set when the model called the custom 'web_search' tool. */
  pendingSearch?: { toolUseId: string; query: string };
  /** Set when the model returned without calling any tool (error case). */
  noTool?: boolean;
  /** Set when stop_reason indicates an error or the model gave up. */
  stopReason?: string | null;
  /** The full assistant message, ready to append to the conversation. */
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
 * Execute the SerpAPI tool for one tool_use block and return the
 * tool_result message that should be appended before the next batch turn.
 */
export async function executeSearchTool(
  env: Env,
  search: { toolUseId: string; query: string },
): Promise<MessageParam> {
  const result = await runSerpSearch(env, { q: search.query });
  let content: string;
  if (result.status !== 200) {
    content = JSON.stringify({ error: 'search_failed', status: result.status, body: result.body });
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
