# ADR 0032: Logo uploads are validated, not transformed

- Status: Accepted
- Date: 2026-09-15
- Issue: AECI-955

## Decision

Store original validated PNG, JPEG and static WebP bytes in private R2 buckets. Reject SVG outright. Do not add a transformation service or decode/re-encode in the API Worker. The complete contract is STAGE_2_5_SPEC.md §11.

Identify format from magic bytes, validate container boundaries and dimensions, reject trailing data, and cap memory before parsing multipart. This is structural validation, not a claim to decode every pixel or remove metadata. PNG CRCs and the terminal chunk, JPEG marker/scan boundaries and terminal EOI, and WebP RIFF size/chunks must be checked. Animation is rejected.

Use SHA-256 content addressing and serve with hard-coded image Content-Type, nosniff, sandbox CSP and immutable caching. Client filenames and MIME types never decide paths or response headers. External HTTPS URLs are references only; the Worker never fetches them.

## Catalog ownership

Uploading does not write the catalog. Saving the parent form writes logo_url and logo_source with its audit row atomically. Null source remains upstream-owned. Vendor/admin choices, including removal, survive promote through SQL-time conditional logo assignment. Admin gains a narrow logo-only content write exception.

## Consequences

No extra image service, credentials or transformation cost. Original metadata remains in the published file. Unsupported formats require conversion by the uploader. Uploaded logos are public assets and the UI must say so. Unreferenced uploads remain until a reference-aware cleanup policy exists. Content-addressed assets cannot use age-only expiry because a live record may still reference them.

Revisit if supported formats, metadata removal, resizing or abuse response require full decoding and transformation.
