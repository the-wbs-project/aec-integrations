/**
 * The order of the mechanism cards on a pair page (AECI-2043, ruling 14 on AECI-2035,
 * `docs/STAGE_1_5_SPEC.md` §13.13).
 *
 * The pair read hands over its two arms already ordered in D1: `integrations` rows A to
 * Z by name then id, then `connector_evidenced_pairs` rows A to Z by name then id
 * (ruling R1, AECI-1732). This keeps that order for every card except a Sync Service's.
 *
 * - **Every other card** (native, an Integration platform, an unclassified connector)
 *   keeps its place in the read's order, relative to the others.
 * - **Sync Service cards** (`connector_kind === 'sync_service'`, from either arm) come
 *   after every other card, A to Z by the name of the vendor that offers them
 *   (`built_by_vendor`, the "Offered by" vendor), ignoring capital letters
 *   (`compareText`). A card whose offering vendor is not on record comes after the
 *   named ones. The mechanism id breaks every tie, so the order is total.
 *
 * It reads no plan, license, rating, review count or claim state. The kind is set by an
 * AECi admin only (ruling 3), and a vendor cannot rename itself, so no plan can move a
 * card. `on-page-ordering-firewall.spec.ts` holds it to that (`pair-page-mechanisms`).
 */
import type { ProductPairMechanism } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

type OrderedMechanism = Pick<ProductPairMechanism, 'id' | 'built_by_vendor' | 'connector_kind'>;

/** True when a Sync Service delivers this card. */
export function isSyncServiceMechanism(m: Pick<ProductPairMechanism, 'connector_kind'>): boolean {
  return m.connector_kind === 'sync_service';
}

/**
 * Two Sync Service cards: A to Z by the offering vendor's name, case folded, an unknown
 * vendor last, then the id. Both names are lowercased before `compareText`, so a name
 * that differs only in case is a tie and the id decides, as `textAsc` (`COLLATE
 * NOCASE`) does in D1. `compareText` alone would let lowercase win that tie. A plain
 * `<` on the id: ids are UUIDs, so the BINARY order is the one `asc(id)` gives in D1.
 */
export function compareSyncServiceMechanisms(a: OrderedMechanism, b: OrderedMechanism): number {
  const nameA = a.built_by_vendor?.name ?? null;
  const nameB = b.built_by_vendor?.name ?? null;
  if (nameA !== null && nameB === null) return -1;
  if (nameA === null && nameB !== null) return 1;
  if (nameA !== null && nameB !== null) {
    const byName = compareText(nameA.toLowerCase(), nameB.toLowerCase());
    if (byName !== 0) return byName;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The card order. Returns a new array; the input is not changed. */
export function orderPairMechanisms<T extends OrderedMechanism>(mechanisms: readonly T[]): T[] {
  const others = mechanisms.filter((m) => !isSyncServiceMechanism(m));
  const syncServices = mechanisms.filter(isSyncServiceMechanism);
  return [...others, ...syncServices.sort(compareSyncServiceMechanisms)];
}
