// ---------------------------------------------------------------------------
// JSON-LD extraction. Most enterprise sites embed structured data in
// <script type="application/ld+json"> blocks; the Organization schema in
// particular gives us foundingDate, address, parentOrganization, and sameAs
// links — the core fields vendor research has to chase via web search today.
//
// Tool research benefits from the SoftwareApplication schema (applicationCategory,
// applicationSubCategory) which maps closely to our taxonomy axes.
// ---------------------------------------------------------------------------

const JSONLD_BLOCK_RE =
  /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/**
 * Parse all JSON-LD blocks from a document body. Each block can be a single
 * object, an array of objects, or contain @graph nesting; we flatten to a
 * list of dictionaries for downstream type filtering.
 */
export function extractJsonLd(html: string): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;
  while ((match = JSONLD_BLOCK_RE.exec(html))) {
    const raw = match[1].trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some sites concatenate multiple JSON objects in one block; bail.
      continue;
    }
    flattenInto(parsed, items);
  }
  return items;
}

function flattenInto(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const n of node) flattenInto(n, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const dict = node as Record<string, unknown>;
  const graph = dict['@graph'];
  if (Array.isArray(graph)) {
    for (const n of graph) flattenInto(n, out);
  }
  out.push(dict);
}

/** Match `@type` against a name (or any of a list). Some pages set @type to an array. */
function isType(node: Record<string, unknown>, names: string[]): boolean {
  const t = node['@type'];
  if (typeof t === 'string') return names.includes(t);
  if (Array.isArray(t)) return t.some((x) => typeof x === 'string' && names.includes(x));
  return false;
}

export interface OrganizationLd {
  name?: string;
  url?: string;
  description?: string;
  foundingDate?: string;
  address?: string;
  parentOrganization?: string;
  sameAs?: string[];
}

/**
 * Find the first Organization-typed JSON-LD block and extract the fields we
 * actually use in vendor research. Address is collapsed to a single string
 * (city + country) using the `addressLocality` / `addressCountry` keys.
 */
export function pickOrganization(items: Record<string, unknown>[]): OrganizationLd | null {
  for (const node of items) {
    if (!isType(node, ['Organization', 'Corporation', 'LocalBusiness', 'NewsMediaOrganization'])) {
      continue;
    }
    const name = stringField(node, 'name');
    const url = stringField(node, 'url');
    const description = stringField(node, 'description');
    const foundingDate = stringField(node, 'foundingDate');
    const address = formatAddress(node['address']);
    const parentOrganization = orgNameField(node['parentOrganization']);
    const sameAs = stringArrayField(node['sameAs']);
    return { name, url, description, foundingDate, address, parentOrganization, sameAs };
  }
  return null;
}

export interface SoftwareApplicationLd {
  name?: string;
  url?: string;
  description?: string;
  applicationCategory?: string;
  applicationSubCategory?: string;
  operatingSystem?: string;
  publisher?: string;
}

export function pickSoftwareApplication(
  items: Record<string, unknown>[],
): SoftwareApplicationLd | null {
  for (const node of items) {
    if (!isType(node, ['SoftwareApplication', 'WebApplication', 'MobileApplication'])) {
      continue;
    }
    return {
      name: stringField(node, 'name'),
      url: stringField(node, 'url'),
      description: stringField(node, 'description'),
      applicationCategory: stringField(node, 'applicationCategory'),
      applicationSubCategory: stringField(node, 'applicationSubCategory'),
      operatingSystem: stringField(node, 'operatingSystem'),
      publisher: orgNameField(node['publisher']),
    };
  }
  return null;
}

function stringField(node: Record<string, unknown>, key: string): string | undefined {
  const v = node[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const arr = value.filter((x): x is string => typeof x === 'string' && x.length > 0);
    return arr.length > 0 ? arr : undefined;
  }
  return undefined;
}

function orgNameField(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const n = (value as Record<string, unknown>)['name'];
    if (typeof n === 'string' && n.length > 0) return n;
  }
  return undefined;
}

function formatAddress(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const a = value as Record<string, unknown>;
  const locality = typeof a['addressLocality'] === 'string' ? (a['addressLocality'] as string) : '';
  const region = typeof a['addressRegion'] === 'string' ? (a['addressRegion'] as string) : '';
  const country = typeof a['addressCountry'] === 'string'
    ? (a['addressCountry'] as string)
    : (() => {
        const c = a['addressCountry'];
        if (c && typeof c === 'object') {
          const n = (c as Record<string, unknown>)['name'];
          return typeof n === 'string' ? n : '';
        }
        return '';
      })();
  const parts = [locality, region, country].filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(', ') : undefined;
}
