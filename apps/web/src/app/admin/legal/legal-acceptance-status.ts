import { Component, LOCALE_ID, afterNextRender, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminLegalAcceptanceVersion } from '@aeci/shared';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { AdminLegalApi } from './admin-legal-api';

type Load =
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ready'; versions: readonly AdminLegalAcceptanceVersion[] };

/**
 * "Who has accepted" on `/admin/legal` (AECI-1677, `ADMIN_PANEL_SPEC.md` §5.22a): for each
 * final version of each agreement, the accepted and not-yet counts and the companies not
 * yet counted. The effective-date change reads it to list who the acceptance screen will
 * block (ruling 24). Its own component, apart from the publish form and the change-notice
 * section (AECI-1620). A read: loads in `afterNextRender`, never rate-limited.
 */
@Component({
  selector: 'aec-admin-legal-acceptance-status',
  imports: [RouterLink],
  host: { class: 'block' },
  template: `
    <section class="mt-12" aria-labelledby="admin-legal-acceptances-h">
      <h2
        id="admin-legal-acceptances-h"
        class="font-display text-xl font-semibold text-(--text-primary)"
        i18n="@@admin.legal.acceptances.heading"
      >
        Who has accepted
      </h2>
      <p
        class="mt-2 max-w-prose text-sm text-(--text-secondary)"
        i18n="@@admin.legal.acceptances.lead"
      >
        Each version that is in force, dated or published, and the companies that hold an acceptance
        of it or a later version. An acceptance of a draft never counts. Vendor Terms count every
        company with a seat. The Managed plan agreement counts companies with a live monthly card
        subscription.
      </p>

      @switch (load().state) {
        @case ('loading') {
          <p class="mt-4 text-sm text-(--text-secondary)" i18n="@@admin.legal.acceptances.loading">
            Loading…
          </p>
        }
        @case ('error') {
          <p
            class="mt-4 text-sm font-medium text-(--text-primary)"
            role="alert"
            i18n="@@admin.legal.acceptances.error"
          >
            Could not load the acceptance counts. Reload the page to try again.
          </p>
        }
        @default {
          @for (v of versions(); track v.document + v.version) {
            <article
              class="mt-6 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-5"
              [attr.aria-labelledby]="'acc-' + v.document + '-' + v.version"
              data-testid="acceptances-version"
            >
              <h3
                [id]="'acc-' + v.document + '-' + v.version"
                class="text-base font-bold text-(--text-primary)"
              >
                {{ titleOf(v) }}
              </h3>
              <p class="mt-1 text-sm text-(--text-secondary)">{{ statusOf(v) }}</p>
              <dl class="mt-3 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-sm">
                <dt class="text-(--text-secondary)" i18n="@@admin.legal.acceptances.accepted">
                  Accepted
                </dt>
                <dd class="tabular-nums text-(--text-primary)" data-testid="acceptances-accepted">
                  {{ v.accepted_count }}
                </dd>
                <dt class="text-(--text-secondary)" i18n="@@admin.legal.acceptances.notYet">
                  Not yet
                </dt>
                <dd class="tabular-nums text-(--text-primary)" data-testid="acceptances-not-yet">
                  {{ v.not_yet_count }}
                </dd>
              </dl>
              @if (v.not_yet.length > 0) {
                <ul class="mt-3 columns-1 gap-6 text-sm sm:columns-2 lg:columns-3">
                  @for (c of v.not_yet; track c.vendor_id) {
                    <li class="break-inside-avoid py-0.5">
                      <a
                        [routerLink]="['/admin/vendors', c.vendor_id]"
                        class="text-(--text-primary) underline underline-offset-2 hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                        >{{ c.company_name }}</a
                      >
                    </li>
                  }
                </ul>
              }
            </article>
          } @empty {
            <p
              class="mt-4 text-sm text-(--text-secondary)"
              data-testid="acceptances-empty"
              i18n="@@admin.legal.acceptances.empty"
            >
              No version is in force, dated or published yet, so nothing is counted. The acceptance
              screen shows to no one.
            </p>
          }
        }
      }
    </section>
  `,
})
export class AdminLegalAcceptanceStatus {
  private readonly api = inject(AdminLegalApi);
  private readonly locale = inject(LOCALE_ID);

  protected readonly load = signal<Load>({ state: 'loading' });

  protected versions(): readonly AdminLegalAcceptanceVersion[] {
    const l = this.load();
    return l.state === 'ready' ? l.versions : [];
  }

  constructor() {
    afterNextRender(() => void this.fetch());
  }

  private async fetch(): Promise<void> {
    try {
      const res = await this.api.acceptances();
      this.load.set({ state: 'ready', versions: res.versions });
    } catch {
      this.load.set({ state: 'error' });
    }
  }

  protected titleOf(v: AdminLegalAcceptanceVersion): string {
    const version = v.version;
    return v.document === 'vendor_terms'
      ? $localize`:@@admin.legal.acceptances.titleTerms:Vendor Terms, version ${version}:VERSION:`
      : $localize`:@@admin.legal.acceptances.titleManaged:Managed plan agreement, version ${version}:VERSION:`;
  }

  protected statusOf(v: AdminLegalAcceptanceVersion): string {
    const date = formatTermDate(v.effective_at, this.locale);
    const base = v.in_force
      ? $localize`:@@admin.legal.acceptances.inForce:In force since ${date}:DATE:.`
      : $localize`:@@admin.legal.acceptances.upcoming:Takes effect on ${date}:DATE:.`;
    if (v.requires_acceptance === true) {
      return `${base} ${$localize`:@@admin.legal.acceptances.needs:Published, needs acceptance.`}`;
    }
    if (v.published) {
      return `${base} ${$localize`:@@admin.legal.acceptances.published:Published.`}`;
    }
    return base;
  }
}
