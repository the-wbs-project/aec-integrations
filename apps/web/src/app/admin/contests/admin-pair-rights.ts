import { DatePipe } from '@angular/common';
import { Component, afterNextRender, inject, signal } from '@angular/core';

import type { AdminVeto, PairContest, PairRightPair } from '@aeci/shared';

import { AdminContestsApi } from './admin-contests-api';

type Form = { id: string; kind: 'accept' | 'decline' | 'lift' | 'upheld' | 'rejected' } | null;

/**
 * Sync Service pair reports and endpoint vetoes on `/admin/contests` (AECI-2042,
 * `ADMIN_PANEL_SPEC.md` §5.12, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11e).
 *
 * Three lists below the field contests, with the same one-decision-at-a-time,
 * pessimistic pattern:
 *
 * - **Reports AEC Integrations decides**: existence reports, and data flow reports on
 *   unclaimed pairs. Accept needs a note; an existence accept also needs a proof link,
 *   and on a vendor-held pair it retires the pair. Data flow reports on a claimed pair
 *   are the owner's and are listed read-only.
 * - **Reviews of an owner's answer**: protests. Upheld or rejected, with a note. Advice
 *   only: nothing on the listing changes.
 * - **Removals in force**: endpoint vetoes. Not judged. "End this removal" exists for a
 *   veto filed through a seat that should not have had it, and needs a note.
 */
@Component({
  selector: 'aec-admin-pair-rights',
  imports: [DatePipe],
  host: { class: 'block' },
  template: `
    <section class="mt-10 space-y-6" aria-labelledby="admin-pair-rights-heading">
      <h3 id="admin-pair-rights-heading" class="m-0">
        <span
          class="block font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@admin.pairRights.heading"
          >Sync Service integrations</span
        >
      </h3>

      <div class="space-y-3" data-admin-pair-reports>
        <h4 class="text-base font-semibold text-(--text-primary)" i18n="@@admin.pairRights.reports">
          Reports
        </h4>
        @if (reports().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@admin.pairRights.reports.empty">
            No open reports.
          </p>
        }
        <ul class="m-0 list-none space-y-3 p-0">
          @for (r of reports(); track r.id) {
            <li class="rounded-(--radius-md) border border-(--border-default) p-4 text-sm">
              <p class="font-medium text-(--text-primary)">{{ title(r) }}</p>
              <p class="text-(--text-secondary)" i18n="@@admin.pairRights.reports.from">
                {{ r.submitter_name }} on {{ r.created_at | date: 'mediumDate' }}: {{ r.reason }}
              </p>
              @if (r.routed_to === 'owner') {
                <p class="text-(--text-secondary)" i18n="@@admin.pairRights.reports.owner">
                  With the owner, {{ r.owner_name }}. The owner decides.
                </p>
              } @else {
                <div class="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    [class]="buttonClass"
                    (click)="openForm(r.id, 'accept')"
                    i18n="@@admin.pairRights.accept"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    [class]="buttonClass"
                    (click)="openForm(r.id, 'decline')"
                    i18n="@@admin.pairRights.decline"
                  >
                    Decline
                  </button>
                </div>
                @if (form()?.id === r.id) {
                  <form
                    method="dialog"
                    class="mt-3 space-y-2"
                    (submit)="$event.preventDefault(); decide(r)"
                  >
                    @if (form()?.kind === 'accept' && r.kind === 'existence') {
                      <p
                        class="text-(--text-secondary)"
                        i18n="@@admin.pairRights.accept.existenceHelp"
                      >
                        On a vendor-held pair this retires it now. On a pair AEC Integrations holds,
                        retract it in the review app.
                      </p>
                    }
                    <label
                      class="block font-medium"
                      for="rpt-note-{{ r.id }}"
                      i18n="@@admin.pairRights.note"
                      >Note shown to the vendor</label
                    >
                    <textarea
                      id="rpt-note-{{ r.id }}"
                      rows="3"
                      maxlength="1000"
                      class="w-full rounded-(--radius-sm) border border-(--border-default) p-2"
                      (input)="note.set(valueOf($event))"
                    ></textarea>
                    @if (form()?.kind === 'accept' && r.kind === 'existence') {
                      <label
                        class="block font-medium"
                        for="rpt-src-{{ r.id }}"
                        i18n="@@admin.pairRights.source"
                        >Proof link (required)</label
                      >
                      <input
                        id="rpt-src-{{ r.id }}"
                        type="url"
                        class="w-full rounded-(--radius-sm) border border-(--border-default) p-2"
                        (input)="source.set(valueOf($event))"
                      />
                    }
                    <button
                      type="submit"
                      [class]="buttonClass"
                      [disabled]="busy()"
                      i18n="@@admin.pairRights.confirm"
                    >
                      Confirm
                    </button>
                  </form>
                }
              }
            </li>
          }
        </ul>
      </div>

      <div class="space-y-3" data-admin-pair-protests>
        <h4
          class="text-base font-semibold text-(--text-primary)"
          i18n="@@admin.pairRights.protests"
        >
          Reviews of an owner's answer
        </h4>
        @if (protests().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@admin.pairRights.protests.empty">
            No open reviews.
          </p>
        }
        <ul class="m-0 list-none space-y-3 p-0">
          @for (r of protests(); track r.id) {
            <li class="rounded-(--radius-md) border border-(--border-default) p-4 text-sm">
              <p class="font-medium text-(--text-primary)">{{ title(r) }}</p>
              <p class="text-(--text-secondary)">{{ r.protest?.reason }}</p>
              <p class="text-(--text-secondary)" i18n="@@admin.pairRights.protests.advice">
                Your answer is advice. It does not change the listing.
              </p>
              <div class="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  [class]="buttonClass"
                  (click)="openForm(r.id, 'upheld')"
                  i18n="@@admin.pairRights.upheld"
                >
                  Agree with the report
                </button>
                <button
                  type="button"
                  [class]="buttonClass"
                  (click)="openForm(r.id, 'rejected')"
                  i18n="@@admin.pairRights.rejected"
                >
                  Agree with the owner
                </button>
              </div>
              @if (form()?.id === r.id) {
                <form
                  method="dialog"
                  class="mt-3 space-y-2"
                  (submit)="$event.preventDefault(); decideProtest(r)"
                >
                  <label
                    class="block font-medium"
                    for="pp-note-{{ r.id }}"
                    i18n="@@admin.pairRights.noteRequired"
                    >Note shown to both vendors (required)</label
                  >
                  <textarea
                    id="pp-note-{{ r.id }}"
                    rows="3"
                    maxlength="1000"
                    required
                    class="w-full rounded-(--radius-sm) border border-(--border-default) p-2"
                    (input)="note.set(valueOf($event))"
                  ></textarea>
                  <button
                    type="submit"
                    [class]="buttonClass"
                    [disabled]="busy()"
                    i18n="@@admin.pairRights.confirm"
                  >
                    Confirm
                  </button>
                </form>
              }
            </li>
          }
        </ul>
      </div>

      <div class="space-y-3" data-admin-vetoes>
        <h4 class="text-base font-semibold text-(--text-primary)" i18n="@@admin.pairRights.vetoes">
          Removals in force
        </h4>
        <p
          class="max-w-prose text-sm text-(--text-secondary)"
          i18n="@@admin.pairRights.vetoes.explain"
        >
          A vendor of an endpoint product removed these from its product. A removal is not reviewed.
          End one only when it was filed through a seat that should not have had it.
        </p>
        @if (vetoes().length === 0) {
          <p class="text-sm text-(--text-secondary)" i18n="@@admin.pairRights.vetoes.empty">
            No removals in force.
          </p>
        }
        <ul class="m-0 list-none space-y-3 p-0">
          @for (v of vetoes(); track v.id) {
            <li class="rounded-(--radius-md) border border-(--border-default) p-4 text-sm">
              <p class="font-medium text-(--text-primary)">{{ pairName(v.pair) }}</p>
              <p class="text-(--text-secondary)" i18n="@@admin.pairRights.vetoes.by">
                Removed by {{ v.vendor_name }} on {{ v.filed_at | date: 'mediumDate' }}:
                {{ v.reason }}
              </p>
              <button
                type="button"
                [class]="buttonClass"
                (click)="openForm(v.id, 'lift')"
                i18n="@@admin.pairRights.lift"
              >
                End this removal
              </button>
              @if (form()?.id === v.id) {
                <form
                  method="dialog"
                  class="mt-3 space-y-2"
                  (submit)="$event.preventDefault(); lift(v)"
                >
                  <label
                    class="block font-medium"
                    for="lift-note-{{ v.id }}"
                    i18n="@@admin.pairRights.noteLift"
                    >Why it ends, shown to the vendors (required)</label
                  >
                  <textarea
                    id="lift-note-{{ v.id }}"
                    rows="3"
                    maxlength="1000"
                    required
                    class="w-full rounded-(--radius-sm) border border-(--border-default) p-2"
                    (input)="note.set(valueOf($event))"
                  ></textarea>
                  <button
                    type="submit"
                    [class]="buttonClass"
                    [disabled]="busy()"
                    i18n="@@admin.pairRights.confirm"
                  >
                    Confirm
                  </button>
                </form>
              }
            </li>
          }
        </ul>
      </div>

      @if (error()) {
        <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ error() }}</p>
      }
      <p class="sr-only" role="status">{{ status() }}</p>
    </section>
  `,
})
export class AdminPairRights {
  private readonly api = inject(AdminContestsApi);

  protected readonly reports = signal<readonly PairContest[]>([]);
  protected readonly protests = signal<readonly PairContest[]>([]);
  protected readonly vetoes = signal<readonly AdminVeto[]>([]);
  protected readonly form = signal<Form>(null);
  protected readonly note = signal('');
  protected readonly source = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly status = signal('');

  protected readonly buttonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-4 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';

  constructor() {
    afterNextRender(() => void this.load());
  }

  /** A form control's value, from its event. */
  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected pairName(pair: PairRightPair): string {
    const a = pair.product_a?.name ?? '';
    const b = pair.product_b?.name ?? '';
    const via = pair.connector?.name ?? '';
    return (
      pair.name ?? $localize`:@@admin.pairRights.pairName:${a}:a: and ${b}:b: through ${via}:via:`
    );
  }

  protected title(r: PairContest): string {
    const pair = this.pairName(r.pair);
    return r.kind === 'existence'
      ? $localize`:@@admin.pairRights.title.existence:Not offered: ${pair}:pair:`
      : $localize`:@@admin.pairRights.title.flow:Data flow ${r.flow?.data_object_name ?? ''}:flow: on ${pair}:pair:`;
  }

  protected openForm(id: string, kind: NonNullable<Form>['kind']): void {
    this.note.set('');
    this.source.set('');
    this.error.set(null);
    this.form.set({ id, kind });
  }

  protected decide(r: PairContest): Promise<void> {
    const kind = this.form()?.kind === 'accept' ? 'accept' : 'decline';
    const note = this.note().trim();
    if (kind === 'accept' && !note) {
      this.error.set($localize`:@@admin.pairRights.err.note:A note is required to accept.`);
      return Promise.resolve();
    }
    return this.write(async () => {
      await this.api.decidePairContest(r.id, {
        decision: kind,
        ...(note ? { note } : {}),
        ...(this.source().trim() ? { source_url: this.source().trim() } : {}),
      });
      this.status.set($localize`:@@admin.pairRights.done:Decided.`);
    });
  }

  protected decideProtest(r: PairContest): Promise<void> {
    const decision = this.form()?.kind === 'upheld' ? 'upheld' : 'rejected';
    const note = this.note().trim();
    if (!note) {
      this.error.set($localize`:@@admin.pairRights.err.noteRequired:A note is required.`);
      return Promise.resolve();
    }
    return this.write(async () => {
      await this.api.decidePairProtest(r.id, { decision, note });
      this.status.set($localize`:@@admin.pairRights.done:Decided.`);
    });
  }

  protected lift(v: AdminVeto): Promise<void> {
    const note = this.note().trim();
    if (!note) {
      this.error.set($localize`:@@admin.pairRights.err.noteRequired:A note is required.`);
      return Promise.resolve();
    }
    return this.write(async () => {
      const res = await this.api.liftVeto(v.id, note);
      this.status.set(
        res.pair_public
          ? $localize`:@@admin.pairRights.lifted.public:Removal ended. The integration is back on the site.`
          : $localize`:@@admin.pairRights.lifted.hidden:Removal ended. Another removal or a retire still keeps it off the site.`,
      );
    });
  }

  private async write(action: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
      this.form.set(null);
    } catch (e) {
      const field = (e as { error?: { error?: { field?: string } } }).error?.error?.field;
      this.error.set(
        field === 'sourceUrl'
          ? $localize`:@@admin.pairRights.err.source:Add an https proof link to accept.`
          : $localize`:@@admin.pairRights.err.generic:Not saved. It may have changed. The lists are reloaded.`,
      );
    } finally {
      this.busy.set(false);
      await this.load();
    }
  }

  private async load(): Promise<void> {
    try {
      const [reports, protests, vetoes] = await Promise.all([
        this.api.listPairContests(),
        this.api.listPairContests({ protests: true }),
        this.api.listVetoes(),
      ]);
      this.reports.set(reports.data);
      this.protests.set(protests.data);
      this.vetoes.set(vetoes.data);
    } catch {
      this.error.set(
        $localize`:@@admin.pairRights.err.load:Could not load the Sync Service lists.`,
      );
    }
  }
}
