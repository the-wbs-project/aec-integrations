# W-Press

Count press releases / news mentions for the vendor in the last 12 months. Free — uses Google News RSS.

## Purpose

Press activity is a marketing-team-health signal. Vendors with 10+ mentions/year likely have an active PR function and are reachable for outreach. Zero mentions often means a dormant or very small company.

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `press_count_12mo` | Number | Count of mentions in last 12 months |
| `press_latest_date` | Date | Date of most recent mention |
| `press_checked_at` | DateTime | Always set |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

## Node flow

```
Trigger → Get Vendor Record → Normalize → Has Required?
                                              │ yes
                                              ▼
                               Is Name Distinctive? (Claude, cheap)
                                              │
                                              ▼
                              Build Google News Query
                                              │
                                              ▼
                              HTTP Request: Google News RSS
                                              │
                                              ▼
                              Parse XML (Code)
                                              │
                                              ▼
                              Filter + Count (Code)
                                              │
                                              ▼
                              Update Vendor Record
                                              │
                                              ▼
                              Format Return Value
```

## Key nodes

### Is Name Distinctive? (Basic LLM Chain — Haiku)

Some vendor names overlap with common words, people, or other companies. "Sage" returns results about SageMath, Sage the herb, etc.

**Prompt:**
```
Is '{{ $json.company_name }}' a distinctive company name, or does it overlap with common words, other companies, or unrelated entities?

Return JSON:
{
  "is_distinctive": true | false,
  "suggested_query": "query string"
}

If distinctive, suggested_query = company name in double quotes.
If ambiguous, suggested_query = company name in quotes plus a disambiguating qualifier that reflects the AEC/construction software context, e.g. "Sage construction software" or "Bentley Systems engineering".

Use quotes around the company name to force exact match.
```

**Output schema example:**
```json
{
  "is_distinctive": false,
  "suggested_query": "\"Sage\" construction software"
}
```

### Build Google News Query (Code)

```javascript
const parsed = $input.item.json.output || $input.item.json;
const context = $('Normalize Input').item.json;

const query = parsed.suggested_query || `"${context.company_name}"`;
const encoded = encodeURIComponent(query);

// when=1y filters to last 12 months
return {
  ...context,
  google_news_url: `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en&when=1y`,
  query_used: query
};
```

### HTTP Request: Google News RSS

- **Method:** GET
- **URL:** `={{ $json.google_news_url }}`
- Headers: User-Agent + Accept-Language
- **Continue on Fail:** true
- **Never Error:** true
- **Response Format:** Text (n8n XML Parse node handles it next)

### Parse XML (XML node or Code node)

n8n has a built-in XML node. Configure it to parse the RSS feed, which returns a structure like `{ rss: { channel: { item: [...] } } }`.

Alternatively, a Code node with regex parsing:

```javascript
const response = $input.item.json;
const xml = response.body || response.data || '';

// Extract <item> blocks
const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

const parsed = items.map(block => {
  const title = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
  const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
  return {
    title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(),
    pubDate: pubDate.trim(),
    source: source.trim()
  };
});

return {
  ...$('Build Google News Query').item.json,
  items: parsed
};
```

### Filter + Count (Code)

Apply heuristic false-positive filter: only count items whose title includes the vendor name.

```javascript
const input = $input.item.json;
const items = input.items || [];
const companyName = input.company_name.toLowerCase();
const domain = input.vendor_domain.toLowerCase().split('.')[0]; // just the root word

// Keep only items that mention the company name (or its domain root) in the title
const matched = items.filter(i =>
  i.title.toLowerCase().includes(companyName) ||
  i.title.toLowerCase().includes(domain)
);

// Parse dates
const dated = matched.map(i => {
  const d = new Date(i.pubDate);
  return { ...i, timestamp: d.getTime() };
}).filter(i => !isNaN(i.timestamp));

const latestTs = dated.length ? Math.max(...dated.map(i => i.timestamp)) : null;
const latestDate = latestTs ? new Date(latestTs).toISOString().substring(0, 10) : null;

return {
  record_id: input.record_id,
  press_count_12mo: matched.length,
  press_latest_date: latestDate,
  press_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['press_count_12mo','press_latest_date','press_checked_at']
};
```

## Edge cases

- **Zero mentions:** valid data, not an error. Write 0.
- **Google News rate limiting:** rare but possible. Handle in error workflow.
- **HTML entity encoding in titles:** doesn't affect matching significantly but noteworthy.

## Test plan

| Vendor | Expected |
|---|---|
| Procore | 50+ mentions |
| Autodesk | 200+ mentions |
| Bluebeam | 5-20 mentions |
| Small vendor | 0-3 mentions |
| A name with overlap (e.g., "Sage") | Claude qualifier applied; counts reasonable |

## Cost

- Claude Haiku distinctiveness check: $0.002 per vendor
- Google News RSS: free
- Total: ~$2 per 1,000 vendors. Fastest workflow in the set.
