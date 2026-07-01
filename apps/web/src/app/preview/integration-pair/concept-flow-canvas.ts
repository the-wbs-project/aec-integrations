import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { mechanismKindLabel } from '../../search/mechanism-labels';

import { AgreementBadge } from './agreement-badge';
import { ClaimProvenance } from './claim-provenance';
import { COPY, renderedGroups, type PairView, type ProductRef } from './integration-pair.fixtures';

/**
 * Concept **b · Flow canvas** — deliberately breaks the two-column shell for a
 * full-bleed rail: the context product is anchored **left**, the other product
 * **right**, and each mechanism's claims sit in directional lanes whose big
 * arrow (→ / ← / ⇄) reads spatially. Flipping the orientation reverses the whole
 * rail *and* the arrows together, so this is the concept that best dramatizes
 * the mirror.
 *
 * Anchor exception: the "data in ← node → data out" spine is pulled from
 * **Customer.io** (recorded as a deliberate exception to the GitBook anchor, per
 * the Anchor-Site Rule). Prototype-only (AECI-289).
 */
@Component({
  selector: 'app-ip-concept-flow',
  imports: [RouterLink, LogoOrInitial, AgreementBadge, ClaimProvenance],
  template: `
    @let v = view();
    <div class="bg-(--surface-base) text-(--text-primary)">
      <div class="mx-auto w-full max-w-6xl px-6 py-8 md:px-8 md:py-12">
        <nav aria-label="Breadcrumb" class="mb-6">
          <ol class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)">
            <li>
              <a routerLink="/" class="no-underline hover:text-(--accent-primary)">Home</a>
            </li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li>
              <a
                [routerLink]="['/products', v.context.slug]"
                class="no-underline hover:text-(--accent-primary)"
                >{{ v.context.name }}</a
              >
            </li>
            <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
            <li class="text-(--text-primary)" aria-current="page">{{ v.other.name }}</li>
          </ol>
        </nav>

        <header class="mb-8 space-y-3">
          <p class="aec-overline text-(--text-secondary)">Integration</p>
          <h1
            class="font-display text-3xl font-semibold tracking-tight text-(--text-primary) sm:text-4xl"
          >
            How {{ v.context.name }} and {{ v.other.name }} exchange data
          </h1>
        </header>

        <!-- The rail: context (left) ⇄ other (right). Context is always left; the
             per-lane arrows below carry direction. -->
        <div
          class="grid grid-cols-[1fr_auto_1fr] items-center gap-4 rounded-(--radius-xl) border border-(--border-default) bg-(--surface-raised) p-6 md:gap-8 md:p-8"
        >
          <div class="flex flex-col items-center gap-2 text-center">
            <aec-logo-or-initial [name]="v.context.name" [src]="v.context.logo_url" size="lg" />
            <span class="font-display text-lg text-(--text-primary)">{{ v.context.name }}</span>
            <span class="text-xs text-(--text-tertiary)">{{ v.context.vendorName }}</span>
            <span
              class="inline-flex items-center gap-1 text-xs text-(--text-secondary)"
              [attr.aria-label]="ratingAria(v.context)"
            >
              <span aria-hidden="true" class="text-(--accent-rating)">★</span>
              <span class="tabular-nums">{{ v.context.rating.toFixed(1) }}</span>
              <span class="text-(--text-tertiary)">· {{ v.context.reviewCount }} reviews</span>
            </span>
            <a
              [href]="v.context.reviewsPath"
              class="text-xs text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              >Read reviews</a
            >
          </div>
          <span class="font-display text-3xl text-(--text-tertiary)" aria-hidden="true">⇄</span>
          <div class="flex flex-col items-center gap-2 text-center">
            <aec-logo-or-initial [name]="v.other.name" [src]="v.other.logo_url" size="lg" />
            <span class="font-display text-lg text-(--text-primary)">{{ v.other.name }}</span>
            <span class="text-xs text-(--text-tertiary)">{{ v.other.vendorName }}</span>
            <span
              class="inline-flex items-center gap-1 text-xs text-(--text-secondary)"
              [attr.aria-label]="ratingAria(v.other)"
            >
              <span aria-hidden="true" class="text-(--accent-rating)">★</span>
              <span class="tabular-nums">{{ v.other.rating.toFixed(1) }}</span>
              <span class="text-(--text-tertiary)">· {{ v.other.reviewCount }} reviews</span>
            </span>
            <a
              [href]="v.other.reviewsPath"
              class="text-xs text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              >Read reviews</a
            >
          </div>
        </div>

        <!-- Sync headline: Bone accent band (accent surface, not page bg). -->
        <div
          class="mt-6 rounded-(--radius-xl) border border-(--border-default) bg-(--accent-warm) p-6 text-center"
        >
          <p class="font-display text-3xl leading-tight text-(--text-primary)">
            {{ v.total > 0 ? copy.syncHeadline(v.total) : copy.emptyHeadline }}
          </p>
          <p class="mt-2 text-sm text-(--text-secondary)">{{ copy.syncSubline }}</p>
          @if (v.total > 0) {
            <!-- text-secondary (not tertiary): tertiary fails AA contrast on the Bone band. -->
            <p class="mt-2 text-xs tabular-nums text-(--text-secondary)">
              {{ copy.confirmedRatio(v.confirmed, v.total) }}
            </p>
          }
        </div>

        <!-- Per-mechanism cards with directional lanes. -->
        <div class="mt-8 space-y-6">
          @for (m of v.mechanisms; track m.id) {
            <article
              class="space-y-5 rounded-(--radius-xl) border border-(--border-default) bg-(--surface-base) p-6"
            >
              <header class="flex flex-wrap items-center gap-3">
                <span
                  class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em] text-(--text-secondary)"
                  >{{ mechanismLabel(m.kind) }}</span
                >
                <h2 class="font-display text-xl text-(--text-primary)">{{ m.name }}</h2>
              </header>

              <p class="max-w-3xl text-sm leading-relaxed text-(--text-secondary)">
                {{ m.description }}
              </p>

              @if (m.claims.length > 0) {
                @for (g of groups(m, v.other.name); track g.direction) {
                  <div
                    class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised) p-4"
                  >
                    <div class="flex items-center gap-3">
                      <span
                        class="font-display text-2xl text-(--accent-primary)"
                        [attr.aria-label]="g.aria"
                        >{{ g.glyph }}</span
                      >
                      <h3 class="aec-overline text-(--text-secondary)">{{ g.heading }}</h3>
                    </div>
                    <ul class="mt-3 grid gap-2 sm:grid-cols-2">
                      @for (c of g.claims; track c.dataObjectSlug + c.direction) {
                        <li
                          class="flex items-center justify-between gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2"
                        >
                          <span class="text-sm text-(--text-primary)">{{ c.dataObjectName }}</span>
                          <span class="flex items-center gap-2">
                            <app-ip-agreement-badge />
                            <app-ip-claim-provenance [claim]="c" />
                          </span>
                        </li>
                      }
                    </ul>
                  </div>
                }
              } @else {
                <p class="text-sm text-(--text-tertiary)">{{ copy.emptyHeadline }}</p>
              }
            </article>
          }
        </div>
      </div>
    </div>
  `,
})
export class ConceptFlowCanvas {
  readonly view = input.required<PairView>();

  protected readonly copy = COPY;
  protected groups = renderedGroups;

  protected mechanismLabel(kind: string): string {
    return mechanismKindLabel(kind);
  }

  protected ratingAria(p: ProductRef): string {
    return `${p.name} rated ${p.rating.toFixed(1)} out of 5 from ${p.reviewCount} reviews`;
  }
}
