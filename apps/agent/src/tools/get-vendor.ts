/**
 * `get_vendor` — the public vendor detail record, fetched from the API Worker.
 *
 * Same contract as `get_product`: `GET /api/vendors/:slug` owns the allowlist,
 * so `vendors.contact_email`, `vendors.admin_notes` and the VQS score columns
 * cannot reach the model through this tool. See `src/lib/api-client.ts`.
 */
import { defineTool, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';

import { apiGetJson, pathSegment, type ApiCaller } from '../lib/api-client';

export const GetVendorInput = v.object({
  slug: v.pipe(v.string(), v.description('The vendor slug, e.g. "autodesk".')),
});

export type GetVendorArgs = v.InferOutput<typeof GetVendorInput>;

export async function getVendor(env: ApiCaller, args: GetVendorArgs): Promise<JsonValue> {
  const result = await apiGetJson<JsonValue>(env, `/api/vendors/${pathSegment(args.slug)}`);
  if (!result.ok) {
    return { found: false, slug: args.slug, message: result.message };
  }
  return { found: true, vendor: result.data };
}

export const getVendorTool = (env: ApiCaller) =>
  defineTool({
    name: 'get_vendor',
    description:
      'Fetch the full public record for one AECi vendor (software company) by slug: description, ' +
      'website, headquarters, founding year, social links, verification status, and its product and ' +
      'integration counts. Takes a vendor slug, not a company name.',
    input: GetVendorInput,
    async run({ data }) {
      return { output: await getVendor(env, data) };
    },
  });
