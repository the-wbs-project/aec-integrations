# W-BlogRecency

Find when the vendor last posted to their blog. Signals marketing-team activity — a stale blog (>180 days) correlates with dormant companies that are poor outreach targets.

## Purpose

Combined with W-Press, this distinguishes "active but quiet" (blog fresh, press light — small but engaged) from "actually dormant" (blog stale AND press silent — skip outreach).

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `blog_url` | URL | Discovered blog URL |
| `blog_last_post_date` | Date | Date of most recent post |
| `blog_last_post_days_ago` | Number | Days since most recent post |
| `blog_checked_at` | DateTime | Always set |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

## Node flow

```
Trigger → Get Vendor Record → Normalize → Has Required?
                                              │ yes
                                              ▼
                                Build Candidate Blog URLs
                                              │
                                              ▼
                                HTTP Check (loop, continue-on-fail)
                                              │
                                              ▼
                                Pick First Valid (Code)
                                              │
                                              ▼
                                Blog Found? (IF)
                               /                \
                            Yes                  No
                             │                    │
                             ▼                    ▼
                     Claude: Extract     Write Empty Result
                     Latest Post Date           │
                             │                  │
                             └────────┬─────────┘
                                      ▼
                            Update Vendor Record
                                      │
                                      ▼
                            Format Return Value
```

## Candidate paths

Try in this order — subdomain first, then paths:

```javascript
const candidates = [
  `https://blog.${vendor_domain}`,
  `https://news.${vendor_domain}`,
  `https://${vendor_domain}/blog`,
  `https://${vendor_domain}/news`,
  `https://${vendor_domain}/resources/blog`,
  `https://${vendor_domain}/company/blog`,
  `https://${vendor_domain}/insights`,
  `https://${vendor_domain}/blog/all`,
  `https://${vendor_domain}/resources`
];
```

## Key nodes

### Build Candidate Blog URLs (Code)

```javascript
const context = $('Normalize Input').item.json;
const d = context.vendor_domain;

const candidates = [
  `https://blog.${d}`,
  `https://news.${d}`,
  `https://${d}/blog`,
  `https://${d}/news`,
  `https://${d}/resources/blog`,
  `https://${d}/company/blog`,
  `https://${d}/insights`,
  `https://${d}/blog/all`,
  `https://${d}/resources`
];

return candidates.map(url => ({
  json: { ...context, candidate_url: url }
}));
```

### HTTP Check (loop, continue-on-fail)

Same HTTP conventions. Return body + statusCode. Keep body size cap high — blog listings can be longer than other pages.

### Pick First Valid (Code)

Filter to first 200 response with body > 2KB:

```javascript
const responses = $input.all().map(i => i.json);
const context = $('Normalize Input').item.json;

const valid = responses.find(r =>
  r.statusCode === 200 &&
  typeof r.body === 'string' &&
  r.body.length > 2000
);

if (!valid) {
  return { ...context, blog_found: false };
}

// Strip scripts/styles
const cleanHtml = valid.body
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .substring(0, 15000);

return {
  ...context,
  blog_found: true,
  blog_url: valid.url || valid.request?.url || null,
  blog_html: cleanHtml
};
```

### Claude: Extract Latest Post Date (Basic LLM Chain — Haiku)

**Prompt:**
```
This is the HTML of a blog or news listing page from {{ $json.blog_url }}.

Find the date of the most recent blog post visible on this page. Most blog listings show post dates next to each post title. Look for the newest date.

HTML:
{{ $json.blog_html }}

Return JSON:
{
  "latest_post_date": "YYYY-MM-DD" | null,
  "confidence": "low" | "medium" | "high",
  "notes": "brief"
}

If no post dates are visible on the page (some blogs hide them until you click through), return null and confidence=low. Do not guess dates from the page's copyright year or other non-post metadata.
```

**Output schema example:**
```json
{
  "latest_post_date": "2026-04-01",
  "confidence": "high",
  "notes": "dates clearly labelled next to each post"
}
```

### Compute Days Ago & Build Result (Code)

```javascript
const parsed = $input.item.json.output || $input.item.json;
const context = $('Pick First Valid').item.json;

let dateStr = null;
let daysAgo = null;

if (parsed.latest_post_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.latest_post_date)) {
  dateStr = parsed.latest_post_date;
  const d = new Date(dateStr + 'T00:00:00Z').getTime();
  if (!isNaN(d)) {
    daysAgo = Math.floor((Date.now() - d) / 86400000);
    // Sanity: clamp negative (future dates) to 0, cap at 3650
    if (daysAgo < 0) daysAgo = 0;
    if (daysAgo > 3650) daysAgo = 3650;
  }
}

const low = parsed.confidence === 'low';

return {
  record_id: context.record_id,
  blog_url: context.blog_url,
  blog_last_post_date: dateStr,
  blog_last_post_days_ago: daysAgo,
  blog_checked_at: new Date().toISOString(),
  needs_manual_review: low && daysAgo === null,
  status: daysAgo !== null ? 'success' : 'partial',
  fields_updated: daysAgo !== null
    ? ['blog_url','blog_last_post_date','blog_last_post_days_ago','blog_checked_at']
    : ['blog_url','blog_checked_at'],
  note: parsed.notes || null
};
```

### Write Empty Result (Code)

```javascript
const context = $('Normalize Input').item.json;
return {
  record_id: context.record_id,
  blog_url: null,
  blog_last_post_date: null,
  blog_last_post_days_ago: null,
  blog_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['blog_checked_at'],
  note: 'No blog found at common paths'
};
```

## Test plan

| Vendor | Expected |
|---|---|
| Procore | Active blog, `days_ago` < 30 |
| Autodesk | Active, likely multiple blog subdomains (pick first valid) |
| Bluebeam | Active |
| Small niche vendor | Might have no blog → empty result |
| Vendor with a blog that stopped posting 2 years ago | `days_ago` ~730, signals dormant marketing |

## Cost

- One Claude Haiku call per blog found: ~$0.002
- HTTP checks: free
- Total: ~$1.50 per 1,000 vendors (not all have blogs)
