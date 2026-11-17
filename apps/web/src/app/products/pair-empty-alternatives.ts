import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type {
  IntegrationTerm,
  PairAlternativeMatch,
  PairAlternatives,
  ProductPairSubject,
} from '@aeci/shared';

import { ReviewStars } from '../reviews/review-stars';
import { contextDirectionLabel } from '../search/mechanism-labels';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { AecCard } from '../shared/card/card';
import { Chip } from '../shared/chip/chip';
import { AecIcon } from '../shared/icon/icon';
import { DATA_OBJECT_ICONS } from '../shared/icon/icon-maps';
import type { AecIconName } from '../shared/icon/icon-registry';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';

import { integrationsOnRecordCount } from './integrations-on-record';

type Side = 'context' | 'other';
type View = 'cards' | 'table';

/** The shared focus ring on a light ground, 3px at 3px. */
const FOCUS_RING =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** The data-object glyph, when the vocabulary has one. */
function objectIcon(slug: string): AecIconName | null {
  return (DATA_OBJECT_ICONS as Readonly<Record<string, AecIconName | null>>)[slug] ?? null;
}

/**
 * AECI-1830 and AECI-1829: the empty pair page's "What you would be moving" and closest
 * matches (mock-up 5, `STAGE_1_5_SPEC.md` §11.3 and §11.4). Both read the alternatives
 * payload the SSR resolver fetched, so the first render is in the cached HTML, the same
 * for every visitor: keep the first product, every category on, nothing picked, cards.
 *
 * - **What you would be moving.** Each product's data objects in three groups, only in the
 *   first product, in both, only in the second, drawn from their integrations on record.
 *   Each object is a toggle: a picked object narrows the matches to products that move it
 *   (ruling R6, decision 16). The groups order nothing: the vocabulary's own order.
 * - **Closest matches.** "Keep {A}" or "Keep {B}" picks the lane. The other product's
 *   categories are toggle chips, all on. A match is a product the kept product has an
 *   integration on record with, sharing a category left on, and moving every picked
 *   object. A to Z by name, id breaking a tie (ruling R1): the API's order, never re-sorted
 *   here. "Confirmed by both companies" is a label only (R1). A live count is announced.
 *
 * Nothing here reads a plan, a license or any paid input.
 */
@Component({
  selector: 'aec-pair-empty-alternatives',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecCard, AecIcon, Chip, LogoOrInitial, ReviewStars, RouterLink],
  host: { class: 'block' },
  template: `
    <!-- What you would be moving: the page's one Bone band (mock-up 5). -->
    <section
      aria-labelledby="pair-moving-title"
      class="bg-(--accent-warm) text-(--text-primary)"
      data-testid="pair-empty-moving"
    >
      <div [class]="movingWrap">
        <div class="mb-8 max-w-prose md:mb-10">
          <p class="aec-overline mb-3 text-(--text-secondary)" i18n="@@pair.empty.moving.kicker">
            What you would be moving
          </p>
          <h2 id="pair-moving-title" class="m-0">
            <span
              class="block font-display text-t-36 leading-[1.1] tracking-[-0.02em]"
              i18n="@@pair.empty.moving.heading"
              >The data each product already exchanges</span
            >
          </h2>
          <p
            class="mt-4 text-t-16 leading-relaxed text-(--text-secondary)"
            i18n="@@pair.empty.moving.intro"
          >
            Drawn from each product's integrations on record. Pick the data you need and the matches
            below narrow to products that move it.
          </p>
        </div>

        <div class="relative grid gap-4 md:grid-cols-3 md:gap-0">
          <svg
            class="pointer-events-none absolute inset-0 hidden size-full md:block"
            viewBox="0 0 1000 300"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            <ellipse cx="350" cy="150" rx="350" ry="150" class="fill-(--accent-primary-soft)" />
            <ellipse
              cx="650"
              cy="150"
              rx="350"
              ry="150"
              class="fill-(--accent-secondary)"
              opacity=".16"
            />
          </svg>
          @for (group of groups(); track group.key) {
            <div
              class="relative flex min-w-0 flex-col items-center gap-3 rounded-card px-4 py-6 text-center md:rounded-none md:bg-transparent md:px-8 md:py-14"
              [class]="group.tint"
              [attr.data-testid]="'pair-moving-' + group.key"
            >
              <h3 class="m-0 flex items-center gap-2">
                <span class="inline-flex">
                  @for (p of group.marks; track p.id; let i = $index) {
                    <aec-logo-or-initial
                      [class]="i > 0 ? '-ms-2' : ''"
                      [name]="p.name"
                      [src]="p.logo_url"
                      [alt]="logoAlt(p.name)"
                      [claimStatus]="p.claim_status"
                      size="sm"
                    />
                  }
                </span>
                <span class="font-display text-t-20 font-semibold">{{ group.title }}</span>
              </h3>
              <p class="m-0 text-t-13 text-(--text-secondary)">{{ group.sub }}</p>
              @if (group.objects.length > 0) {
                <div class="flex flex-wrap justify-center gap-2">
                  @for (o of group.objects; track o.slug) {
                    <button
                      type="button"
                      [class]="isPicked(o.slug) ? pickedClass : unpickedClass"
                      [attr.aria-pressed]="isPicked(o.slug)"
                      [attr.data-testid]="'pair-moving-object-' + o.slug"
                      (click)="togglePicked(o.slug)"
                    >
                      @if (isPicked(o.slug)) {
                        <aec-icon name="check" decorative [size]="4" />
                      } @else if (icon(o.slug); as glyph) {
                        <aec-icon [name]="glyph" decorative [size]="4" />
                      }
                      <span>{{ o.name }}</span>
                    </button>
                  }
                </div>
              } @else {
                <p class="m-0 text-t-14 text-(--text-secondary)" i18n="@@pair.empty.moving.none">
                  None on record yet
                </p>
              }
            </div>
          }
        </div>

        <div class="mt-6 flex justify-center" aria-live="polite" data-testid="pair-moving-picked">
          <p
            class="m-0 inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-pill bg-(--surface-base) px-5 py-2.5 text-t-14 text-(--text-secondary) shadow-card"
          >
            @if (pickedNames().length > 0) {
              <span>
                <ng-container i18n="@@pair.empty.moving.mustMove">Matches must move</ng-container
                >&ngsp;
                <strong class="font-semibold text-(--text-primary)">{{ pickedList() }}</strong>
              </span>
              <button
                type="button"
                [class]="linkButton"
                (click)="clearPicked()"
                i18n="@@pair.empty.moving.clear"
              >
                Clear
              </button>
              <a [href]="matchesHref()" [class]="linkButton" i18n="@@pair.empty.moving.seeMatches"
                >See matches</a
              >
            } @else {
              <aec-icon name="info" decorative [size]="4" />
              <span i18n="@@pair.empty.moving.nothingPicked"
                >Nothing picked. Matches can move any data.</span
              >
            }
          </p>
        </div>
      </div>
    </section>

    <!-- Closest matches on record (AECI-1829), where mock-up 5 has them (ruling R6). -->
    <section
      id="pair-matches"
      aria-labelledby="pair-matches-title"
      class="bg-(--surface-base) text-(--text-primary)"
      data-testid="pair-empty-matches"
    >
      <div [class]="wrap">
        <div class="mb-8 flex flex-wrap items-end justify-between gap-6 md:mb-10">
          <div class="max-w-3xl">
            <p class="aec-overline mb-3 text-(--text-secondary)" i18n="@@pair.empty.matches.kicker">
              Closest matches on record
            </p>
            <h2 id="pair-matches-title" class="m-0">
              <span
                class="block font-display text-t-36 leading-[1.1] tracking-[-0.02em]"
                i18n="@@pair.empty.matches.heading"
                >Keep one product. See what it already connects to.</span
              >
            </h2>
            <p
              class="mt-4 text-t-16 leading-relaxed text-(--text-secondary)"
              i18n="@@pair.empty.matches.intro"
            >
              Every card opens a pair page we have on record, with its data objects, direction and
              attestations.
            </p>
          </div>
          <p class="m-0 text-end" aria-hidden="true">
            <span class="block font-display text-t-36 leading-none font-semibold tabular-nums"
              >{{ count(shown().length)
              }}<span class="ms-1 text-t-20 font-normal text-(--text-secondary)"
                ><ng-container i18n="@@pair.empty.matches.of">of</ng-container>
                {{ count(lane().matches.length) }}</span
              ></span
            >
            <span class="text-t-13 text-(--text-secondary)" i18n="@@pair.empty.matches.matchNow"
              >products match right now</span
            >
          </p>
        </div>

        <!-- The deck: keep toggle, category anchors, view toggle. -->
        <div
          class="grid gap-4 rounded-panel bg-(--surface-sunken) p-3 md:grid-cols-[auto_minmax(0,1fr)_auto] md:items-center md:gap-6 md:p-4"
        >
          <div
            role="group"
            class="flex gap-1 rounded-control bg-(--surface-base) p-1"
            i18n-aria-label="@@pair.empty.matches.keepGroup"
            aria-label="Which product do you keep"
          >
            @for (s of keepOptions(); track s.key) {
              <button
                type="button"
                [class]="keep() === s.key ? keepOn : keepOff"
                [attr.aria-pressed]="keep() === s.key"
                [attr.data-testid]="'pair-matches-keep-' + s.key"
                (click)="setKeep(s.key)"
              >
                <aec-logo-or-initial
                  [name]="s.product.name"
                  [src]="s.product.logo_url"
                  [alt]="logoAlt(s.product.name)"
                  [claimStatus]="s.product.claim_status"
                  size="sm"
                  class="[&>*]:size-6 [&>span]:text-t-12"
                />
                <span class="min-w-0 text-start">{{ s.label }}</span>
              </button>
            }
          </div>

          <div
            role="group"
            class="flex min-w-0 flex-wrap items-center gap-2"
            i18n-aria-label="@@pair.empty.matches.anchorsGroup"
            aria-label="Categories that define similar"
            data-testid="pair-matches-anchors"
          >
            @if (lane().anchors.length > 0) {
              <span class="text-t-14 text-(--text-secondary)">
                <strong class="font-semibold text-(--text-primary)">{{ similarTo() }}</strong
                >&ngsp;
                <ng-container i18n="@@pair.empty.matches.meansShares">means it shares</ng-container>
              </span>
              @for (c of lane().anchors; track c.slug) {
                <button
                  type="button"
                  [class]="isOn(c.slug) ? anchorOn : anchorOff"
                  [attr.aria-pressed]="isOn(c.slug)"
                  [attr.data-testid]="'pair-matches-anchor-' + c.slug"
                  (click)="toggleAnchor(c.slug)"
                >
                  <aec-icon [name]="isOn(c.slug) ? 'check' : 'plus'" decorative [size]="4" />
                  <span>{{ c.name }}</span>
                </button>
              }
            }
          </div>

          <div
            role="group"
            class="flex gap-1 justify-self-start rounded-control bg-(--surface-base) p-1 md:justify-self-end"
            i18n-aria-label="@@pair.empty.matches.viewGroup"
            aria-label="Show matches as"
          >
            <button
              type="button"
              [class]="view() === 'cards' ? keepOn : keepOff"
              [attr.aria-pressed]="view() === 'cards'"
              (click)="view.set('cards')"
            >
              <aec-icon name="grid" decorative [size]="4" />
              <span i18n="@@pair.empty.matches.cards">Cards</span>
            </button>
            <button
              type="button"
              [class]="view() === 'table' ? keepOn : keepOff"
              [attr.aria-pressed]="view() === 'table'"
              data-testid="pair-matches-view-table"
              (click)="view.set('table')"
            >
              <aec-icon name="rows" decorative [size]="4" />
              <span i18n="@@pair.empty.matches.table">Table</span>
            </button>
          </div>
        </div>

        <div class="mt-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <h3 class="m-0" data-testid="pair-matches-lane-heading">
            <span class="font-display text-t-24 font-semibold">{{ laneHeading() }}</span>
          </h3>
          <p
            class="m-0 text-t-14 text-(--text-secondary)"
            aria-live="polite"
            data-testid="pair-matches-count"
          >
            {{ countLine() }}
          </p>
        </div>
        <!-- STAGE_1_5_SPEC.md 11.3: the filter says rows with no recorded data are left out,
             never that those products do not move the data. -->
        @if (pickedNames().length > 0) {
          <p
            class="m-0 mt-1 text-t-13 text-(--text-secondary)"
            data-testid="pair-matches-picked-note"
          >
            <ng-container i18n="@@pair.empty.matches.mustMove">Must move</ng-container>&ngsp;<strong
              class="font-semibold text-(--text-primary)"
              >{{ pickedList() }}</strong
            >.&ngsp;<ng-container i18n="@@pair.empty.matches.leftOut"
              >Products with no data objects on record are left out.</ng-container
            >
            <button
              type="button"
              [class]="linkButton + ' ms-2'"
              (click)="clearPicked()"
              i18n="@@pair.empty.moving.clear"
            >
              Clear
            </button>
          </p>
        }

        <!-- The real order, in plain words (AECI-1829). Not the mock-up's text. -->
        <details class="group mt-3" data-testid="pair-matches-order">
          <summary
            class="inline-flex min-h-6 cursor-pointer items-center gap-2 rounded-control text-t-14 text-(--text-secondary) hover:text-(--text-primary) {{
              focusRing
            }}"
          >
            <aec-icon name="info" decorative [size]="4" />
            <span i18n="@@pair.empty.matches.orderSummary">How these are ordered</span>
            <aec-icon
              name="chevron-down"
              class="transition-transform group-open:rotate-180"
              decorative
              [size]="4"
            />
          </summary>
          <dl
            class="mt-3 grid gap-4 rounded-panel bg-(--surface-sunken) p-4 text-t-14 md:grid-cols-3"
          >
            <div>
              <dt class="font-semibold" i18n="@@pair.empty.matches.orderAz">A to Z</dt>
              <dd class="m-0 mt-1 text-(--text-secondary)" i18n="@@pair.empty.matches.orderAzBody">
                Products run A to Z by name. Nothing else changes the order.
              </dd>
            </div>
            <div>
              <dt class="font-semibold" i18n="@@pair.empty.matches.orderWho">Who appears</dt>
              <dd class="m-0 mt-1 text-(--text-secondary)" i18n="@@pair.empty.matches.orderWhoBody">
                A product appears when it has an integration on record with the product you keep and
                shares a category you left on with the other one. If you pick data above, it must
                move all of it.
              </dd>
            </div>
            <div>
              <dt class="font-semibold" i18n="@@pair.empty.matches.orderPaid">No paid places</dt>
              <dd
                class="m-0 mt-1 text-(--text-secondary)"
                i18n="@@pair.empty.matches.orderPaidBody"
              >
                No vendor pays for a place here. Plan or license status has no effect on who appears
                or the order.
              </dd>
            </div>
          </dl>
        </details>

        @if (emptyState(); as empty) {
          <div
            class="mt-8 grid items-center gap-4 rounded-card bg-(--surface-sunken) p-6 md:grid-cols-[minmax(0,1fr)_auto] md:p-8"
            data-testid="pair-matches-empty"
            [attr.data-empty]="empty"
          >
            <div>
              @switch (empty) {
                @case ('no-anchors') {
                  <p class="m-0 font-semibold" i18n="@@pair.empty.matches.emptyNoAnchorsTitle">
                    We have no categories on record for {{ swapName() }}, so nothing counts as
                    similar to it.
                  </p>
                }
                @case ('no-lane') {
                  <p class="m-0 font-semibold" i18n="@@pair.empty.matches.emptyNoLaneTitle">
                    None of {{ keptName() }}'s integrations on record are with products that share a
                    category with {{ swapName() }}.
                  </p>
                  <p
                    class="m-0 mt-1 text-t-14 text-(--text-secondary)"
                    i18n="@@pair.empty.matches.emptyNoLaneBody"
                  >
                    Try keeping the other product.
                  </p>
                }
                @case ('all-off') {
                  <p class="m-0 font-semibold" i18n="@@pair.empty.matches.emptyAllOffTitle">
                    No category is on, so nothing counts as similar to {{ swapName() }}.
                  </p>
                  <p
                    class="m-0 mt-1 text-t-14 text-(--text-secondary)"
                    i18n="@@pair.empty.matches.emptyAllOffBody"
                  >
                    Turn at least one category back on to see matches.
                  </p>
                }
                @case ('no-shared') {
                  <p class="m-0 font-semibold" i18n="@@pair.empty.matches.emptyNoSharedTitle">
                    No match shares a category you left on with {{ swapName() }}.
                  </p>
                  <p
                    class="m-0 mt-1 text-t-14 text-(--text-secondary)"
                    i18n="@@pair.empty.matches.emptyNoSharedBody"
                  >
                    Turn another category on to widen the list.
                  </p>
                }
                @case ('no-object') {
                  <p class="m-0 font-semibold" i18n="@@pair.empty.matches.emptyObjectsTitle">
                    No match has every data object you picked on record.
                  </p>
                  <p
                    class="m-0 mt-1 text-t-14 text-(--text-secondary)"
                    i18n="@@pair.empty.matches.emptyObjectsBody"
                  >
                    Products with no data objects on record are left out while data is picked.
                    Remove a data object or turn another category on to widen the list.
                  </p>
                }
              }
            </div>
            @if (empty === 'all-off' || empty === 'no-shared') {
              <button
                type="button"
                [class]="primaryButton"
                (click)="allAnchorsOn()"
                i18n="@@pair.empty.matches.allOn"
              >
                Turn all categories on
              </button>
            } @else if (empty === 'no-object') {
              <button
                type="button"
                [class]="primaryButton"
                (click)="clearPicked()"
                i18n="@@pair.empty.matches.clearObjects"
              >
                Clear data objects
              </button>
            } @else if (empty === 'no-lane') {
              <button type="button" [class]="primaryButton" (click)="setKeep(otherSide())">
                {{ keepLabel(otherSide()) }}
              </button>
            }
          </div>
        } @else if (view() === 'cards') {
          <ul [class]="cardsGrid()" data-testid="pair-matches-cards">
            @for (m of shown(); track m.product.id) {
              <li class="min-w-0">
                <article
                  aecCard
                  class="relative flex h-full flex-col gap-4 p-6 transition-shadow duration-base ease-standard hover:shadow-menu"
                >
                  <div class="flex min-w-0 items-center gap-3">
                    <aec-logo-or-initial
                      [name]="m.product.name"
                      [src]="m.product.logo_url"
                      [alt]="logoAlt(m.product.name)"
                      [claimStatus]="'server-filtered'"
                      size="sm"
                    />
                    <div class="min-w-0">
                      <h4
                        class="m-0 font-display text-t-20 leading-tight font-semibold break-words"
                      >
                        {{ m.product.name }}
                      </h4>
                      @if (m.vendor_name) {
                        <p
                          class="m-0 text-t-13 text-(--text-secondary)"
                          i18n="@@pair.empty.card.by"
                        >
                          by {{ m.vendor_name }}
                        </p>
                      }
                    </div>
                  </div>
                  <div class="grid gap-1.5 rounded-panel bg-(--surface-sunken) p-3 text-t-13">
                    <dl class="m-0 grid gap-1.5">
                      @for (r of ratingRows(m); track r.kind) {
                        <div class="flex items-center justify-between gap-2">
                          <dt class="text-(--text-secondary)">{{ r.label }}</dt>
                          <dd class="m-0 flex items-center gap-2">
                            @if (r.value !== null) {
                              <aec-review-stars [rating]="r.value" [kind]="r.kind" />
                              <span class="font-semibold tabular-nums">{{
                                r.value.toFixed(1)
                              }}</span>
                            } @else {
                              <span
                                class="text-(--text-secondary)"
                                i18n="@@products.detail.hero.notRated"
                                >Not yet rated</span
                              >
                            }
                          </dd>
                        </div>
                      }
                    </dl>
                    <p class="m-0 flex items-center gap-2 text-(--text-secondary)">
                      <aec-icon name="users" decorative [size]="4" />
                      <span>{{ reviewsLabel(m.review_count) }}</span>
                    </p>
                  </div>
                  <div class="space-y-2">
                    <p class="aec-overline m-0 text-(--text-secondary)">{{ sharesWith() }}</p>
                    <div class="flex flex-wrap gap-1.5">
                      @for (c of m.shared_categories; track c.slug) {
                        <aec-chip density="dense" icon="tag">{{ c.name }}</aec-chip>
                      }
                    </div>
                  </div>
                  <div class="space-y-2">
                    <p class="aec-overline m-0 text-(--text-secondary)">{{ movesWith() }}</p>
                    @if (direction(m); as d) {
                      <p class="m-0 flex items-center gap-1.5 text-t-14 font-semibold">
                        <span class="sr-only" i18n="@@pair.depth.direction.srLabel"
                          >Direction:</span
                        >
                        <span aria-hidden="true" class="text-(--accent-primary) rtl:-scale-x-100">{{
                          d.glyph
                        }}</span>
                        <span>{{ d.label }}</span>
                      </p>
                    }
                    @if (m.data_objects.length > 0) {
                      <div class="flex flex-wrap gap-1.5">
                        @for (o of m.data_objects; track o.slug) {
                          <aec-chip density="dense" [tone]="isPicked(o.slug) ? 'wash' : null">{{
                            o.name
                          }}</aec-chip>
                        }
                      </div>
                    } @else {
                      <p
                        class="m-0 text-t-13 text-(--text-secondary)"
                        i18n="@@pair.empty.card.noData"
                      >
                        No data listed yet
                      </p>
                    }
                  </div>
                  @if (m.confirmed) {
                    <p
                      class="m-0 inline-flex w-fit items-center gap-2 rounded-pill bg-(--accent-primary-soft) px-3 py-1 text-t-13 font-semibold text-(--accent-primary)"
                    >
                      <span
                        aria-hidden="true"
                        class="size-2 rounded-full bg-(--accent-primary)"
                      ></span>
                      <span i18n="@@pair.empty.card.confirmed">Confirmed by both companies</span>
                    </p>
                  }
                  <a
                    [routerLink]="pairLink(m)"
                    class="mt-auto flex items-center justify-between gap-3 border-t pt-4 text-t-14 font-semibold text-(--text-primary) no-underline after:absolute after:inset-0 after:rounded-card hover:text-(--accent-primary) {{
                      focusRing
                    }}"
                    [attr.data-testid]="'pair-match-link-' + m.product.slug"
                  >
                    <span class="min-w-0">{{ pairLabel(m) }}</span>
                    <aec-icon name="arrow-right" class="rtl:-scale-x-100" decorative [size]="4" />
                  </a>
                </article>
              </li>
            }
          </ul>
        } @else {
          <div
            class="mt-8 overflow-x-auto rounded-card shadow-card"
            data-testid="pair-matches-table"
          >
            <table
              class="w-full min-w-[56rem] border-collapse bg-(--surface-base) text-start text-t-14"
            >
              <caption class="sr-only" i18n="@@pair.empty.matches.tableCaption">
                Closest matches compared
              </caption>
              <thead class="bg-(--surface-sunken) text-t-13 text-(--text-secondary)">
                <tr>
                  <th scope="col" class="px-4 py-3 text-start font-semibold">{{ insteadOf() }}</th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-start font-semibold"
                    i18n="@@pair.empty.matches.colShares"
                  >
                    Shares
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-start font-semibold"
                    i18n="@@pair.empty.matches.colMoves"
                  >
                    Moves
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-start font-semibold"
                    i18n="@@pair.empty.matches.colDirection"
                  >
                    Direction
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-end font-semibold"
                    i18n="@@products.detail.hero.rating.overall"
                  >
                    Overall
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-end font-semibold"
                    i18n="@@products.detail.hero.rating.onboarding"
                  >
                    Onboarding
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-end font-semibold"
                    i18n="@@pair.empty.facts.reviews"
                  >
                    Reviews
                  </th>
                  <th
                    scope="col"
                    class="px-4 py-3 text-start font-semibold"
                    i18n="@@pair.empty.matches.colAgreement"
                  >
                    Agreement
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (m of shown(); track m.product.id) {
                  <tr class="border-t align-top">
                    <th scope="row" class="px-4 py-3 text-start font-normal">
                      <a
                        [routerLink]="pairLink(m)"
                        class="font-semibold text-(--text-primary) underline-offset-3 hover:text-(--accent-primary) hover:underline {{
                          focusRing
                        }}"
                        >{{ m.product.name }}</a
                      >
                      @if (m.vendor_name) {
                        <span
                          class="block text-t-13 text-(--text-secondary)"
                          i18n="@@pair.empty.card.by"
                          >by {{ m.vendor_name }}</span
                        >
                      }
                    </th>
                    <td class="px-4 py-3">{{ names(m.shared_categories) }}</td>
                    <td class="px-4 py-3">
                      @if (m.data_objects.length > 0) {
                        {{ names(m.data_objects) }}
                      } @else {
                        <span class="text-(--text-secondary)" i18n="@@pair.empty.card.noData"
                          >No data listed yet</span
                        >
                      }
                    </td>
                    <td class="px-4 py-3">{{ direction(m)?.label ?? '' }}</td>
                    <td class="px-4 py-3 text-end tabular-nums">
                      {{ m.rating_overall_avg?.toFixed(1) ?? notRated }}
                    </td>
                    <td class="px-4 py-3 text-end tabular-nums">
                      {{ m.rating_onboarding_avg?.toFixed(1) ?? notRated }}
                    </td>
                    <td class="px-4 py-3 text-end tabular-nums">{{ count(m.review_count) }}</td>
                    <td class="px-4 py-3">
                      @if (m.confirmed) {
                        <span i18n="@@pair.empty.card.confirmed">Confirmed by both companies</span>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (keptRecord() > 0) {
          <p class="mt-8 text-center">
            <a
              [routerLink]="['/products', keptProduct().slug]"
              fragment="integrations"
              class="inline-flex items-center gap-2 text-t-14 font-semibold text-(--accent-primary) underline-offset-4 hover:underline {{
                focusRing
              }}"
              data-testid="pair-matches-see-all"
            >
              {{ seeAllLabel() }}
              <aec-icon name="arrow-right" class="rtl:-scale-x-100" decorative [size]="4" />
            </a>
          </p>
        }
      </div>
    </section>
  `,
})
export class PairEmptyAlternatives {
  readonly context = input.required<ProductPairSubject>();
  readonly other = input.required<ProductPairSubject>();
  readonly alternatives = input.required<PairAlternatives>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly logoAlt = logoAlt;
  protected readonly focusRing = FOCUS_RING;
  protected readonly icon = objectIcon;
  protected readonly wrap = `${BAND_WRAP_CLASS} py-16 md:py-24`;
  protected readonly movingWrap = `${BAND_WRAP_CLASS} py-16`;
  protected readonly notRated = $localize`:@@products.detail.hero.notRated:Not yet rated`;

  /** A data-object or category toggle: the 36px pill with its field edge. */
  private readonly toggleBase = `aec-field-control inline-flex min-h-9 items-center gap-2 rounded-pill border px-3 text-t-14 transition-colors duration-fast ease-standard ${FOCUS_RING}`;
  protected readonly pickedClass = `${this.toggleBase} bg-(--accent-primary) font-semibold text-(--text-on-brand)`;
  protected readonly unpickedClass = `${this.toggleBase} bg-(--surface-base) text-(--text-primary) hover:bg-(--surface-sunken)`;
  protected readonly anchorOn = `${this.toggleBase} bg-(--accent-primary-soft) font-semibold text-(--accent-primary)`;
  protected readonly anchorOff = `${this.toggleBase} bg-(--surface-base) text-(--text-secondary)`;
  protected readonly keepOn = `inline-flex min-h-9 items-center gap-2 rounded-mark bg-(--accent-primary) px-3 text-t-14 font-semibold text-(--text-on-brand) ${FOCUS_RING}`;
  protected readonly keepOff = `inline-flex min-h-9 items-center gap-2 rounded-mark px-3 text-t-14 text-(--text-primary) hover:bg-(--surface-sunken) ${FOCUS_RING}`;
  protected readonly linkButton = `inline-flex min-h-6 items-center font-semibold text-(--accent-primary) underline underline-offset-4 ${FOCUS_RING}`;
  protected readonly primaryButton = `inline-flex min-h-11 items-center justify-center rounded-control bg-(--accent-primary) px-6 text-t-14 font-semibold text-(--text-on-brand) hover:bg-(--accent-primary-hover) ${FOCUS_RING}`;

  /** The lane: keep the first product by default, as the server renders it. */
  protected readonly keep = signal<Side>('context');
  /** Categories turned off, per lane. Every category starts on. */
  private readonly off = signal<Readonly<Record<Side, readonly string[]>>>({
    context: [],
    other: [],
  });
  /** Picked data objects: a match must move every one. */
  private readonly picked = signal<readonly string[]>([]);
  protected readonly view = signal<View>('cards');

  protected readonly lane = computed(() => this.alternatives().lanes[this.keep()]);
  protected readonly keptProduct = computed(() =>
    this.keep() === 'context' ? this.context() : this.other(),
  );
  private readonly swappedProduct = computed(() =>
    this.keep() === 'context' ? this.other() : this.context(),
  );
  protected readonly keptName = computed(() => this.keptProduct().name);
  protected readonly swapName = computed(() => this.swappedProduct().name);
  protected readonly otherSide = computed<Side>(() =>
    this.keep() === 'context' ? 'other' : 'context',
  );
  protected readonly keptRecord = computed(() => onRecord(this.keptProduct()));

  private readonly onAnchors = computed(() => {
    const off = new Set(this.off()[this.keep()]);
    return this.lane().anchors.filter((a) => !off.has(a.slug));
  });

  /** The lane's matches that pass the reader's filters, in the API's order (R1). */
  protected readonly shown = computed(() => {
    const on = new Set(this.onAnchors().map((a) => a.slug));
    if (on.size === 0) return [];
    const picked = this.picked();
    return this.lane().matches.filter(
      (m) =>
        m.shared_categories.some((c) => on.has(c.slug)) &&
        picked.every((p) => m.data_objects.some((d) => d.slug === p)),
    );
  });

  protected readonly emptyState = computed<
    'no-anchors' | 'no-lane' | 'all-off' | 'no-shared' | 'no-object' | null
  >(() => {
    const lane = this.lane();
    if (lane.anchors.length === 0) return 'no-anchors';
    if (lane.matches.length === 0) return 'no-lane';
    if (this.onAnchors().length === 0) return 'all-off';
    if (this.shown().length > 0) return null;
    // Nothing picked: the categories left on are what emptied the list, not the data.
    return this.picked().length === 0 ? 'no-shared' : 'no-object';
  });

  /** One to three results never leave a blank column (PLAN.md §10). */
  protected readonly cardsGrid = computed(() => {
    const n = this.shown().length;
    const cols = n >= 3 ? 'md:grid-cols-2 lg:grid-cols-3' : n === 2 ? 'md:grid-cols-2' : '';
    return `mt-8 grid list-none gap-6 p-0 ${cols}`;
  });

  protected readonly keepOptions = computed(() =>
    (['context', 'other'] as const).map((key) => ({
      key,
      product: key === 'context' ? this.context() : this.other(),
      label: this.keepLabel(key),
    })),
  );

  protected readonly groups = computed(() => {
    const a = this.context();
    const b = this.other();
    const m = this.alternatives().moving;
    return [
      {
        key: 'context-only',
        marks: [a],
        title: $localize`:@@pair.empty.moving.only:Only ${a.name}:PRODUCT:`,
        sub: this.acrossLabel(onRecord(a)),
        objects: m.context_only,
        tint: 'bg-(--accent-primary-soft)',
      },
      {
        key: 'both',
        marks: [a, b],
        title: $localize`:@@pair.empty.moving.both:Both exchange`,
        sub: $localize`:@@pair.empty.moving.bothSub:Each already moves these with other tools`,
        objects: m.both,
        tint: 'bg-(--surface-base)',
      },
      {
        key: 'other-only',
        marks: [b],
        title: $localize`:@@pair.empty.moving.only:Only ${b.name}:PRODUCT:`,
        sub: this.acrossLabel(onRecord(b)),
        objects: m.other_only,
        tint: 'bg-(--surface-base)',
      },
    ];
  });

  protected readonly pickedNames = computed(() => {
    const m = this.alternatives().moving;
    const all = [...m.context_only, ...m.both, ...m.other_only];
    return this.picked().map((slug) => all.find((o) => o.slug === slug)?.name ?? slug);
  });

  protected readonly pickedList = computed(() => this.list(this.pickedNames(), 'conjunction'));

  protected readonly similarTo = computed(
    () => $localize`:@@pair.empty.matches.similarTo:Similar to ${this.swapName()}:PRODUCT:`,
  );

  protected readonly laneHeading = computed(() => {
    const kept = this.keptName();
    const cats = this.onAnchors().map((a) => a.name);
    if (cats.length === 0) {
      return $localize`:@@pair.empty.matches.laneAll:Products that ${kept}:PRODUCT: connects to`;
    }
    const list = this.list(cats, 'disjunction');
    return $localize`:@@pair.empty.matches.lane:${list}:CATEGORIES: products that ${kept}:PRODUCT: connects to`;
  });

  protected readonly countLine = computed(() => {
    const shown = this.count(this.shown().length);
    const total = this.count(this.lane().matches.length);
    return $localize`:@@pair.empty.matches.countLine:${shown}:SHOWN: of ${total}:TOTAL: match`;
  });

  protected readonly sharesWith = computed(
    () => $localize`:@@pair.empty.card.sharesWith:Shares with ${this.swapName()}:PRODUCT:`,
  );
  protected readonly movesWith = computed(
    () => $localize`:@@pair.empty.card.movesWith:Moves with ${this.keptName()}:PRODUCT:`,
  );
  protected readonly insteadOf = computed(
    () => $localize`:@@pair.empty.matches.colInsteadOf:Instead of ${this.swapName()}:PRODUCT:`,
  );

  protected readonly seeAllLabel = computed(() => {
    const n = this.count(this.keptRecord());
    const kept = this.keptName();
    return this.keptRecord() === 1
      ? $localize`:@@pair.empty.matches.seeOne:See the ${kept}:PRODUCT: integration`
      : $localize`:@@pair.empty.matches.seeAll:See all ${n}:COUNT: ${kept}:PRODUCT: integrations`;
  });

  protected keepLabel(side: Side): string {
    const name = side === 'context' ? this.context().name : this.other().name;
    return $localize`:@@pair.empty.matches.keep:Keep ${name}:PRODUCT:`;
  }

  protected setKeep(side: Side): void {
    this.keep.set(side);
  }

  protected isOn(slug: string): boolean {
    return !this.off()[this.keep()].includes(slug);
  }

  protected toggleAnchor(slug: string): void {
    const side = this.keep();
    this.off.update((all) => {
      const now = all[side];
      return {
        ...all,
        [side]: now.includes(slug) ? now.filter((s) => s !== slug) : [...now, slug],
      };
    });
  }

  protected allAnchorsOn(): void {
    const side = this.keep();
    this.off.update((all) => ({ ...all, [side]: [] }));
  }

  protected isPicked(slug: string): boolean {
    return this.picked().includes(slug);
  }

  protected togglePicked(slug: string): void {
    this.picked.update((now) =>
      now.includes(slug) ? now.filter((s) => s !== slug) : [...now, slug],
    );
  }

  protected clearPicked(): void {
    this.picked.set([]);
  }

  /** The matches band on this page, an absolute path (a bare fragment breaks with base href). */
  protected matchesHref(): string {
    return `/products/${this.context().slug}/integrations/${this.other().slug}#pair-matches`;
  }

  protected pairLink(m: PairAlternativeMatch): readonly string[] {
    return ['/products', this.keptProduct().slug, 'integrations', m.product.slug];
  }

  protected pairLabel(m: PairAlternativeMatch): string {
    const kept = this.keptName();
    const match = m.product.name;
    return $localize`:@@pair.empty.card.pairLink:${kept}:KEPT: and ${match}:MATCH:`;
  }

  protected direction(m: PairAlternativeMatch) {
    const d = contextDirectionLabel(m.direction);
    return d.token ? d : null;
  }

  protected ratingRows(m: PairAlternativeMatch) {
    return [
      {
        kind: 'overall' as const,
        label: $localize`:@@products.detail.hero.rating.overall:Overall`,
        value: m.rating_overall_avg,
      },
      {
        kind: 'onboarding' as const,
        label: $localize`:@@products.detail.hero.rating.onboarding:Onboarding`,
        value: m.rating_onboarding_avg,
      },
    ];
  }

  protected reviewsLabel(count: number): string {
    if (count === 0) return $localize`:@@products.detail.hero.reviewCount.none:No reviews yet`;
    if (count === 1) return $localize`:@@products.detail.hero.reviewCount.one:1 review`;
    return $localize`:@@products.detail.hero.reviewCount.other:${count}:COUNT: reviews`;
  }

  protected names(terms: readonly IntegrationTerm[]): string {
    return this.list(
      terms.map((t) => t.name),
      'conjunction',
    );
  }

  protected count(value: number): string {
    return formatNumber(value, this.locale, '1.0-0');
  }

  private acrossLabel(n: number): string {
    if (n === 0) {
      return $localize`:@@pair.empty.moving.acrossNone:No integrations on record yet`;
    }
    const count = this.count(n);
    return n === 1
      ? $localize`:@@pair.empty.moving.acrossOne:Across its 1 integration on record`
      : $localize`:@@pair.empty.moving.across:Across its ${count}:COUNT: integrations on record`;
  }

  /** "A, B or C" in the page's locale. The input order is kept: nothing is sorted here. */
  private list(items: readonly string[], type: 'conjunction' | 'disjunction'): string {
    return new Intl.ListFormat(this.locale, { style: 'long', type }).format(items);
  }
}

function onRecord(p: ProductPairSubject): number {
  return integrationsOnRecordCount(p.integration_count, p.listed_integration_count ?? 0);
}
