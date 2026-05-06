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

/**
 * Build the final markdown text the way the /prompts page would when the user
 * clicks Copy: trim trailing whitespace, then append `**<scope_label>:** <scope>`
 * if the playbook declares a scope label. The line is appended even when the
 * user left scope empty — playbooks themselves instruct the LLM to ask for a
 * scope when the line is blank.
 */
export function renderPlaybookPrompt(playbook: Playbook, scope: string): string {
  if (playbook.frontmatter.scope_label === null) return playbook.body;
  return `${playbook.body.trimEnd()}\n\n**${playbook.frontmatter.scope_label}:** ${scope}\n`;
}
