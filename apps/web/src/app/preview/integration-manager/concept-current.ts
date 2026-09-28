import { ChangeDetectionStrategy, Component, signal } from '@angular/core';

import { IM_STYLES } from './im-ui';

/**
 * "Current": a static recreation of today's per-integration panel for the
 * Navisworks case, so the four concepts can be compared against it. The copy is
 * today's copy, verbatim, including the terms the redesign replaces. It does not
 * reuse the real components (they need the portal store and a session). Only the
 * disclosures open and close.
 */
@Component({
  selector: 'aec-im-concept-current',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [IM_STYLES],
  template: `
    <h2 class="im-h2 text-(--text-primary)">Integrations</h2>
    <p class="mt-1 max-w-prose text-sm text-(--text-secondary)">
      Every integration touching AutoCAD Architecture, grouped by the other product.
    </p>

    <div class="mt-6 space-y-3">
      <section
        class="overflow-hidden rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
      >
        <div class="flex flex-wrap items-center gap-x-3 pe-4">
          <h3 class="m-0 min-w-0 flex-1">
            <button
              type="button"
              [attr.aria-expanded]="groupOpen()"
              aria-controls="im-current-panel"
              (click)="groupOpen.set(!groupOpen())"
              class="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-start text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
            >
              <svg
                aria-hidden="true"
                class="h-4 w-4 shrink-0 text-(--text-secondary) transition-transform"
                [class.rotate-90]="groupOpen()"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <span
                aria-hidden="true"
                class="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) bg-(--surface-sunken) font-body text-xs font-semibold"
                >N</span
              >
              <span class="min-w-0 flex-1">
                <span class="block font-display text-lg font-semibold">Navisworks</span>
                <span class="mt-0.5 block font-body text-xs font-normal text-(--text-secondary)"
                  >2 data flows</span
                >
              </span>
              <span class="flex font-body">
                <span
                  class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2 py-0.5 text-xs font-semibold text-(--text-primary)"
                >
                  <span
                    aria-hidden="true"
                    class="h-1.5 w-1.5 rounded-full bg-(--text-tertiary)"
                  ></span>
                  You have responded
                </span>
              </span>
            </button>
          </h3>
          <a
            href="/products/autocad-architecture/integrations/navisworks"
            class="text-sm font-medium text-(--accent-primary)"
            >View public page</a
          >
        </div>

        <div
          id="im-current-panel"
          role="region"
          aria-label="Navisworks"
          [hidden]="!groupOpen()"
          class="border-t border-(--border-default) bg-(--surface-base)"
        >
          <header class="border-b border-(--border-default) bg-(--surface-sunken) px-5 py-2.5">
            <p class="text-xs text-(--text-secondary)">
              <span class="font-semibold text-(--text-primary)"
                >The only integration on record with Navisworks</span
              >
              <span aria-hidden="true"> · </span>
              <span>Native · Navisworks DWG file reader</span>
              <span aria-hidden="true"> · </span>
              <span>On record from AEC Integrations · You own both sides of this integration</span>
            </p>
          </header>

          <ul class="m-0 list-none p-0">
            @for (lane of lanes; track lane.name) {
              <li class="border-b border-(--border-default)">
                <button
                  type="button"
                  [attr.aria-expanded]="openLane() === lane.name"
                  (click)="openLane.set(openLane() === lane.name ? null : lane.name)"
                  class="flex w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3 text-start hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                >
                  <span class="flex min-w-0 flex-1 items-center gap-3">
                    <svg
                      aria-hidden="true"
                      class="h-4 w-4 shrink-0 text-(--text-secondary) transition-transform"
                      [class.rotate-90]="openLane() === lane.name"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                    <span class="min-w-0">
                      <span class="block text-sm font-semibold text-(--text-primary)">{{
                        lane.name
                      }}</span>
                      <span class="mt-0.5 block text-xs text-(--text-secondary)"
                        ><span aria-hidden="true">→</span> Sends to Navisworks</span
                      >
                    </span>
                  </span>
                  <span class="flex items-center gap-3">
                    <span class="text-xs text-(--text-secondary)">You confirm this flow</span>
                    <span
                      class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default) px-2.5 py-1 text-xs font-medium text-(--text-primary)"
                    >
                      <span
                        aria-hidden="true"
                        class="h-1.5 w-1.5 rounded-full bg-(--text-tertiary)"
                      ></span>
                      Confirmed by Autodesk
                    </span>
                  </span>
                </button>
                @if (openLane() === lane.name) {
                  <div class="px-5 pb-4 ps-12">
                    <p class="text-xs text-(--text-secondary)">On record from AEC Integrations</p>
                    <p class="mt-0.5 text-xs text-(--text-secondary)">
                      Neither vendor has confirmed this yet.
                    </p>
                    <p class="mt-2 text-xs text-(--text-secondary)">
                      Nobody else holds this flow, so there is no one for us to ask. It shows on the
                      public listing as confirmed by one vendor.
                    </p>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        class="rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm"
                      >
                        Affirm
                      </button>
                      <button
                        type="button"
                        class="rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm"
                      >
                        Deny
                      </button>
                      <button
                        type="button"
                        class="rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm"
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                }
              </li>
            }
          </ul>

          <details class="border-t border-(--border-default) px-5 py-4">
            <summary class="cursor-pointer text-sm font-medium text-(--text-primary)">
              Add a data flow
            </summary>
            <p class="mt-3 text-xs text-(--text-secondary)">
              Data object, Direction, Note (optional), versions.
            </p>
          </details>

          <div class="border-t border-(--border-default) px-5 py-4">
            <p class="max-w-prose text-sm text-(--text-primary)">
              No owner is on file for this integration. If your company offers it, contest the Owner
              field below and AEC Integrations will review it.
            </p>
          </div>

          <div class="border-t border-(--border-default) px-5 py-4">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="max-w-prose space-y-1">
                <p class="text-sm font-semibold text-(--text-primary)">Your links</p>
                <p class="text-xs text-(--text-secondary)">
                  Links for AutoCAD Architecture on the public pair page.
                </p>
                <dl class="mt-2 space-y-1 text-xs">
                  <div class="flex gap-2">
                    <dt class="text-(--text-secondary)">Listing</dt>
                    <dd class="text-(--text-primary)">
                      https://www.autodesk.com/products/navisworks
                    </dd>
                  </div>
                  <div class="flex gap-2">
                    <dt class="text-(--text-secondary)">Docs</dt>
                    <dd class="text-(--text-primary)">Not set</dd>
                  </div>
                </dl>
              </div>
              <button
                type="button"
                class="rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium"
              >
                Edit your links
              </button>
            </div>
          </div>

          <div class="border-t border-(--border-default) px-5 py-4">
            <p class="text-xs text-(--text-secondary)">
              You have an open contest on this integration: Owner. Follow it in Messages.
            </p>
            <button
              type="button"
              class="mt-3 rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium"
            >
              Contest a field
            </button>
          </div>
        </div>
      </section>

      @for (other of others; track other.name) {
        <section
          class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised)"
        >
          <h3 class="m-0">
            <button
              type="button"
              aria-expanded="false"
              class="flex w-full items-center gap-3 px-4 py-3 text-start text-(--text-primary) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
            >
              <svg
                aria-hidden="true"
                class="h-4 w-4 shrink-0 text-(--text-secondary)"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m9 6 6 6-6 6" />
              </svg>
              <span class="min-w-0 flex-1">
                <span class="block font-display text-lg font-semibold">{{ other.name }}</span>
                <span class="mt-0.5 block font-body text-xs font-normal text-(--text-secondary)">{{
                  other.sub
                }}</span>
              </span>
              <span
                class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default) bg-(--surface-base) px-2 py-0.5 font-body text-xs font-semibold"
                >{{ other.pill }}</span
              >
            </button>
          </h3>
        </section>
      }
    </div>
  `,
})
export class ConceptCurrent {
  protected readonly groupOpen = signal(true);
  protected readonly openLane = signal<string | null>(null);
  protected readonly lanes = [{ name: 'Models' }, { name: 'Drawings' }];
  protected readonly others = [
    { name: 'Procore', sub: '2 data flows · 1 in conflict', pill: 'Conflict' },
    { name: 'Bluebeam Revu', sub: '2 data flows · 1 needs your input', pill: 'Needs your input' },
    { name: 'Smartsheet', sub: '1 data flow', pill: 'Via connector' },
  ];
}
