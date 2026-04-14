# W-LinkedIn

Fetch LinkedIn company page URL and follower count. LinkedIn blocks direct scraping aggressively → use Apify.

## Purpose

Follower count is a robust market-presence proxy. LinkedIn URL is reused by W-CompanySize. Running this workflow before W-CompanySize enables the cheaper LinkedIn-based employee-count path.

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `linkedin_url` | URL | Company LinkedIn page URL (existing field, written here) |
| `linkedin_followers` | Number | Public follower count |
| `linkedin_checked_at` | DateTime | Always set |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

## Node flow

```
Trigger → Get Vendor Record → Normalize → Has Required?
                                               │ yes
                                               ▼
                              Already Have LinkedIn URL? (IF on existing field)
                             /                                \
                         Yes                                  No
                          │                                    │
                          │                        Claude: Infer LinkedIn URL
                          │                                    │
                          │                                    ▼
                          │                        Inferred? (IF)
                          │                       /              \
                          │                    Yes               No
                          │                     │                 │
                          ▼                     ▼                 ▼
                   Apify: Scrape LinkedIn   Apify: Scrape   Write Empty Result
                          │                     │                 │
                          └──────┬──────────────┘                 │
                                 ▼                                │
                          Parse Apify Response                    │
                                 │                                │
                                 ▼                                ▼
                          Update Vendor Record ◄──────────────────┘
                                 │
                                 ▼
                          Format Return Value
```

## Key nodes

### Already Have LinkedIn URL? (IF)

- Condition: `{{ $('Get Vendor Record').item.json.fields.linkedin_url }}` is not empty
- True → skip inference, use existing URL
- False → Claude inference

### Claude: Infer LinkedIn URL (Basic LLM Chain)

**Prompt:**
```
What is the most likely LinkedIn company page URL for '{{ $json.company_name }}' with domain '{{ $json.vendor_domain }}'?

The URL should be in the form https://www.linkedin.com/company/SLUG/ where SLUG is the company's LinkedIn handle.

Return JSON:
{
  "linkedin_url": "https://www.linkedin.com/company/SLUG/" | null,
  "confidence": "low" | "medium" | "high"
}

Return null if you can't confidently guess. Do not guess with low confidence — null is better than wrong.
```

**Output schema example:**
```json
{
  "linkedin_url": "https://www.linkedin.com/company/autodesk/",
  "confidence": "high"
}
```

### Inferred? (IF)

- Condition: `linkedin_url` is not null AND confidence is not "low"
- True → Apify
- False → Write Empty Result

### Apify: Scrape LinkedIn Company Page (HTTP Request)

n8n has an Apify node, but the HTTP method gives more control. Call the Apify Run-Sync API:

- **Method:** POST
- **URL:** `https://api.apify.com/v2/acts/{ACTOR_ID}/run-sync-get-dataset-items?token={{ $credentials.apifyApi.token }}`
- Actor: use a current LinkedIn company scraper actor (check Apify Store for an up-to-date one — e.g., `curious_coder/linkedin-company-profile-scraper` or `dev_fusion/linkedin-company-scraper`)
- **Body (JSON):** depends on chosen actor; typically:
  ```json
  {
    "urls": ["{{ $json.linkedin_url }}"],
    "proxy": { "useApifyProxy": true }
  }
  ```
- **Timeout:** 120s (Apify actors can be slow)

**Important:** verify actor input schema before using — Apify Store actors vary in their input format.

### Parse Apify Response (Code)

Apify returns an array of result objects. Field names vary by actor, so this is defensive:

```javascript
const results = $input.all().map(i => i.json);
const context = $('Normalize Input').item.json;
const linkedinUrl = $('Claude: Infer LinkedIn URL').item?.json?.output?.linkedin_url
  || $('Get Vendor Record').item.json.fields.linkedin_url;

// Find first result with follower data
let followers = null;
for (const r of results.flat()) {
  const f = r?.followerCount ?? r?.followers ?? r?.followersCount
         ?? r?.organization?.followerCount;
  if (typeof f === 'number' && f >= 0) {
    followers = f;
    break;
  }
}

return {
  record_id: context.record_id,
  linkedin_url: linkedinUrl,
  linkedin_followers: followers,
  linkedin_checked_at: new Date().toISOString(),
  status: followers !== null ? 'success' : 'partial',
  fields_updated: followers !== null
    ? ['linkedin_url','linkedin_followers','linkedin_checked_at']
    : ['linkedin_url','linkedin_checked_at'],
  note: followers === null ? 'Apify returned no follower data' : null
};
```

### Write Empty Result (Code)

```javascript
const context = $('Normalize Input').item.json;
return {
  record_id: context.record_id,
  linkedin_url: null,
  linkedin_followers: null,
  linkedin_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['linkedin_checked_at'],
  note: 'No LinkedIn URL could be inferred'
};
```

## Error handling

- Apify timeout or 5xx → caught by W-ErrorHandler as http_error
- Apify returns empty dataset → parse sets followers=null, status=partial, `needs_manual_review=true` (orchestrator can pick this up)

## Test plan

| Vendor | Expected |
|---|---|
| Autodesk | ~1M+ followers |
| Procore | ~300K+ followers |
| Bluebeam | ~30-60K followers |
| Small vendor with no LinkedIn | Graceful null, status=success, note set |

## Cost

- Claude inference: $0.002 per vendor without existing LinkedIn URL
- Apify: ~$0.005 per successful scrape

Total for 1,000 vendors: ~$7.
