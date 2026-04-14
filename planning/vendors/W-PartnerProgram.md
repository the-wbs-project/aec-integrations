# W-PartnerProgram

Detect whether a vendor has a **formal partner program** (with tiers, application process, benefits) and/or an **affiliate/referral program**. Distinct from W-IntegrationPage, which detects a listing of existing integrations.

## Purpose

A formal partner program signals outreach readiness — the vendor already has infrastructure and personnel for third-party relationships. Strong positive signal for affiliate revenue opportunities. An affiliate program separately signals willingness to pay for referrals, useful for future monetization.

## Airtable fields written

| Field | Type | Description |
|---|---|---|
| `has_partner_program` | Checkbox | True only if formal program (tiered/applicable), not just a partner list |
| `partner_program_url` | URL | Matched URL |
| `has_affiliate_program` | Checkbox | True if affiliate/referral program exists |
| `affiliate_program_url` | URL | Matched URL |
| `partner_program_checked_at` | DateTime | Always set |

## Input

```json
{ "record_id": "recXXXXXXXXXXXXXX" }
```

## Node flow

```
Trigger → Get Vendor Record → Normalize → Has Required?
                                               │ yes
                                               ▼
                                Build Candidate URLs (partner + affiliate variants)
                                               │
                                               ▼
                                     HTTP Check Each (loop, continue-on-fail)
                                               │
                                               ▼
                                     Classify Matches (Code)
                                               │
                                               ▼
                                  Any Partner Page Found?
                                 /                        \
                              Yes                          No
                               │                            │
                               ▼                            │
                    Claude: Is It a Formal Program?         │
                               │                            │
                               ▼                            ▼
                         Build Result ──────────► Update Vendor Record
                                                          │
                                                          ▼
                                                Format Return Value
```

## Candidate paths

Two groups, checked separately:

```javascript
const partnerPaths = [
  '/partners',
  '/partner-program',
  '/partnerships',
  '/become-a-partner',
  '/channel-partners',
  '/reseller',
  '/resellers'
];

const affiliatePaths = [
  '/affiliate',
  '/affiliates',
  '/affiliate-program',
  '/referral',
  '/referrals',
  '/referral-program'
];
```

## Key nodes

### Build Candidate URLs (Code)

```javascript
const context = $('Normalize Input').item.json;
const partnerPaths = ['/partners','/partner-program','/partnerships','/become-a-partner','/channel-partners','/reseller','/resellers'];
const affiliatePaths = ['/affiliate','/affiliates','/affiliate-program','/referral','/referrals','/referral-program'];

const all = [
  ...partnerPaths.map(p => ({ kind: 'partner', path: p })),
  ...affiliatePaths.map(p => ({ kind: 'affiliate', path: p }))
];

return all.map(x => ({
  json: {
    ...context,
    candidate_kind: x.kind,
    candidate_url: `https://${context.vendor_domain}${x.path}`
  }
}));
```

### HTTP Check Each

Same as W-IntegrationPage — `continueOnFail=true`, `neverError=true`, `fullResponse=true`.

### Classify Matches (Code)

Find first 200 response per kind:

```javascript
const responses = $input.all().map(i => i.json);
const context = $('Normalize Input').item.json;

const partnerMatch = responses.find(r =>
  r.statusCode === 200 &&
  typeof r.body === 'string' &&
  r.body.length > 2000 &&
  r.candidate_kind === 'partner'
);

const affiliateMatch = responses.find(r =>
  r.statusCode === 200 &&
  typeof r.body === 'string' &&
  r.body.length > 2000 &&
  r.candidate_kind === 'affiliate'
);

// Clean HTML for Claude
function clean(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .substring(0, 8000);
}

return {
  ...context,
  partner_page_found: !!partnerMatch,
  partner_page_url: partnerMatch?.url || null,
  partner_page_html: partnerMatch ? clean(partnerMatch.body) : null,
  affiliate_page_found: !!affiliateMatch,
  affiliate_page_url: affiliateMatch?.url || null,
  affiliate_page_html: affiliateMatch ? clean(affiliateMatch.body) : null,
  any_page_found: !!(partnerMatch || affiliateMatch)
};
```

### Any Page Found? (IF)

Branch: `{{ $json.any_page_found }}` true → Claude; false → Write Empty.

### Claude: Is It a Formal Program? (Basic LLM Chain)

**Prompt:**
```
Vendor: {{ $json.company_name }} ({{ $json.vendor_domain }})

I found two potential pages. Classify each:
- A "formal partner program" has tiers (Gold/Silver), application process, partner benefits, or "become a partner" CTA. A page that just lists existing partners does NOT count as a formal program.
- An "affiliate program" offers commission/revenue share for referrals.

Partner page ({{ $json.partner_page_url }}):
{{ $json.partner_page_html }}

Affiliate page ({{ $json.affiliate_page_url }}):
{{ $json.affiliate_page_html }}

Return JSON:
{
  "is_formal_partner_program": true | false,
  "partner_has_application": true | false,
  "is_affiliate_program": true | false,
  "confidence": "low" | "medium" | "high",
  "notes": "brief"
}

If a page is null/empty, set its boolean false.
```

**Output schema example:**
```json
{
  "is_formal_partner_program": true,
  "partner_has_application": true,
  "is_affiliate_program": false,
  "confidence": "high",
  "notes": "tiered program with apply button"
}
```

### Build Result (Code)

```javascript
const parsed = $input.item.json.output || $input.item.json;
const classified = $('Classify Matches').item.json;

return {
  record_id: classified.record_id,
  has_partner_program: parsed.is_formal_partner_program === true && parsed.confidence !== 'low',
  partner_program_url: parsed.is_formal_partner_program ? classified.partner_page_url : null,
  has_affiliate_program: parsed.is_affiliate_program === true && parsed.confidence !== 'low',
  affiliate_program_url: parsed.is_affiliate_program ? classified.affiliate_page_url : null,
  partner_program_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['has_partner_program','partner_program_url','has_affiliate_program','affiliate_program_url','partner_program_checked_at']
};
```

### Write Empty Result (Code)

```javascript
const context = $('Normalize Input').item.json;
return {
  record_id: context.record_id,
  has_partner_program: false,
  partner_program_url: null,
  has_affiliate_program: false,
  affiliate_program_url: null,
  partner_program_checked_at: new Date().toISOString(),
  status: 'success',
  fields_updated: ['has_partner_program','has_affiliate_program','partner_program_checked_at'],
  note: 'No partner or affiliate pages found'
};
```

## Test plan

| Vendor | Expected |
|---|---|
| Procore | `has_partner_program=true` (well-known tiered program) |
| Autodesk | `has_partner_program=true` |
| Small open-source AEC tool | Both false |
| A vendor with a "/partners" page listing logos but no program | `has_partner_program=false` — validates Claude's filter |

## Cost

One Claude call per vendor that had any page match. ~$0.003/vendor. ~$2 per 1,000.
