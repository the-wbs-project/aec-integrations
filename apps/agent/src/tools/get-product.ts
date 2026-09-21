/**
 * `get_product` — the public product detail record, fetched from the API Worker.
 *
 * It does NOT query D1. `GET /api/products/:slug` already applies the shipped
 * column allowlist and mappers in `apps/api/src/lib/drizzle-helpers.ts`, so the
 * agent gets exactly the payload the public product page renders and nothing
 * else. See `src/lib/api-client.ts` for why that seam exists and for the
 * AECI-666 body-release rule every call through it obeys.
 */
import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

import { apiGetJson, pathSegment, type ApiCaller } from '../lib/api-client';

export const GetProductInput = v.object({
  slug: v.pipe(v.string(), v.description('The product slug, e.g. "procore".')),
});

export type GetProductArgs = v.InferOutput<typeof GetProductInput>;

export async function getProduct(env: ApiCaller, args: GetProductArgs): Promise<JsonValue> {
  const result = await apiGetJson<JsonValue>(env, `/api/products/${pathSegment(args.slug)}`);
  if (!result.ok) {
    return { found: false, slug: args.slug, message: result.message };
  }
  return { found: true, product: result.data };
}

export const getProductTool = (env: ApiCaller) =>
  defineTool({
    name: 'get_product',
    description:
      'Fetch the full public record for one AECi product by slug: description, website, vendor, ' +
      'taxonomy (categories, audiences, phases, trades), review ratings, integration counts and ' +
      'the vendor-authored "how teams use it" narrative. Use find_products first if you do not ' +
      'already have a slug.',
    input: GetProductInput,
    async run({ data }) {
      return { output: await getProduct(env, data) };
    },
  });
