import { Component, LOCALE_ID, afterNextRender, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminLegalAcceptanceVersion } from '@aeci/shared';

import { formatTermDate } from '../../shared/term-date/format-term-date';
import { AdminLegalApi } from './admin-legal-api';
import { CONSOLE_LABEL_CLASS } from '../console/console-table';
import { LEGAL_CLASSES } from './legal-classes';

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
    <section class="grid gap-4" aria-labelledby="admin-legal-acceptances-h">
      <div class="grid gap-2">
        <h2 id="admin-legal-acceptances-h" i18n="@@admin.legal.acceptances.heading">
          Who has accepted
        </h2>
        <p [class]="c.caption" i18n="@@admin.legal.acceptances.lead">
          Each version that is in force, dated or published, and the companies that hold an
          acceptance of it or a later version. An acceptance of a draft never counts. Vendor Terms
          count every company with a seat. The Managed plan agreement counts companies with a live
          monthly card subscription.
        </p>
      </div>

      @switch (load().state) {
        @case ('loading') {
          <p [class]="c.statusLine" i18n="@@admin.legal.acceptances.loading">Loading…</p>
        }
        @case ('error') {
          <p [class]="c.failedText" role="alert" i18n="@@admin.legal.acceptances.error">
            Could not load the acceptance counts. Reload the page to try again.
          </p>
        }
        @default {
          @for (v of versions(); track v.document + v.version) {
            <article
              [class]="c.panel"
              [attr.aria-labelledby]="'acc-' + v.document + '-' + v.version"
              data-testid="acceptances-version"
            >
              <div class="grid gap-1">
                <h3 [id]="'acc-' + v.document + '-' + v.version">{{ titleOf(v) }}</h3>
                <p [class]="c.caption">{{ statusOf(v) }}</p>
              </div>
              <dl [class]="c.pairs">
                <dt [class]="dtClass" i18n="@@admin.legal.acceptances.accepted">Accepted</dt>
                <dd [class]="c.countValue" data-testid="acceptances-accepted">
                  {{ v.accepted_count }}
                </dd>
                <dt [class]="dtClass" i18n="@@admin.legal.acceptances.notYet">Not yet</dt>
                <dd [class]="c.countValue" data-testid="acceptances-not-yet">
                  {{ v.not_yet_count }}
                </dd>
              </dl>
              @if (v.not_yet.length > 0) {
                <ul class="columns-1 gap-6 text-t-14 sm:columns-2 lg:columns-3">
                  @for (c of v.not_yet; track c.vendor_id) {
                    <li class="break-inside-avoid py-1">
                      <a [routerLink]="['/admin/vendors', c.vendor_id]" [class]="linkClass">{{
                        c.company_name
                      }}</a>
                    </li>
                  }
                </ul>
              }
            </article>
          } @empty {
            <p
              [class]="c.statusLine"
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

  protected readonly c = LEGAL_CLASSES;
  /** A count's term: the Label role. */
  protected readonly dtClass = CONSOLE_LABEL_CLASS;
  /** A company link: the console's inline link look. */
  protected readonly linkClass = LEGAL_CLASSES.inlineLink;

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
