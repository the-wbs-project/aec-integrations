/**
 * Re-anchor a mechanism row's claims into the opposite A/B frame (AECI-996).
 *
 * **Why a frame changes at all.** A claim's `direction` and its attestations'
 * `vendor_a` / `vendor_b` slots mean nothing on their own. They are read against the
 * two endpoints of the row the claim hangs from, and the two delivered-tier tables do
 * not agree on which endpoint is A:
 *
 *   - `integrations` — A is `source_product_id`, B is `target_product_id`
 *     (`STAGE_1_5_SPEC.md` §3.2).
 *   - `connector_evidenced_pairs` — A is `product_a_id`, the LOWER id of the two, by
 *     CHECK (`DATABASE_SCHEMA.md` §9a.6). The payload's source is B whenever its id
 *     sorts after the target's.
 *
 * Until AECI-996 every write path copied claims across that boundary unchanged, so
 * on a pair whose source sorts second every one-way claim pointed backwards and every
 * vendor slot named the wrong vendor. The product-detail reader has always assumed
 * the canonical frame (`toProductIntegrationItemFromEvidencedPair`).
 *
 * **What a flip is.** `a_to_b` ↔ `b_to_a` on every claim, and `vendor_a` ↔ `vendor_b`
 * on every attestation. `both` and `aeci` are their own mirrors.
 *
 * **Why it is not one UPDATE.** Two unique indexes stand in the way, and SQLite checks
 * uniqueness row by row, mid-statement:
 *
 *   - `claims_identity_key (anchor_id, data_object_id, direction)` — when a data object
 *     has BOTH one-way claims, flipping either collides with the other.
 *   - `attestations_slot_key (claim_id, source) WHERE retracted_at IS NULL` — when a
 *     claim has BOTH live vendor slots, flipping either collides with the other.
 *
 * Neither CHECK leaves room for a placeholder value. So on a collision the rows keep
 * their direction (or slot) and **swap contents in place** instead, which lands the
 * identical end state (operator ruling on AECI-996). Everything else flips directly.
 * Every emitted op is a single-row write whose target slot is free at the moment it
 * runs, so the plan is safe in any statement order the caller keeps.
 *
 * **Pure on purpose.** No runtime imports: promote renders the ops as Drizzle
 * statements, and the one-time repair under `scripts/ops/2026-09-evidenced-claim-
 * direction-repair/` imports this file directly (Node type stripping) and renders the
 * SAME ops as SQL text. One planner, two renderers — so the repair cannot drift from
 * the code path that prevents the defect recurring.
 */

/** The content a claim carries besides its identity. Swapped as a unit on collision. */
export interface ReframeClaimContent {
  origin: string;
  createdByVendorId: string | null;
  createdAt: string;
}

/** The content an attestation carries besides `id`, `claim_id`, `source` and `retracted_at`. */
export interface ReframeAttestationContent {
  asserted: boolean;
  introducedAt: string | null;
  deprecatedAt: string | null;
  introducedVersionId: string | null;
  deprecatedVersionId: string | null;
  attestedByVendorId: string | null;
  note: string | null;
  createdAt: string;
}

export interface ReframeAttestation extends ReframeAttestationContent {
  id: string;
  claimId: string;
  source: string;
  /** Every attestation, retracted ones included: a retracted slot is history and has to
   *  mean the same vendor after the flip as before it. */
  retractedAt: string | null;
}

export interface ReframeClaim extends ReframeClaimContent {
  id: string;
  dataObjectId: string;
  direction: string;
  attestations: ReframeAttestation[];
}

export type ReframeOp =
  | { kind: 'claim.direction'; claimId: string; from: string; to: string }
  | {
      kind: 'claim.content';
      claimId: string;
      /** The partner row this one traded contents with. */
      swappedWith: string;
      before: ReframeClaimContent;
      after: ReframeClaimContent;
    }
  | { kind: 'attestation.claim'; attestationId: string; from: string; to: string }
  | {
      kind: 'attestation.content';
      attestationId: string;
      swappedWith: string;
      before: ReframeAttestationContent;
      after: ReframeAttestationContent;
    }
  | { kind: 'attestation.source'; attestationId: string; from: string; to: string };

export interface ReframePlan {
  /** In execution order: claim writes, then attestation moves and swaps, then slot flips. */
  ops: ReframeOp[];
  /** The claims as they stand once every op has run — what a later reader of the same
   *  batch (promote's claim ingest) must match against. */
  after: ReframeClaim[];
  /** Every collision resolved by a content swap, for the operator's report. */
  collisions: ReframeCollision[];
}

export type ReframeCollision =
  | { kind: 'claim'; dataObjectId: string; claimIds: [string, string] }
  | { kind: 'attestation'; claimId: string; attestationIds: [string, string] };

export function flipClaimDirection(direction: string): string {
  if (direction === 'a_to_b') return 'b_to_a';
  if (direction === 'b_to_a') return 'a_to_b';
  return direction;
}

export function flipAttestationSource(source: string): string {
  if (source === 'vendor_a') return 'vendor_b';
  if (source === 'vendor_b') return 'vendor_a';
  return source;
}

const claimContent = (c: ReframeClaimContent): ReframeClaimContent => ({
  origin: c.origin,
  createdByVendorId: c.createdByVendorId,
  createdAt: c.createdAt,
});

const attestationContent = (a: ReframeAttestationContent): ReframeAttestationContent => ({
  asserted: a.asserted,
  introducedAt: a.introducedAt,
  deprecatedAt: a.deprecatedAt,
  introducedVersionId: a.introducedVersionId,
  deprecatedVersionId: a.deprecatedVersionId,
  attestedByVendorId: a.attestedByVendorId,
  note: a.note,
  createdAt: a.createdAt,
});

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Plan the flip for every claim on ONE anchor. `claims` must be the anchor's complete
 * set: a partial set could miss the partner row a collision needs.
 */
export function planClaimReframe(claims: readonly ReframeClaim[]): ReframePlan {
  // Deep copy: the planner walks a model of the rows forward as it emits ops.
  const model: ReframeClaim[] = claims.map((c) => ({
    ...c,
    attestations: c.attestations.map((a) => ({ ...a })),
  }));
  const claimOps: ReframeOp[] = [];
  const moveOps: ReframeOp[] = [];
  const slotOps: ReframeOp[] = [];
  const collisions: ReframeCollision[] = [];

  const swapAttestationContents = (p: ReframeAttestation, q: ReframeAttestation) => {
    const pBefore = attestationContent(p);
    const qBefore = attestationContent(q);
    Object.assign(p, qBefore);
    Object.assign(q, pBefore);
    return [
      {
        kind: 'attestation.content' as const,
        attestationId: p.id,
        swappedWith: q.id,
        before: pBefore,
        after: qBefore,
      },
      {
        kind: 'attestation.content' as const,
        attestationId: q.id,
        swappedWith: p.id,
        before: qBefore,
        after: pBefore,
      },
    ];
  };

  // ── 1. Claim directions ────────────────────────────────────────────────────
  const byDataObject = new Map<string, ReframeClaim[]>();
  for (const claim of [...model].sort(byId)) {
    const list = byDataObject.get(claim.dataObjectId);
    if (list) list.push(claim);
    else byDataObject.set(claim.dataObjectId, [claim]);
  }
  for (const group of byDataObject.values()) {
    const x = group.find((c) => c.direction === 'a_to_b');
    const y = group.find((c) => c.direction === 'b_to_a');
    if (x && y) {
      // Collision. X keeps `a_to_b` and takes Y's contents; Y keeps `b_to_a` and takes X's.
      collisions.push({ kind: 'claim', dataObjectId: x.dataObjectId, claimIds: [x.id, y.id] });
      const xBefore = claimContent(x);
      const yBefore = claimContent(y);
      Object.assign(x, yBefore);
      Object.assign(y, xBefore);
      claimOps.push(
        {
          kind: 'claim.content',
          claimId: x.id,
          swappedWith: y.id,
          before: xBefore,
          after: yBefore,
        },
        {
          kind: 'claim.content',
          claimId: y.id,
          swappedWith: x.id,
          before: yBefore,
          after: xBefore,
        },
      );

      // A claim's attestations are its contents too. A slot live on both sides swaps
      // contents; anything else — a slot live on one side, or any retracted row —
      // moves, because its destination slot is free.
      const xAtts = [...x.attestations].sort(byId);
      const yAtts = [...y.attestations].sort(byId);
      const live = (list: ReframeAttestation[], source: string) =>
        list.find((a) => a.retractedAt === null && a.source === source);
      const swappedIds = new Set<string>();
      for (const p of xAtts) {
        if (p.retractedAt !== null) continue;
        const q = live(yAtts, p.source);
        if (!q) continue;
        collisions.push({ kind: 'attestation', claimId: x.id, attestationIds: [p.id, q.id] });
        moveOps.push(...swapAttestationContents(p, q));
        swappedIds.add(p.id);
        swappedIds.add(q.id);
      }
      const nextX: ReframeAttestation[] = [];
      const nextY: ReframeAttestation[] = [];
      for (const a of xAtts) {
        if (swappedIds.has(a.id)) nextX.push(a);
        else {
          moveOps.push({ kind: 'attestation.claim', attestationId: a.id, from: x.id, to: y.id });
          a.claimId = y.id;
          nextY.push(a);
        }
      }
      for (const a of yAtts) {
        if (swappedIds.has(a.id)) nextY.push(a);
        else {
          moveOps.push({ kind: 'attestation.claim', attestationId: a.id, from: y.id, to: x.id });
          a.claimId = x.id;
          nextX.push(a);
        }
      }
      x.attestations = nextX;
      y.attestations = nextY;
      continue;
    }
    const oneWay = x ?? y;
    if (oneWay) {
      const to = flipClaimDirection(oneWay.direction);
      claimOps.push({ kind: 'claim.direction', claimId: oneWay.id, from: oneWay.direction, to });
      oneWay.direction = to;
    }
  }

  // ── 2. Vendor slots, on the post-step-1 layout ─────────────────────────────
  for (const claim of [...model].sort(byId)) {
    const atts = [...claim.attestations].sort(byId);
    const liveA = atts.find((a) => a.retractedAt === null && a.source === 'vendor_a');
    const liveB = atts.find((a) => a.retractedAt === null && a.source === 'vendor_b');
    if (liveA && liveB) {
      collisions.push({
        kind: 'attestation',
        claimId: claim.id,
        attestationIds: [liveA.id, liveB.id],
      });
      slotOps.push(...swapAttestationContents(liveA, liveB));
    }
    for (const a of atts) {
      if (a.source === 'aeci') continue;
      if (liveA && liveB && (a === liveA || a === liveB)) continue;
      const to = flipAttestationSource(a.source);
      slotOps.push({ kind: 'attestation.source', attestationId: a.id, from: a.source, to });
      a.source = to;
    }
  }

  return { ops: [...claimOps, ...moveOps, ...slotOps], after: model, collisions };
}

/** SQLite string literal. `wrangler d1 execute` has no bind support. */
const lit = (value: string | null | boolean): string =>
  value === null
    ? 'NULL'
    : typeof value === 'boolean'
      ? value
        ? '1'
        : '0'
      : `'${value.replace(/'/g, "''")}'`;

/**
 * Render ops as SQL text for the one-time repair. Each statement sets `updated_at` to
 * `now`, which is what the repair's own skip rule reads on a re-run.
 */
export function renderReframeSql(ops: readonly ReframeOp[], now: string): string[] {
  return ops.map((op) => {
    switch (op.kind) {
      case 'claim.direction':
        return `UPDATE claims SET direction = ${lit(op.to)}, updated_at = ${lit(now)} WHERE id = ${lit(op.claimId)} AND direction = ${lit(op.from)};`;
      case 'claim.content':
        return (
          `UPDATE claims SET origin = ${lit(op.after.origin)}, created_by_vendor_id = ${lit(op.after.createdByVendorId)}, ` +
          `created_at = ${lit(op.after.createdAt)}, updated_at = ${lit(now)} WHERE id = ${lit(op.claimId)};`
        );
      case 'attestation.claim':
        return `UPDATE attestations SET claim_id = ${lit(op.to)}, updated_at = ${lit(now)} WHERE id = ${lit(op.attestationId)} AND claim_id = ${lit(op.from)};`;
      case 'attestation.content': {
        const a = op.after;
        return (
          `UPDATE attestations SET asserted = ${lit(a.asserted)}, introduced_at = ${lit(a.introducedAt)}, ` +
          `deprecated_at = ${lit(a.deprecatedAt)}, introduced_version_id = ${lit(a.introducedVersionId)}, ` +
          `deprecated_version_id = ${lit(a.deprecatedVersionId)}, attested_by_vendor_id = ${lit(a.attestedByVendorId)}, ` +
          `note = ${lit(a.note)}, created_at = ${lit(a.createdAt)}, updated_at = ${lit(now)} WHERE id = ${lit(op.attestationId)};`
        );
      }
      case 'attestation.source':
        return `UPDATE attestations SET source = ${lit(op.to)}, updated_at = ${lit(now)} WHERE id = ${lit(op.attestationId)} AND source = ${lit(op.from)};`;
    }
  });
}

/** The audit row an op writes (§26.1). `entityType`/`action` are shared by both renderers. */
export function reframeOpAudit(op: ReframeOp): {
  action: 'claim.reframed' | 'attestation.reframed';
  entityType: 'claim' | 'attestation';
  entityId: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
} {
  switch (op.kind) {
    case 'claim.direction':
      return {
        action: 'claim.reframed',
        entityType: 'claim',
        entityId: op.claimId,
        beforeState: { direction: op.from },
        afterState: { direction: op.to },
      };
    case 'claim.content':
      return {
        action: 'claim.reframed',
        entityType: 'claim',
        entityId: op.claimId,
        beforeState: { ...op.before },
        afterState: { ...op.after, swappedWith: op.swappedWith },
      };
    case 'attestation.claim':
      return {
        action: 'attestation.reframed',
        entityType: 'attestation',
        entityId: op.attestationId,
        beforeState: { claimId: op.from },
        afterState: { claimId: op.to },
      };
    case 'attestation.content':
      return {
        action: 'attestation.reframed',
        entityType: 'attestation',
        entityId: op.attestationId,
        beforeState: { ...op.before },
        afterState: { ...op.after, swappedWith: op.swappedWith },
      };
    case 'attestation.source':
      return {
        action: 'attestation.reframed',
        entityType: 'attestation',
        entityId: op.attestationId,
        beforeState: { source: op.from },
        afterState: { source: op.to },
      };
  }
}
