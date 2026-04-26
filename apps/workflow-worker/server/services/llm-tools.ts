// ---------------------------------------------------------------------------
// Standard tool schemas exposed to Claude.
//
//   - WEB_SEARCH_TOOL  → Anthropic built-in web_search_20250305 (server-side)
//   - serpToolSchema() → custom 'web_search' tool backed by SerpAPI/SearchAPI
//   - emitResultTool() → forced structured-output channel
//
// The model is steered to call `emit_result` exactly once at the end. Both
// search modes share the same `web_search` tool name so prompt templates
// don't have to branch.
//
// Note: we deliberately use literal object types here instead of the SDK's
// `Anthropic.Messages.WebSearchTool20250305` / `Anthropic.Messages.ToolUnion`
// names so this code isn't coupled to SDK version churn. The shapes are
// validated against the Anthropic API surface, not the SDK type tree.
// ---------------------------------------------------------------------------
import type { OutputSchema } from '../lib/llm';

export interface CustomTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface WebSearchTool {
  type: 'web_search_20250305';
  name: 'web_search';
  max_uses?: number;
}

export type Tool = CustomTool | WebSearchTool;

export const WEB_SEARCH_TOOL: WebSearchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 4,
};

/**
 * Custom SerpAPI/SearchAPI tool. Same name as the built-in web_search so the
 * prompt is identical in both modes. When the model emits a tool_use of this
 * shape, the runner executes the search server-side, then submits a follow-up
 * batch carrying the tool_result.
 */
export function serpToolSchema(maxResults = 5): CustomTool {
  return {
    name: 'web_search',
    description: `Run a Google search via SerpAPI. Returns up to ${maxResults} organic results with title, link, and snippet.`,
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string. May include site: filters.',
        },
      },
      required: ['query'],
    },
  };
}

/**
 * The structured-output channel — workflows force the model to call this
 * exactly once with the answer payload that matches the workflow's schema.
 */
export function emitResultTool(schema: OutputSchema): CustomTool {
  return {
    name: 'emit_result',
    description:
      'Emit your final structured answer for this enrichment task. Call this exactly once after gathering enough information.',
    input_schema: {
      type: 'object',
      properties: schema.properties,
      required: schema.required,
      ...(schema.additionalProperties !== undefined
        ? { additionalProperties: schema.additionalProperties }
        : {}),
    },
  };
}
