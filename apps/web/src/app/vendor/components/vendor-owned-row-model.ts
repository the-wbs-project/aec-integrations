import type { OwnedIntegration } from '@aeci/shared';

/**
 * The words and state rules for one row the caller owns (AECI-1089, §6.15), shared by
 * the owned card (`vendor-owned-integrations.ts`) and the owned row's detail page
 * (AECI-2045, `integration-detail/owned-integration-overview.ts`). One file, so the
 * card and the page cannot describe one row two ways (the Same-Behavior Rule).
 */

/** Where the owner stands on one owned row. A connector-delivered row takes the
 *  same states as any other: the seat is the whole gate (ruling 14, AECI-1663). */
export type OwnedRowState = 'retired' | 'claimed' | 'claimable';

export function ownedRowState(
  row: Pick<OwnedIntegration, 'retired_at' | 'claimed_at'>,
): OwnedRowState {
  if (row.retired_at) return 'retired';
  return row.claimed_at ? 'claimed' : 'claimable';
}

/** The row's name, or "{A} and {B}" when it has none. */
export function ownedRowTitle(
  row: Pick<OwnedIntegration, 'name' | 'product_a' | 'product_b'>,
): string {
  return (
    row.name ??
    $localize`:@@vendor.ownedIntegrations.untitled:${row.product_a.name}:a: and ${row.product_b.name}:b:`
  );
}

/** Which two products it joins, and through what. */
export function ownedRowRoute(
  row: Pick<OwnedIntegration, 'product_a' | 'product_b' | 'connector' | 'mechanism_name'>,
): string {
  const a = row.product_a.name;
  const b = row.product_b.name;
  const via = row.connector?.name ?? row.mechanism_name;
  return via
    ? $localize`:@@vendor.ownedIntegrations.routeVia:Connects ${a}:a: and ${b}:b: through ${via}:via:.`
    : $localize`:@@vendor.ownedIntegrations.route:Connects ${a}:a: and ${b}:b:.`;
}

/** The one status line under the row. */
export function ownedRowStatusLine(
  row: Pick<OwnedIntegration, 'retired_at' | 'claimed_at' | 'retired_by'>,
): string {
  switch (ownedRowState(row)) {
    case 'retired':
      return row.retired_by === 'aeci'
        ? $localize`:@@vendor.ownedIntegrations.retiredByAeci:AEC Integrations retired this integration. It is not shown on the public site.`
        : $localize`:@@vendor.ownedIntegrations.retired:Your company retired this integration. It is not shown on the public site.`;
    case 'claimed':
      return $localize`:@@vendor.ownedIntegrations.claimed:Your company owns this integration. AEC Integrations no longer updates it.`;
    case 'claimable':
      return $localize`:@@vendor.ownedIntegrations.unclaimed:Your company is recorded as the owner. AEC Integrations still maintains its details until you claim it.`;
  }
}

/** The live-region sentence after a claim. */
export function ownedRowClaimedAnnouncement(): string {
  return $localize`:@@vendor.ownedIntegrations.live.claimed:You claimed this integration. AEC Integrations no longer updates it.`;
}
