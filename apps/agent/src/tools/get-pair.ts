/**
 * `get_pair` — the integration between two named products.
 *
 * ── THE ENDPOINT ─────────────────────────────────────────────────────────────
 * `GET /api/products/:slug/integrations/:otherSlug`
 * (`apps/api/src/routes/product-pair.ts`, mounted in `apps/api/src/index.ts`).
 * The first slug is the CONTEXT product: the response orients every direction
 * and every attestation to it, so swapping the two arguments is a different,
 * equally valid request rather than an error.
 *
 * ── WHY IT IS NOT A D1 QUERY ─────────────────────────────────────────────────
 * The pair payload is the most mapper-dense surface in the product, and it is
 * where AECI-779 leaked: `attestations.note` is curation-internal when
 * `source = 'aeci'`, and `readerFacingNote()` is the single rule that suppresses
 * it. Going through the shipped handler is how the agent inherits that rule
 * instead of re-deriving it. See `src/lib/api-client.ts`.
 *
 * A pair with no edge is a 200 with an empty mechanism list, not a 404 — so
 * "found" here means the route resolved, and the caller should read `mechanisms`
 * to decide whether an integration actually exists.
 */
import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

import { apiGetJson, pathSegment, type ApiCaller } from '../lib/api-client';

export const GetPairInput = v.object({
  slug: v.pipe(v.string(), v.description('The context product slug, e.g. "procore".')),
  otherSlug: v.pipe(v.string(), v.description('The other product slug, e.g. "sage-intacct".')),
});

export type GetPairArgs = v.InferOutput<typeof GetPairInput>;

export async function getPair(env: ApiCaller, args: GetPairArgs): Promise<JsonValue> {
  const path = `/api/products/${pathSegment(args.slug)}/integrations/${pathSegment(args.otherSlug)}`;
  const result = await apiGetJson<JsonValue>(env, path);
  if (!result.ok) {
    return { found: false, slug: args.slug, other_slug: args.otherSlug, message: result.message };
  }
  return { found: true, pair: result.data };
}

export const getPairTool = (env: ApiCaller) =>
  defineTool({
    name: 'get_pair',
    description:
      'Fetch what is known about the integration between two AECi products, by their two slugs: ' +
      'the delivery mechanisms, which data objects flow and in which direction, and who attested to ' +
      'each claim. The first slug is the context product and the answer is oriented to it. An empty ' +
      'mechanism list means no integration is on record between the two.',
    input: GetPairInput,
    async run({ data }) {
      return { output: await getPair(env, data) };
    },
  });
