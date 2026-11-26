/**
 * AECI-2043 (ruling 14 on AECI-2035): the pair page card order. Sync Service cards come
 * last, A to Z by the offering vendor, case folded, then id. Every other card keeps the
 * read's order.
 */
import { describe, expect, it } from 'vitest';

import type { ConnectorKind } from '@aeci/shared';

import { orderPairMechanisms } from './pair-mechanism-order';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function card(n: number, kind: ConnectorKind | null, vendor: string | null = null) {
  return {
    id: id(n),
    connector_kind: kind,
    built_by_vendor: vendor
      ? { id: id(n + 500), name: vendor, slug: `v-${n}`, logo_url: null }
      : null,
  };
}

const order = (cards: ReturnType<typeof card>[]) => orderPairMechanisms(cards).map((c) => c.id);

describe('orderPairMechanisms', () => {
  it('keeps the read order for native, Integration platform and unclassified cards', () => {
    const cards = [card(3, null), card(1, 'integration_platform'), card(2, null)];
    expect(order(cards)).toEqual([id(3), id(1), id(2)]);
  });

  it('puts Sync Service cards last, A to Z by the offering vendor', () => {
    const cards = [
      card(10, 'sync_service', 'Rivets'),
      card(11, null),
      card(12, 'sync_service', 'Agave Inc.'),
      card(13, 'integration_platform'),
    ];
    expect(order(cards)).toEqual([id(11), id(13), id(12), id(10)]);
  });

  it('ignores capital letters: a lowercase name sorts by its letters, not its case', () => {
    // A byte order would put "Rivets" (0x52) ahead of "agave" (0x61).
    const cards = [card(20, 'sync_service', 'Rivets'), card(21, 'sync_service', 'agave')];
    expect(order(cards)).toEqual([id(21), id(20)]);
  });

  it('breaks a case-only tie on the id, in both input orders', () => {
    const tied = [card(31, 'sync_service', 'rivets'), card(30, 'sync_service', 'Rivets')];
    expect(order(tied)).toEqual([id(30), id(31)]);
    expect(order([...tied].reverse())).toEqual([id(30), id(31)]);
  });

  it('puts a Sync Service card whose offering vendor is unknown after the named ones, id deciding among them', () => {
    const cards = [
      card(42, 'sync_service'),
      card(41, 'sync_service'),
      card(40, 'sync_service', 'Zeta Sync Co'),
    ];
    expect(order(cards)).toEqual([id(40), id(41), id(42)]);
  });

  it('does not change its input', () => {
    const cards = [card(51, 'sync_service', 'B'), card(50, 'sync_service', 'A')];
    orderPairMechanisms(cards);
    expect(cards.map((c) => c.id)).toEqual([id(51), id(50)]);
  });
});
