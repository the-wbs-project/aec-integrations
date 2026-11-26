import { Component, ElementRef, afterNextRender, inject, signal } from '@angular/core';

import { AdminPaginator } from '../../admin/admin-paginator';
import { CONSOLE_PANEL_CLASS, CONSOLE_TABLE } from '../../admin/console/console-table';
import { AdminDangerAction, type AdminDangerConfirmStep } from '../../admin/console/danger-action';
import { AdminDisclosureButton } from '../../admin/console/disclosure-button';
import { AdminInlineControl } from '../../admin/console/inline-control';
import { ADMIN_STATUS_TONES, type AdminStatusKey } from '../../admin/console/status-tones';
import { BAND_WRAP_CLASS } from '../../shared/band-wrap';
import { Chip, type ConsoleChipTone } from '../../shared/chip/chip';

/** The seven tones in the legend's order, with the legend's words. */
const TONES: ReadonlyArray<{ tone: ConsoleChipTone; look: string; use: string }> = [
  { tone: 'count', look: 'Forest fill, white text (12.34:1)', use: 'Queue counts' },
  {
    tone: 'neutral',
    look: 'Raised fill, default edge, primary ink (18.97:1)',
    use: 'A fact about the row that is not a state',
  },
  {
    tone: 'waiting',
    look: 'White fill, strong edge, primary ink, hollow ring (19.80:1)',
    use: 'Waits on someone',
  },
  {
    tone: 'positive',
    look: 'Forest-soft fill, Forest edge and ink (10.80:1)',
    use: 'Live or done as intended',
  },
  {
    tone: 'quiet',
    look: 'Raised fill, default edge, secondary ink (7.41:1)',
    use: 'Closed, withdrawn or not measured',
  },
  {
    tone: 'attention',
    look: 'Raised fill, strong edge, Clay-deep ink (5.59:1)',
    use: 'Look before you act. Not a fault',
  },
  {
    tone: 'critical',
    look: 'White fill, error edge and ink (6.54:1)',
    use: 'A fault or a block. The only red',
  },
];

interface DemoRow {
  readonly id: string;
  readonly product: string;
  readonly slug: string;
  readonly reviewer: string;
  readonly overall: string;
  readonly age: string;
  readonly status: AdminStatusKey;
  readonly label: string;
  readonly body: string;
}

const ROWS: readonly DemoRow[] = [
  {
    id: 'r1',
    product: 'Fieldline Takeoff',
    slug: 'fieldline-takeoff',
    reviewer: 'r.amari@harbourline-arch.example',
    overall: '4/5',
    age: '38 min',
    status: 'pending',
    label: 'Pending',
    body: 'Takeoffs on a 40-sheet set take an afternoon instead of two days.',
  },
  {
    id: 'r2',
    product: 'Quarry BIM Sync',
    slug: 'quarry-bim-sync',
    reviewer: 'Anonymized',
    overall: '1/5',
    age: '2 h',
    status: 'toxicityHigh',
    label: '84 · High',
    body: 'Support never answered. The sync wiped two days of model changes.',
  },
  {
    id: 'r3',
    product: 'Ledgerstone ERP',
    slug: 'ledgerstone-erp',
    reviewer: 'd.whitcombe@northfield-mep.example',
    overall: '5/5',
    age: '15 h',
    status: 'approved',
    label: 'Approved',
    body: 'We moved 14 active jobs over a weekend.',
  },
];

/**
 * AECI-1813 — the console legend in the real app: the seven chip tones on the
 * shared `aec-chip`, the status-to-tone map, the table recipe with an expanded
 * and a selected row and its empty state, the paginator, the inline control
 * form and the danger pattern. Fixtures only, no API. Dev-only like every
 * `/preview` route (blocked on the public tiers, `isPreviewPath`).
 */
@Component({
  selector: 'aec-admin-console-legend-preview',
  imports: [Chip, AdminDisclosureButton, AdminInlineControl, AdminDangerAction, AdminPaginator],
  template: `
    <div [class]="wrap" class="pb-24 pt-12">
      <h1>Admin console legend</h1>
      <p class="mt-2 max-w-[48rem] text-t-16 text-(--text-secondary)">
        The shared console pieces of AECI-1813, rendered from the real components. Every admin slice
        uses these.
      </p>

      <section [class]="panel" class="mt-8" aria-labelledby="lg-tones">
        <h2 id="lg-tones">The seven chip tones</h2>
        <div
          [class]="t.region"
          class="mt-4"
          role="region"
          tabindex="0"
          aria-labelledby="lg-tones-cap"
        >
          <table [class]="t.table" class="min-w-[44rem]">
            <caption id="lg-tones-cap" [class]="t.caption">
              Chip tones
            </caption>
            <thead>
              <tr>
                <th scope="col" [class]="t.head">Tone</th>
                <th scope="col" [class]="t.head">Look</th>
                <th scope="col" [class]="t.head">Use</th>
                <th scope="col" [class]="t.head">Statuses</th>
              </tr>
            </thead>
            <tbody>
              @for (row of tones; track row.tone) {
                <tr [class]="t.row">
                  <th scope="row" [class]="t.rowHead">
                    <aec-chip density="dense" [tone]="row.tone">{{
                      row.tone === 'count' ? '7' : row.tone
                    }}</aec-chip>
                  </th>
                  <td [class]="t.cell">{{ row.look }}</td>
                  <td [class]="t.cell">{{ row.use }}</td>
                  <td [class]="t.cell">
                    <span [class]="t.sub">{{ statusesFor(row.tone) }}</span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      </section>

      <section [class]="panel" class="mt-8" aria-labelledby="lg-table">
        <h2 id="lg-table">The console table</h2>
        <div
          [class]="t.region"
          class="mt-4"
          role="region"
          tabindex="0"
          aria-labelledby="lg-table-cap"
        >
          <table [class]="t.table" class="min-w-[48rem]">
            <caption id="lg-table-cap" [class]="t.caption">
              Pending reviews, oldest first
            </caption>
            <thead>
              <tr>
                <th scope="col" [class]="t.head">
                  <span class="sr-only" i18n="@@preview.adminConsoleLegend.col.details"
                    >Details</span
                  >
                </th>
                <th scope="col" [class]="t.head">Product</th>
                <th scope="col" [class]="t.head">Reviewer</th>
                <th scope="col" [class]="t.headNum">Overall</th>
                <th scope="col" [class]="t.headNum">In queue</th>
                <th scope="col" [class]="t.head">Status</th>
              </tr>
            </thead>
            <tbody>
              @for (row of rows; track row.id) {
                <tr [class]="rowClass(row.id)">
                  <td [class]="t.disclosure">
                    <aec-admin-disclosure-button
                      [expanded]="open() === row.id"
                      [controls]="row.id + '-x'"
                      [label]="reviewLabel(row.product)"
                      (toggled)="toggle(row.id)"
                    />
                  </td>
                  <th scope="row" [class]="t.rowHead">
                    <a href="#lg-table" [class]="t.link">{{ row.product }}</a>
                    <span [class]="t.sub">{{ row.slug }}</span>
                  </th>
                  <td [class]="t.nowrap">{{ row.reviewer }}</td>
                  <td [class]="t.num">{{ row.overall }}</td>
                  <td [class]="t.num">{{ row.age }}</td>
                  <td [class]="t.cell">
                    <aec-chip density="dense" [tone]="toneOf(row.status)">{{ row.label }}</aec-chip>
                  </td>
                </tr>
                <tr [id]="row.id + '-x'" [class]="t.detailRow" [hidden]="open() !== row.id">
                  <td colspan="6" [class]="t.detailCell">
                    <div [class]="t.detailInner">
                      <p class="pt-2 text-t-16">{{ row.body }}</p>
                    </div>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
        <aec-admin-paginator
          [page]="page()"
          [perPage]="3"
          [total]="11"
          (pageChange)="page.set($event)"
        />

        <h3 class="mt-8">Empty</h3>
        <p [class]="t.empty" class="mt-4">No reviews are waiting for moderation.</p>
      </section>

      <section [class]="panel" class="mt-8" aria-labelledby="lg-forms">
        <h2 id="lg-forms">Inline control form and the danger pattern</h2>
        <div class="mt-4">
          <aec-admin-inline-control
            label="Company legal name"
            help="The name a checkout acceptance records. Leave it empty to remove the name."
            value="Northbeam Software, Inc."
            [(open)]="editingName"
            (saved)="name.set($event); editingName.set(false)"
            >{{ name() }}</aec-admin-inline-control
          >
          <aec-admin-inline-control
            label="Billing email"
            help="Plan emails go to this address and to every seat."
            type="email"
            value="billing@northbeam.example"
            [error]="emailError()"
            [(open)]="editingEmail"
            (saved)="emailError.set('Enter a valid email address.')"
            >billing&#64;northbeam.example</aec-admin-inline-control
          >
        </div>
        <div class="mt-8">
          <aec-admin-danger-action
            openerLabel="Suspend"
            confirmLabel="Suspend and send the notice"
            warning="This locks every seat out at once and sends the notice to the owner seats and the billing email. The listing stays live and billing is untouched."
            reasonLabel="Reason (required, internal: the vendor never sees it)"
            reasonRequired="Enter a reason. It is recorded in the audit trail."
            reasonHelp="Recorded in the audit trail with your name."
            [(open)]="suspending"
            (confirmed)="suspending.set(false)"
          />
        </div>
      </section>

      <!-- AECI-2104: each option of the danger form, open in the state it names. -->
      <section [class]="panel" class="mt-8" aria-labelledby="lg-danger">
        <h2 id="lg-danger">The danger form's options</h2>
        <p class="mt-2 max-w-[48rem] text-t-14 text-(--text-secondary)">
          Each form below opens in the state its heading names. Cancel or Escape closes it.
        </p>

        <h3 class="mt-8" id="lg-danger-length">A length rule, refused</h3>
        <aec-admin-danger-action
          id="lg-danger-length-form"
          class="mt-4"
          openerLabel="Reject"
          confirmLabel="Confirm rejection"
          reasonLabel="Reason for rejection"
          reasonRequired="Enter a reason between 1 and 80 characters so the reviewer understands the decision."
          [maxLength]="80"
          lengthMessage="Enter a reason between 1 and 80 characters so the reviewer understands the decision."
          [(open)]="lengthOpen"
          (confirmed)="lengthOpen.set(false)"
        />

        <h3 class="mt-8" id="lg-danger-busy">Busy</h3>
        <aec-admin-danger-action
          id="lg-danger-busy-form"
          class="mt-4"
          openerLabel="Reject"
          confirmLabel="Confirm rejection"
          busyLabel="Rejecting…"
          reasonLabel="Reason for rejection"
          reasonRequired="Enter a reason."
          [busy]="busyBusy()"
          [(open)]="busyOpen"
          (confirmed)="busyBusy.set(true)"
        />

        <h3 class="mt-8" id="lg-danger-step-one">Two steps: step one</h3>
        <aec-admin-danger-action
          id="lg-danger-step-one-form"
          class="mt-4"
          openerLabel="Remove from the page"
          confirmLabel="Remove permanently"
          busyLabel="Removing…"
          reasonLabel="Why you are removing it (required)"
          reasonRequired="Write a reason before you confirm."
          reasonHelp="Shown to the reviewer on their account page. Name the guideline the review breaks."
          [maxLength]="500"
          [confirmStep]="removeStep"
          [(open)]="stepOneOpen"
          (confirmed)="stepOneOpen.set(false)"
        />

        <h3 class="mt-8" id="lg-danger-step-two">Two steps: step two, the reason locked</h3>
        <aec-admin-danger-action
          id="lg-danger-step-two-form"
          class="mt-4"
          openerLabel="Remove from the page"
          confirmLabel="Remove permanently"
          busyLabel="Removing…"
          reasonLabel="Why you are removing it (required)"
          reasonRequired="Write a reason before you confirm."
          reasonHelp="Shown to the reviewer on their account page. Name the guideline the review breaks."
          [maxLength]="500"
          [confirmStep]="removeStep"
          [(open)]="stepTwoOpen"
          (confirmed)="stepTwoOpen.set(false)"
        />

        <h3 class="mt-8" id="lg-danger-rich">An error with a link</h3>
        <aec-admin-danger-action
          id="lg-danger-rich-form"
          class="mt-4"
          openerLabel="Ban reviewer"
          confirmLabel="Confirm ban"
          busyLabel="Banning…"
          warning="They will be blocked from submitting new reviews. Their approved reviews stay visible. You can unban them later."
          reasonLabel="Reason for ban"
          reasonRequired="Enter a reason between 1 and 500 characters."
          [errorTemplate]="lastSeat"
          [(open)]="richOpen"
          (confirmed)="richOpen.set(false)"
        />
        <ng-template #lastSeat
          >This is the vendor's last unbanned seat, so it was not banned. To end a vendor, use
          Suspend on its
          <a
            href="/preview/admin-console-legend#lg-danger"
            class="underline decoration-(--border-strong) underline-offset-4 hover:decoration-(--text-primary)"
            >vendor page</a
          >.</ng-template
        >

        <h3 class="mt-8" id="lg-danger-note">A note, a fact line and Cancel's own words</h3>
        <aec-admin-danger-action
          id="lg-danger-note-form"
          class="mt-4"
          openerLabel="Return records to AEC Integrations"
          confirmLabel="Return the records"
          busyLabel="Returning…"
          warning="Use this only when the claim was approved in error. The records go back to AEC Integrations and the vendor can no longer edit them."
          reasonLabel="Reason (required)"
          reasonRequired="Enter a reason."
          reasonHelp="Up to 1000 characters."
          [maxLength]="1000"
          noteLabel="Internal note (optional)"
          noteHelp="Only admins see it."
          [noteMaxLength]="1000"
          cancelLabel="Keep the records"
          [(open)]="noteOpen"
          (confirmed)="noteOpen.set(false)"
        >
          <p dangerFacts class="text-t-14 text-(--text-primary)">
            3 open product proposals will be discarded.
          </p>
        </aec-admin-danger-action>

        <h3 class="mt-8" id="lg-danger-optional">An optional reason, and no warning box</h3>
        <aec-admin-danger-action
          id="lg-danger-optional-form"
          class="mt-4"
          openerLabel="Decline"
          confirmLabel="Confirm decline"
          busyLabel="Declining…"
          reasonLabel="Why you are declining (recommended)"
          [reasonRequired]="null"
          reasonHelp="Shown to the vendor that filed the contest. A reason tells them what evidence would change the answer."
          [maxLength]="2000"
          [(open)]="optionalOpen"
          (confirmed)="optionalOpen.set(false)"
        />
      </section>
    </div>
  `,
})
export class AdminConsoleLegendPreview {
  protected readonly wrap = BAND_WRAP_CLASS;
  protected readonly panel = CONSOLE_PANEL_CLASS;
  protected readonly t = CONSOLE_TABLE;
  protected readonly tones = TONES;
  protected readonly rows = ROWS;

  /** The second row starts open, the third selected, as in the mock-up's states. */
  protected readonly open = signal<string | null>('r2');
  protected readonly selected = 'r3';
  protected readonly page = signal(1);
  protected readonly name = signal('Northbeam Software, Inc.');
  protected readonly editingName = signal(false);
  protected readonly editingEmail = signal(false);
  protected readonly emailError = signal<string | null>(null);
  protected readonly suspending = signal(false);

  // AECI-2104: the danger form's options, each open in the state its heading names.
  protected readonly removeStep: AdminDangerConfirmStep = {
    continueLabel: 'Continue to removal',
    title: 'Remove this review permanently?',
    body: "Removal is final. The review comes off the product page with its vendor replies and updates, and its ratings stop counting in the product's averages. Nobody can undo it from this screen.",
    editLabel: 'Edit the reason',
  };
  protected readonly lengthOpen = signal(true);
  protected readonly busyOpen = signal(true);
  protected readonly busyBusy = signal(false);
  protected readonly stepOneOpen = signal(true);
  protected readonly stepTwoOpen = signal(true);
  protected readonly richOpen = signal(true);
  protected readonly noteOpen = signal(true);
  protected readonly optionalOpen = signal(true);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    // Drive each form into its state the way an operator would: type, then confirm.
    // Browser only, after hydration. The forms focus what they would focus for a
    // real operator, so the page then hands focus back and returns to the top.
    afterNextRender(() => {
      const long = 'The review names a competitor and repeats one claim three times over the text.';
      this.stage('lg-danger-length-form', `${long} It also has no rating.`, 1);
      this.stage('lg-danger-busy-form', 'Breaks the guideline on personal details.', 1);
      this.stage('lg-danger-step-one-form', 'Breaks the guideline on personal details.', 0);
      this.stage('lg-danger-step-two-form', 'Breaks the guideline on personal details.', 1);
      this.stage('lg-danger-note-form', 'The claim was approved for the wrong company.', 0);
      setTimeout(() => {
        const doc = this.host.nativeElement.ownerDocument;
        (doc.activeElement as HTMLElement | null)?.blur();
        doc.defaultView?.scrollTo(0, 0);
      }, 250);
    });
  }

  private stage(id: string, reason: string, confirms: number): void {
    const form = this.host.nativeElement.querySelector<HTMLFormElement>(`#${id} form`);
    const area = form?.querySelector<HTMLTextAreaElement>('textarea');
    if (!form || !area) return;
    area.value = reason;
    area.dispatchEvent(new Event('input'));
    for (let i = 0; i < confirms; i++) form.requestSubmit();
  }

  /** The disclosure names what it opens, with no verb: `aria-expanded` gives the state. */
  protected reviewLabel(product: string): string {
    return $localize`:@@preview.adminConsoleLegend.reviewOf:Review of ${product}:PRODUCT:`;
  }

  protected toggle(id: string): void {
    this.open.update((v) => (v === id ? null : id));
  }

  protected toneOf(status: AdminStatusKey): ConsoleChipTone {
    return ADMIN_STATUS_TONES[status];
  }

  protected rowClass(id: string): string {
    if (this.open() === id) return this.t.rowOpen;
    if (id === this.selected) return this.t.rowSelected;
    return this.t.row;
  }

  protected statusesFor(tone: ConsoleChipTone): string {
    return Object.entries(ADMIN_STATUS_TONES)
      .filter(([, t]) => t === tone)
      .map(([key]) => key)
      .join(', ');
  }
}
