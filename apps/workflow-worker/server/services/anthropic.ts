// ---------------------------------------------------------------------------
// Anthropic Batch API wrapper — routes through Cloudflare AI Gateway.
//
// Why a wrapper instead of raw SDK calls everywhere:
//   - Centralises the AI Gateway baseURL so callers can't accidentally hit
//     api.anthropic.com directly.
//   - Adds default cf-aig-* headers (runId, workflow) so we can filter
//     analytics in the Cloudflare AI Gateway dashboard.
//   - Hides the SDK's `Anthropic` class from callers.
// ---------------------------------------------------------------------------
import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../env';

export type AnthropicMessageBatch = Anthropic.Messages.MessageBatch;
export type BatchCreateParams = Anthropic.Messages.BatchCreateParams;
export type BatchCreateRequest = Anthropic.Messages.BatchCreateParams.Request;
export type Message = Anthropic.Messages.Message;
export type MessageBatchIndividualResponse = Anthropic.Messages.MessageBatchIndividualResponse;

export interface BatchClientContext {
  runId?: string;
  workflow?: string;
}

export class AnthropicBatchClient {
  private client: Anthropic;
  private cfMetadata: BatchClientContext;
  private baseURL: string;

  constructor(env: Env, ctx: BatchClientContext = {}) {
    this.baseURL = `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/anthropic`;
    this.cfMetadata = ctx;
    this.client = new Anthropic({
      // With BYOK on the gateway, the upstream Anthropic key is stored in CF
      // and we only authenticate to the gateway via cf-aig-authorization.
      // The SDK still requires *some* api key, so use a placeholder when no
      // ANTHROPIC_API_KEY secret is set.
      apiKey: env.ANTHROPIC_API_KEY ?? 'cf-ai-gateway-byok',
      baseURL: this.baseURL,
      defaultHeaders: this.gatewayHeaders(env),
    });
  }

  private gatewayHeaders(env: Env): Record<string, string> {
    const headers: Record<string, string> = {
      //'cf-aig-authorization': `Bearer ${env.CF_AI_GATEWAY_TOKEN}`,
    };
    if (this.cfMetadata.runId) {
      headers['cf-aig-metadata'] = JSON.stringify(this.cfMetadata);
    }
    return headers;
  }

  /** Submit a batch of message requests. */
  async create(requests: BatchCreateRequest[]): Promise<AnthropicMessageBatch> {
    return this.client.messages.batches.create({ requests });
  }

  /** Poll a batch by id; returns whatever the API returns (status + counts). */
  async retrieve(batchId: string): Promise<AnthropicMessageBatch> {
    return this.client.messages.batches.retrieve(batchId);
  }

  /**
   * Stream individual responses for a completed batch. The SDK returns a
   * pageable iterator; we collect all of them since our batches are small
   * (≤ a few hundred records per run).
   */
  async results(batchId: string): Promise<MessageBatchIndividualResponse[]> {
    const responses: MessageBatchIndividualResponse[] = [];
    for await (const r of await this.client.messages.batches.results(batchId, {
      path: `${this.baseURL}/v1/messages/batches/${batchId}/results`,
    })) {
      responses.push(r);
    }
    return responses;
  }
}
