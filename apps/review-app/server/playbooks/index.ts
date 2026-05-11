// ---------------------------------------------------------------------------
// Playbook registry — every markdown file under /playbooks/ that the prompt
// library should expose to the founder via /api/playbooks.
//
// .md files are bundled as raw strings at build time by the Wrangler `Text`
// rule (wrangler.jsonc → rules). Each entry below static-imports one file,
// parses its YAML frontmatter inline, and exports a {slug, frontmatter, body}
// triple. Add a new playbook by dropping a .md into /playbooks/ and adding
// one line to PLAYBOOK_FILES.
// ---------------------------------------------------------------------------
import researchProducts from '../../../../playbooks/research-products.md';
import researchVendors from '../../../../playbooks/research-vendors.md';
import addVendorAndProducts from '../../../../playbooks/add-vendor-and-products.md';
import enrichVendor from '../../../../playbooks/enrich-vendor.md';
import enrichProduct from '../../../../playbooks/enrich-product.md';
import discoverProductIntegrations from '../../../../playbooks/discover-product-integrations.md';
import discoverVendorProducts from '../../../../playbooks/discover-vendor-products.md';

interface PlaybookFrontmatter {
  title: string;
  description: string;
  scope_label: string | null;
  scope_placeholder: string | null;
}

export interface Playbook {
  slug: string;
  frontmatter: PlaybookFrontmatter;
  body: string;
}

const PLAYBOOK_FILES: ReadonlyArray<{ slug: string; raw: string }> = [
  { slug: 'research-products', raw: researchProducts },
  { slug: 'research-vendors', raw: researchVendors },
  { slug: 'add-vendor-and-products', raw: addVendorAndProducts },
  { slug: 'enrich-vendor', raw: enrichVendor },
  { slug: 'enrich-product', raw: enrichProduct },
  { slug: 'discover-product-integrations', raw: discoverProductIntegrations },
  { slug: 'discover-vendor-products', raw: discoverVendorProducts },
];

/**
 * Parse the leading `---\n…\n---\n` YAML block out of a markdown file. Only
 * supports the flat key: value shape we use in our playbook frontmatter —
 * no nested objects, lists, multiline scalars, or quoting beyond surrounding
 * single/double quotes. Throws if the block is missing or malformed so a
 * misauthored playbook fails the build instead of silently shipping with an
 * empty title.
 */
function parseFrontmatter(slug: string, raw: string): { frontmatter: PlaybookFrontmatter; body: string } {
  if (!raw.startsWith('---\n')) {
    throw new Error(`Playbook "${slug}" is missing YAML frontmatter (must start with --- on line 1).`);
  }
  const end = raw.indexOf('\n---\n', 4);
  if (end === -1) {
    throw new Error(`Playbook "${slug}" has an unterminated frontmatter block.`);
  }
  const block = raw.slice(4, end);
  const body = raw.slice(end + 5);

  const fields: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value;
  }

  const title = fields['title'];
  const description = fields['description'];
  if (!title || !description) {
    throw new Error(`Playbook "${slug}" frontmatter must include title and description.`);
  }

  const scopeLabelRaw = fields['scope_label'] ?? '';
  const scope_label = scopeLabelRaw && scopeLabelRaw.toLowerCase() !== 'none' ? scopeLabelRaw : null;
  const scope_placeholder = scope_label ? fields['scope_placeholder'] ?? null : null;

  return {
    frontmatter: { title, description, scope_label, scope_placeholder },
    body,
  };
}

export const PLAYBOOKS: ReadonlyArray<Playbook> = PLAYBOOK_FILES.map(({ slug, raw }) => {
  const { frontmatter, body } = parseFrontmatter(slug, raw);
  return { slug, frontmatter, body };
});

export function getPlaybook(slug: string): Playbook | undefined {
  return PLAYBOOKS.find((p) => p.slug === slug);
}

export interface RenderArgs {
  scope?: string;
  targetRecordId?: string;
  aspect?: string;
  forceRefresh?: boolean;
}

const INVOCATION_ANCHOR = '**This invocation:**';

/**
 * Render the final markdown the dispatcher hands to a sub-agent.
 *
 * Two emission modes share the same `**This invocation:**` anchor at the end
 * of every playbook body:
 *
 * - Legacy `/prompts`-page path: caller passes a string `scope` (or nothing).
 *   The renderer appends a single `**<scope_label>:** <scope>` line so older
 *   playbooks that read free-text scope keep working unchanged.
 *
 * - Structured-args path: caller passes a {targetRecordId, aspect,
 *   forceRefresh, scope?} object. The renderer emits a bullet list under the
 *   anchor:
 *
 *     - target_record_id: rec0123ABCDEF
 *     - aspect: marketplace
 *     - force_refresh: false
 *     - scope: <free text>
 *
 *   Empty fields are omitted. Button-triggered queue jobs use this path so
 *   playbooks parse args from a stable shape instead of fragile prose.
 */
export function renderPlaybookPrompt(
  playbook: Playbook,
  argsOrScope: RenderArgs | string = {},
): string {
  const args: RenderArgs =
    typeof argsOrScope === 'string' ? { scope: argsOrScope } : argsOrScope;

  const hasStructured =
    args.targetRecordId !== undefined ||
    args.aspect !== undefined ||
    args.forceRefresh !== undefined;

  if (!hasStructured) {
    if (playbook.frontmatter.scope_label === null) return playbook.body;
    return `${playbook.body.trimEnd()}\n\n**${playbook.frontmatter.scope_label}:** ${args.scope ?? ''}\n`;
  }

  const lines: string[] = [];
  if (args.targetRecordId) lines.push(`- target_record_id: ${args.targetRecordId}`);
  if (args.aspect) lines.push(`- aspect: ${args.aspect}`);
  if (args.forceRefresh !== undefined) lines.push(`- force_refresh: ${args.forceRefresh}`);
  const scope = args.scope?.trim();
  if (scope) lines.push(`- scope: ${scope}`);

  return `${playbook.body.trimEnd()}\n\n${lines.join('\n')}\n`;
}

/**
 * Recover structured invocation args from a rendered prompt. Queue metadata
 * lives in the prompt body so the Airtable table can stay on the minimal
 * dispatcher schema.
 */
export function parseRenderedPlaybookArgs(prompt: string): RenderArgs {
  const anchorIndex = prompt.lastIndexOf(INVOCATION_ANCHOR);
  if (anchorIndex === -1) return {};

  const args: RenderArgs = {};
  const tail = prompt.slice(anchorIndex + INVOCATION_ANCHOR.length);
  for (const line of tail.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*(target_record_id|aspect|force_refresh|scope):\s*(.*?)\s*$/);
    if (!match) continue;

    const [, key, value] = match;
    if (key === 'target_record_id' && /^rec[A-Za-z0-9]{14}$/.test(value)) {
      args.targetRecordId = value;
    } else if (key === 'aspect' && value) {
      args.aspect = value;
    } else if (key === 'force_refresh') {
      if (value === 'true') args.forceRefresh = true;
      if (value === 'false') args.forceRefresh = false;
    } else if (key === 'scope' && value) {
      args.scope = value;
    }
  }

  return args;
}
