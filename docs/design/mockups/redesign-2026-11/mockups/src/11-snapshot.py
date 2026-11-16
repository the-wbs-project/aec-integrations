"""Trim the raw production reads for mock-ups 11 and 12 into 11-data.json.

Usage: python3 -I 11-snapshot.py <raw-dir> <out-file>

<raw-dir> holds the raw responses read on 2026-11-16 (not committed):
  vd/autodesk.json         GET /api/vendors/autodesk          (unclaimed, 19 products)
  vd/rental-leak.json      GET /api/vendors/rental-leak       (claimed, vendor maintained)
  vendors-all.json         GET /api/vendors?page=1..11        (251 vendors, for the notes)
  vd/*.json                GET /api/vendors/:slug for all 251 (claim status survey only)
  pair-rl-qbo.json         GET /api/products/rental-leak/integrations/quickbooks-online
  pair-jobtread_qbo.json   GET /api/products/jobtread/integrations/quickbooks-online
All are public reads: the same API the site's own pages call. Only the fields the
mock-ups draw are kept. A logo is kept only where the API sends one, and the API
sends none for an unclaimed listing's products.
"""

import json
import sys
from collections import Counter
from pathlib import Path

raw = Path(sys.argv[1])
out_file = Path(sys.argv[2])
SITE = "https://www.aecintegrations.com"


def load(name):
    return json.loads((raw / name).read_text())


def absolute(url):
    if not url:
        return None
    return SITE + url if url.startswith("/") else url


def vendor(slug):
    v = load(f"vd/{slug}.json")
    return {
        "slug": v["slug"],
        "name": v["company_name"],
        "claim_status": v["claim_status"],
        # Only a claimed vendor's logo is drawn above 32px. The unclaimed one is not kept.
        "logo_url": absolute(v["logo_url"]) if v["claim_status"] == "claimed" else None,
        "description": v["description"],
        "website": v["website"],
        "social": {
            k: v[f"{k}_url"]
            for k in ("linkedin", "x", "youtube", "facebook", "instagram")
            if v.get(f"{k}_url")
        },
        "product_count": v["product_count"],
        "integration_count": v["integration_count"],
        "maintenance": v["maintenance"],
        "corrections": v["corrections"],
        "under_review": v.get("under_review") or [],
        "company_facts": v["company_facts"],
        "products": [
            {
                "name": p["name"],
                "slug": p["slug"],
                "logo_url": absolute(p["logo_url"]),
                "integrations": p["integration_count"],
                "reviews": p["review_count"],
                "rating": p["rating_overall_avg"],
            }
            for p in v["products"]
        ],
    }


def side(p):
    return {
        "name": p["name"],
        "slug": p["slug"],
        "claim_status": p["claim_status"],
        "logo_url": absolute(p["logo_url"]) if p["claim_status"] == "claimed" else None,
        "vendor": (p.get("vendor") or {}).get("name"),
        "vendor_slug": (p.get("vendor") or {}).get("slug"),
        "reviews": p["review_count"],
        "rating": p["rating_overall_avg"],
    }


def pair(name):
    d = load(name)
    mechs = []
    for m in d["mechanisms"]:
        mechs.append(
            {
                k: m[k]
                for k in (
                    "mechanism_kind",
                    "mechanism_name",
                    "direction",
                    "effective_direction",
                    "description",
                    "listing_url",
                    "docs_url",
                    "pricing_model",
                    "pricing_url",
                    "maturity",
                    "last_reviewed_at",
                    "vendor_links",
                    "origin",
                    "caption",
                    "corrections",
                )
            }
            | {
                "built_by_vendor": (m.get("built_by_vendor") or {}).get("name"),
                "built_by_vendor_slug": (m.get("built_by_vendor") or {}).get("slug"),
                "through": (m.get("via") or m.get("powered_by_product") or {}).get("name"),
                "claims": [
                    {
                        "data_object": c["data_object_name"],
                        "direction": c["direction"],
                        "agreement": c["agreement"],
                        "refuted": c.get("refuted", False),
                        "attestors": [a["attestor"] for a in c["attestations"] if a["asserted"]],
                    }
                    for c in m["claims"]
                ],
            }
        )
    return {
        "context": side(d["context_product"]),
        "other": side(d["other_product"]),
        "mechanisms": mechs,
        "sync_headline": d["sync_headline"],
        "maintenance": d["maintenance"],
        "version_diff": d["version_diff"],
    }


claims = Counter()
for f in (raw / "vd").glob("*.json"):
    claims[json.loads(f.read_text())["claim_status"]] += 1

out = {
    "_source": (
        "Read on 2026-11-16 from production through the public API the site's own pages "
        "call: GET /api/vendors/:slug and GET /api/products/:a/integrations/:b."
    ),
    "survey": {
        "vendors": len(load("vendors-all.json")),
        "claim_status": dict(claims),
        "vendors_with_no_products": sum(1 for v in load("vendors-all.json") if v["product_count"] == 0),
    },
    "vendors": {"autodesk": vendor("autodesk"), "rental-leak": vendor("rental-leak")},
    "pairs": {
        "rental-leak": pair("pair-rl-qbo.json"),
        "jobtread": pair("pair-jobtread_qbo.json"),
    },
}
out_file.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print("wrote", out_file)
