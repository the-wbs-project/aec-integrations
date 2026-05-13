# AEC Integrations — Authorization Model & RLS Policies

**Referenced by:** `STAGE_1_SPEC.md` §8 (Authentication), §15 (Security), §22 (Content Moderation), §26 (Audit Trail)
**Version:** 0.1 (placeholder — full definition pending dedicated session)
**Date:** May 2026

---

## Status

This document is a **placeholder**. The full authorization model and RLS policy definitions will be developed in a dedicated session.

The intent of this document, when completed, is to be the source of truth for:

- Role definitions (`reviewer`, `admin`, `vendor_admin`)
- Permission matrix (who can read/write/delete what)
- Supabase Row-Level Security policies per table
- Service role bypass rules and discipline
- Banned user enforcement
- Vendor scope enforcement (Stage 2+)
- GDPR right-to-erasure interaction with RLS
- Test patterns for verifying RLS policies

## Why this matters

Per `STAGE_1_SPEC.md` discussions, RLS is **defense in depth** alongside Worker-level authorization. The decision is to set it up early (Phase 2) rather than retrofit later. The cost of doing it right is hours; the cost of retrofitting is weeks.

## Pending items

1. Role enumeration and capabilities per role
2. RLS policies for each Stage 1 table:
   - Public read tables: products, vendors, integrations, taxonomy, approved reviews
   - Authenticated write tables: reviews (insert), pending reviews (update own), profiles (update own)
   - Admin-only tables: audit_log, workflow_instances, workflow_transitions, page_views, vendor_requests, stats_cache
3. Service role usage policy (when the API Worker may bypass RLS and when it must not)
4. Vendor scope rules for Stage 2 vendor portal access
5. Banned user behavior (insert rejection vs silent succeed)
6. Test patterns and fixtures for RLS verification

## Cross-references

- Schema definitions: `STAGE_1_SPEC.md` §5
- Authentication flow: `STAGE_1_SPEC.md` §8
- Audit trail: `STAGE_1_SPEC.md` §26
