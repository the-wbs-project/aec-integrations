"""Trim the raw production reads for mock-up 10 into 10-data.json.

Usage: python3 -I 10-snapshot.py <raw-dir> <out-file>

<raw-dir> holds the raw responses read on 2026-11-16 (not committed):
  products.json        GET /api/products?per_page=24
  facets.json          GET /api/products/facets
  categories.json      GET /api/categories
  cat-products.json    GET /api/products?per_page=24&category_id=<accounting-erp>
  cat-facets.json      GET /api/products/facets?category_id=<accounting-erp>
  empty-facets.json    GET /api/products/facets?category_id=<accounting-erp>&trade_id=<roofing>
  alg-procore24.json   Algolia production_products_created_desc, query "procore", 24 hits
  alg-procore.json     Algolia products and production_vendors_name_asc, query "procore"
All are public reads: the API the site's own pages call, and the search-only key every
browser receives. Only the fields the mock-up draws are kept.
"""

import json
import sys
from pathlib import Path

raw = Path(sys.argv[1])
out_file = Path(sys.argv[2])


def load(name):
    return json.loads((raw / name).read_text())


def prod(p):
    return {
        "name": p["name"],
        "vendor": (p.get("vendor") or {}).get("name"),
        "role": p["product_role"],
        "integrations": p["integration_count"],
        "reviews": p["review_count"],
        "rating": p["rating_overall_avg"],
    }


def facet(terms):
    return [[t["name"], t["product_count"]] for t in terms]


P = load("products.json")
C = load("cat-products.json")
F = load("facets.json")
CF = load("cat-facets.json")
EF = load("empty-facets.json")
cats = load("categories.json")["data"]
A = load("alg-procore24.json")["results"][0]
A1 = load("alg-procore.json")["results"]
acc = next(c for c in cats if c["slug"] == "accounting-erp")

out = {
    "_source": (
        "Read on 2026-11-16 from production: GET /api/products, /api/products/facets and "
        "/api/categories (public), and the public search-only Algolia key for /search?q=procore."
    ),
    "products": {"total": P["total"], "sort": "created", "items": [prod(p) for p in P["data"]]},
    "products_facets": {k: facet(v) for k, v in F.items()},
    "category": {
        "slug": "accounting-erp",
        "name": acc["name"],
        "description": acc["description"],
        "total": C["total"],
        "items": [prod(p) for p in C["data"]],
    },
    "category_facets": {k: facet(v) for k, v in CF.items() if k != "categories"},
    "empty_filters": {
        "category": "Accounting & ERP",
        "trade": "Roofing",
        "total": 0,
        "facets": {k: facet(v) for k, v in EF.items()},
    },
    "categories_index": [
        {
            "name": c["name"],
            "slug": c["slug"],
            "description": c["description"],
            "products": c["product_count"],
            "integrations": c["integration_count"],
        }
        for c in cats
    ],
    "search": {
        "query": "procore",
        "products_total": A["nbHits"],
        "vendors_total": A1[1]["nbHits"],
        "sort": "created",
        "items": [
            {
                "name": h["name"],
                "vendor": h.get("vendor_name"),
                "role": h.get("product_role") or "application",
                "integrations": h.get("integration_count", 0),
                "reviews": h.get("review_count", 0),
                "rating": h.get("rating_overall_avg"),
            }
            for h in A["hits"]
        ],
        "facets": {
            k: [[n, c] for n, c in v.items()]
            for k, v in A["facets"].items()
            if k != "integration_count"
        },
    },
}
out_file.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
