import type { HttpClient } from '@angular/common/http';
import type { Router } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';

import { defaultIntegrationContext, type ProductPairResponse } from '@aeci/shared';

import { decodeNotFound } from '../../core/api/http-get-or-null';
import { pairPath } from '../../core/api/product-pairs';
import {
  httpGetSlugRedirect,
  movedPairPath,
  rewriteRetiredPairSlugs,
} from '../../core/api/slug-redirects';
import { navigateToSearchQuery } from '../../layout/search-submit';
import type { AutocompleteSuggestion } from '../../search/autocomplete-mapping';

/**
 * The pair finder's routing, shared by the home hero (AECI-1555, AECI-1823) and the
 * product page hero (AECI-1787), so both finders behave the same way (the Same-Behavior
 * Rule). Moved out of `home/home-hero.ts` unchanged.
 */

/** How long the finder waits on the pair read before it navigates anyway (AECI-1823). */
export const PAIR_READ_TIMEOUT_MS = 2500;

/** Resolve with `fallback` if `work` has not settled within `ms`. */
export function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

/** A chosen product suggestion's slug (`routerLink` is `['/products', slug]`). */
export function productSlug(s: AutocompleteSuggestion | null): string | null {
  if (!s || s.kind !== 'product') return null;
  return s.routerLink[1] ?? null;
}

/** What the pair branch needs from its finder. */
export interface PairRouteDeps {
  readonly router: Router;
  readonly http: HttpClient;
  /** True once the visitor edited a picker, so the captured pair is no longer theirs. */
  readonly changed: () => boolean;
  /** The typed text of the picker whose product is `slug`, or '' when it is neither. */
  readonly missingText: (slug: string | null) => string;
  /** The first non-empty text typed in any picker. */
  readonly typedText: () => string;
}

/**
 * Read the pair from the endpoint its resolver uses. Only a canonical `NOT_FOUND`
 * says it is missing, and then `slug` is the one the envelope names, if any. Any
 * other failure, including the timeout, answers "not missing", so a slow or flaky
 * read never strands the visitor: the pair page makes its own decision.
 */
async function checkPair(
  http: HttpClient,
  context: string,
  other: string,
): Promise<{ missing: boolean; slug: string | null }> {
  try {
    await firstValueFrom(
      http
        .get<ProductPairResponse>(pairPath(context, other, undefined))
        .pipe(timeout(PAIR_READ_TIMEOUT_MS)),
    );
    return { missing: false, slug: null };
  } catch (err) {
    const notFound = decodeNotFound(err);
    return { missing: notFound !== null, slug: notFound?.slug ?? null };
  }
}

/** Two different products chosen: read, retired-slug lookup, then navigate. */
export async function routeFinderPair(
  deps: PairRouteDeps,
  tool: string,
  other: string,
): Promise<void> {
  const context = defaultIntegrationContext(tool, other);
  const rest = context === tool ? other : tool;

  const check = await checkPair(deps.http, context, rest);
  if (deps.changed()) return;
  if (check.missing) {
    // A retired slug redirects to its survivor pair, as the pair resolver does
    // (AECI-991). Bounded by the same budget as the read, here only: a timeout
    // reads as "no redirect" and falls through to search.
    const rewritten = await withTimeout(
      rewriteRetiredPairSlugs(context, rest, (slug) =>
        httpGetSlugRedirect(deps.http, 'product', slug),
      ),
      PAIR_READ_TIMEOUT_MS,
      null,
    );
    if (deps.changed()) return;
    if (rewritten) {
      void deps.router.navigateByUrl(movedPairPath(rewritten));
      return;
    }
    // A stale slug: send the visitor to search, not the generic 404 (AECI-1823).
    const typed = deps.missingText(check.slug) || deps.typedText();
    if (typed) {
      navigateToSearchQuery(deps.router, typed);
      return;
    }
  }
  void deps.router.navigate(['/products', context, 'integrations', rest]);
}
