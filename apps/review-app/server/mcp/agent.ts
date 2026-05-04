// ---------------------------------------------------------------------------
// AeciReviewMcp — remote MCP server hosted by this Worker.
//
// Exposes CRUD-style tools for the three core domain entities:
//   • vendors      — list_vendors, get_vendor, create_vendor_and_research, update_vendor
//   • products     — list_products, get_product, create_product_and_research, update_product
//   • integrations — list_integrations, get_integration, create_integration, update_integration
//   • taxonomy     — list_taxonomy (categories / disciplines / project phases)
//
// `create_vendor_and_research` and `create_product_and_research` both seed a
// minimal Airtable row and spawn the matching enrichment orchestrator, then
// return the new record ID and the orchestrator run ID. All other tools are
// thin wrappers over the same Airtable + hydrate helpers used by the HTTP
// data API.
//
// Mounted at /mcp by index.ts. MCP_TOKEN auth is intentionally disabled today;
// see the TODO in index.ts.
// ---------------------------------------------------------------------------
import { McpAgent } from 'agents/mcp';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from '../env';
import { registerVendorTools } from './tools/vendor-tools';
import { registerProductTools } from './tools/product-tools';
import { registerIntegrationTools } from './tools/integration-tools';
import { registerTaxonomyTools } from './tools/taxonomy-tools';

// We don't pass our narrowed `Env` to McpAgent because its constraint
// (`extends Cloudflare.Env`) clashes with our `BROWSER` override. Cast at
// each use site instead so tools still get our typed bindings.
export class AeciReviewMcp extends McpAgent {
  server = new McpServer({ name: 'aeci-review-mcp', version: '2.0.0' });

  private getEnv = (): Env => this.env as unknown as Env;

  async init() {
    registerVendorTools(this.server, this.getEnv);
    registerProductTools(this.server, this.getEnv);
    registerIntegrationTools(this.server, this.getEnv);
    registerTaxonomyTools(this.server, this.getEnv);
  }
}
