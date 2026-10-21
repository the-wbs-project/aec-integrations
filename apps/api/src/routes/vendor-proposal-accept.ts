/**
 * What an owner's accept of a product proposal writes (AECI-1417, E6b.5; ADR 0042,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.22, `DATABASE_SCHEMA.md` §8.6f).
 *
 * Two halves, both pure over what the handler read:
 *
 *   - {@link resolveProposalTerms}: the proposal's taxonomy, find-only (ruling Q6). Each
 *     category, audience, phase and trade value is looked up against the stored terms,
 *     exactly as promote looks it up (slug pass, then name pass; trades add an alias
 *     pass). A value that names no term is DROPPED and listed. Promote mints a missing
 *     category, audience or phase; an owner click never does. "How teams use it" groups
 *     resolve against every stored audience and phase, as in promote, and an unresolved
 *     group is dropped and listed too. An `extensionOf` host must be a live product.
 *   - {@link planProposalAccept}: the one batch. The guarded decision UPDATE and the
 *     sentinel that aborts the batch when it matched no row (another owner or tab
 *     decided first), the sentinel that aborts it when the addressed vendor stopped
 *     owning its record, then the product INSERT and its joins, built from promote's own
 *     projection (`productEditableData`, `generateSlug` in `routes/promote.ts`). The
 *     handler appends the audit rows to the same batch.
 *
 * ── WHY NOT promote's create block ──────────────────────────────────────────────
 * `runPromoteIngest` plans the product inside a 2,000-line plan that also resolves
 * vendors by payload ref, mints terms, plans integrations and claims, and fences
 * ownership. Lifting its create branch out would mean threading that state through a
 * new seam, and promote's behaviour must not move. So accept is a narrow builder over
 * the same helpers. What it shares with promote: the slug rule, the column projection,
 * the term-matching keys, the join tables and their order. What it does differently, by
 * ruling: no term is minted, every vendor link is the stored `vendorId` from the
 * proposal payload (ruling B), and the product is vendor-maintained from birth.
 *
 * ── THE MAINTENANCE MARKERS ─────────────────────────────────────────────────────
 * `maintained_by = 'vendor'` and `last_reviewed_at` = the accept time, the
 * `maintenanceTransferColumns` pair every vendor write sets (`STAGE_2_ATTESTATIONS_SPEC.md`
 * §13.9). It is what a vendor-created integration carries (§4c of
 * `STAGE_2_VENDOR_PORTAL_SPEC.md`, `claimColumns`). An owner who accepted the product
 * has reviewed it, and the product exists only because the owned vendor said yes. A
 * `lastReviewedAt` the review app sent is overridden for the same reason.
 * `promotion_status = 'promoted'` and `promoted_at` = the accept time, so the product
 * is public as a promoted product is.
 */

import type {
  DroppedProposalTerm,
  PromoteProduct,
  ProposalTermFacet,
  UsefulnessGroup,
  VendorProposalTerm,
} from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  productAudiences,
  productCategories,
  productExtensions,
  productPhases,
  productProposals,
  productTrades,
  productVendors,
  products,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
} from '../db/schema';
import type { BatchStmt } from '../lib/audit';
import { safeSlugify } from '../lib/data-object-vocabulary';
import { changedOneRowSentinel } from '../lib/license-release-requests';
import { proposalVendorOwnedSentinel } from '../lib/product-proposals';
import { productEditableData } from './promote';
import { maintenanceTransferColumns } from './vendor-shared';

/** A stored term, as the resolution needs it. */
export interface StoredTerm {
  id: string;
  slug: string;
  name: string;
}

/** Every stored term, keyed the way promote matches an incoming value. */
export interface ProposalTermIndex {
  categories: Map<string, StoredTerm>;
  audiences: Map<string, StoredTerm>;
  phases: Map<string, StoredTerm>;
  trades: Map<string, StoredTerm>;
}

/** Promote's two passes (AECI-970): every row's slug first, then `slugify(name)`, so a
 *  row's name can never shadow another row's slug. */
function facetIndex(rows: readonly StoredTerm[]): Map<string, StoredTerm> {
  const byKey = new Map<string, StoredTerm>();
  for (const row of rows) byKey.set(row.slug, row);
  for (const row of rows) {
    const key = safeSlugify(row.name);
    if (key && !byKey.has(key)) byKey.set(key, row);
  }
  return byKey;
}

/** Promote's three trade passes: slug, then name, then alias (`TRADES_VOCABULARY.md` §4). */
function tradeIndex(
  rows: ReadonlyArray<StoredTerm & { aliases: string[] | null }>,
): Map<string, StoredTerm> {
  const byKey = new Map<string, StoredTerm>();
  const add = (value: string | null | undefined, row: StoredTerm) => {
    const key = value ? safeSlugify(value) : null;
    if (key && !byKey.has(key)) byKey.set(key, row);
  };
  const terms = rows.map((r) => ({ term: { id: r.id, slug: r.slug, name: r.name }, row: r }));
  for (const { term } of terms) add(term.slug, term);
  for (const { term } of terms) add(term.name, term);
  for (const { term, row } of terms) for (const alias of row.aliases ?? []) add(alias, term);
  return byKey;
}

/** One read per facet table, in one round trip. The vocabularies are small and closed. */
export async function loadProposalTermIndex(db: Db): Promise<ProposalTermIndex> {
  const [categories, audiences, phases, trades] = await db.batch([
    db
      .select({
        id: taxonomyCategories.id,
        slug: taxonomyCategories.slug,
        name: taxonomyCategories.name,
      })
      .from(taxonomyCategories),
    db
      .select({
        id: taxonomyAudiences.id,
        slug: taxonomyAudiences.slug,
        name: taxonomyAudiences.name,
      })
      .from(taxonomyAudiences),
    db
      .select({ id: taxonomyPhases.id, slug: taxonomyPhases.slug, name: taxonomyPhases.name })
      .from(taxonomyPhases),
    db
      .select({
        id: taxonomyTrades.id,
        slug: taxonomyTrades.slug,
        name: taxonomyTrades.name,
        aliases: taxonomyTrades.aliases,
      })
      .from(taxonomyTrades),
  ]);
  return {
    categories: facetIndex(categories),
    audiences: facetIndex(audiences),
    phases: facetIndex(phases),
    trades: tradeIndex(trades),
  };
}

/** The host product ids an `extensionOf` list names by id. A payload-local `ref` can
 *  name only the proposed product itself, which is never a host. */
export function proposalHostIds(product: PromoteProduct): string[] {
  return product.extensionOf.flatMap((h) => (h.supabaseId ? [h.supabaseId] : []));
}

export interface ResolvedProposalTerms {
  categories: StoredTerm[];
  audiences: StoredTerm[];
  phases: StoredTerm[];
  trades: StoredTerm[];
  /** `undefined`: the payload sent none, so the column is left at its default. */
  usefulness: { audiences: UsefulnessGroup[]; phases: UsefulnessGroup[] } | null | undefined;
  hosts: StoredTerm[];
  /** Every value the proposal names, in payload order, with whether it resolves. */
  terms: VendorProposalTerm[];
  /** The values an accept drops: `terms` with `exists: false`. */
  dropped: DroppedProposalTerm[];
}

/**
 * Resolve a proposal's taxonomy, find-only (ruling Q6). Pure: `index` is every stored
 * term and `hosts` every live product the `extensionOf` list names by id. Duplicate
 * values that resolve to one term link it once, as in promote.
 */
export function resolveProposalTerms(
  product: PromoteProduct,
  index: ProposalTermIndex,
  hosts: ReadonlyMap<string, StoredTerm>,
): ResolvedProposalTerms {
  const terms: VendorProposalTerm[] = [];
  const note = (facet: ProposalTermFacet, value: string, found: StoredTerm | undefined) =>
    terms.push({ facet, value, name: found?.name ?? null, exists: found !== undefined });

  const facet = (
    values: readonly string[],
    byKey: ReadonlyMap<string, StoredTerm>,
    name: ProposalTermFacet,
  ): StoredTerm[] => {
    const out: StoredTerm[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const key = safeSlugify(value);
      const found = key ? byKey.get(key) : undefined;
      note(name, value, found);
      if (found && !seen.has(found.id)) {
        seen.add(found.id);
        out.push(found);
      }
    }
    return out;
  };

  const categories = facet(product.categories, index.categories, 'category');
  const audiences = facet(product.audiences, index.audiences, 'audience');
  const phases = facet(product.phases, index.phases, 'phase');
  const trades = facet(product.trades, index.trades, 'trade');

  // Usefulness resolves against every stored audience and phase, not only the
  // product's own: the promote rule (`resolveUsefulnessFacet`). Groups that land on
  // one term merge their points, as there.
  const groups = (
    input: ReadonlyArray<{ slug?: string; name?: string; points: string[] }>,
    byKey: ReadonlyMap<string, StoredTerm>,
  ): UsefulnessGroup[] => {
    const lookup = (value?: string) => {
      const key = value ? safeSlugify(value) : null;
      return key ? byKey.get(key) : undefined;
    };
    const merged = new Map<string, UsefulnessGroup>();
    for (const g of input) {
      const found = lookup(g.slug) ?? lookup(g.name);
      note('usefulness', g.slug ?? g.name ?? '', found);
      if (!found) continue;
      const existing = merged.get(found.slug);
      if (existing) existing.points.push(...g.points);
      else merged.set(found.slug, { slug: found.slug, name: found.name, points: [...g.points] });
    }
    return [...merged.values()];
  };
  const usefulness =
    product.usefulness === null
      ? null
      : product.usefulness
        ? {
            audiences: groups(product.usefulness.audiences, index.audiences),
            phases: groups(product.usefulness.phases, index.phases),
          }
        : undefined;

  const hostTerms: StoredTerm[] = [];
  for (const ref of product.extensionOf) {
    const id = ref.supabaseId ?? ref.ref ?? '';
    const found = ref.supabaseId ? hosts.get(ref.supabaseId) : undefined;
    note('extension', id, found);
    if (found && !hostTerms.some((h) => h.id === found.id)) hostTerms.push(found);
  }

  return {
    categories,
    audiences,
    phases,
    trades,
    usefulness,
    hosts: hostTerms,
    terms,
    dropped: terms.filter((t) => !t.exists).map(({ facet: f, value }) => ({ facet: f, value })),
  };
}

export interface ProposalAcceptInput {
  proposalId: string;
  /** The owned vendor the proposal is addressed to. */
  vendorId: string;
  productId: string;
  slug: string;
  product: PromoteProduct;
  /** Every vendor link, in payload order, with its stored primary flag (ruling B). */
  links: ReadonlyArray<{ vendorId: string; isPrimary: boolean }>;
  resolved: ResolvedProposalTerms;
  now: string;
  decidedBy: string;
}

/**
 * The accept's statements, audit rows excluded (the handler stamps and appends them).
 *
 * Order is load-bearing:
 *   1. the guarded decision UPDATE (`decision IS NULL`), then
 *   2. `changedOneRowSentinel`, which reads `changes()` of statement 1 and aborts the
 *      batch when it matched nothing: another owner or tab decided first;
 *   3. `proposalVendorOwnedSentinel`: aborts when the addressed vendor no longer owns
 *      its record (a "Return records to AECi" between the read and the batch);
 *   4. the product INSERT, then its join rows. A vendor deleted since the read fails
 *      the `product_vendors` FK and rolls the batch back: no half-linked product.
 */
export function planProposalAccept(db: Db, input: ProposalAcceptInput): BatchStmt[] {
  const { productId: pid, resolved } = input;
  const stmts: BatchStmt[] = [
    db
      .update(productProposals)
      .set({
        decision: 'accepted',
        decidedAt: input.now,
        decidedBy: input.decidedBy,
        createdProductId: pid,
      })
      .where(and(eq(productProposals.id, input.proposalId), isNull(productProposals.decision))),
    changedOneRowSentinel(db),
    proposalVendorOwnedSentinel(db, input.vendorId),
    db.insert(products).values({
      id: pid,
      slug: input.slug,
      name: input.product.name,
      promotionStatus: 'promoted',
      promotedAt: input.now,
      ...(resolved.usefulness ? { usefulness: resolved.usefulness } : {}),
      ...productEditableData(input.product),
      // AFTER the projection, which carries the review app's `lastReviewedAt`.
      ...maintenanceTransferColumns(input.now),
    }),
  ];
  if (input.links.length) {
    stmts.push(
      db
        .insert(productVendors)
        .values(
          input.links.map((l) => ({
            productId: pid,
            vendorId: l.vendorId,
            isPrimary: l.isPrimary,
          })),
        )
        .onConflictDoNothing(),
    );
  }
  if (resolved.categories.length) {
    stmts.push(
      db
        .insert(productCategories)
        .values(resolved.categories.map((t) => ({ productId: pid, categoryId: t.id }))),
    );
  }
  if (resolved.audiences.length) {
    stmts.push(
      db
        .insert(productAudiences)
        .values(resolved.audiences.map((t) => ({ productId: pid, audienceId: t.id }))),
    );
  }
  if (resolved.phases.length) {
    stmts.push(
      db
        .insert(productPhases)
        .values(resolved.phases.map((t) => ({ productId: pid, phaseId: t.id }))),
    );
  }
  if (resolved.trades.length) {
    stmts.push(
      db
        .insert(productTrades)
        .values(resolved.trades.map((t) => ({ productId: pid, tradeId: t.id }))),
    );
  }
  if (resolved.hosts.length) {
    stmts.push(
      db
        .insert(productExtensions)
        .values(resolved.hosts.map((h) => ({ productId: pid, hostProductId: h.id }))),
    );
  }
  return stmts;
}
