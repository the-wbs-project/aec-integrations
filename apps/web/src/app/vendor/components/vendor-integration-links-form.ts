import { Component, ElementRef, computed, inject, input, signal, viewChild } from '@angular/core';

import {
  HTTPS_URL_MAX_LENGTH,
  HttpsUrlSchema,
  type IntegrationLinkKind,
  type IntegrationSideLinks,
  type VendorIntegration,
} from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { readVendorApiError } from '../vendor-api-error';
import { VendorPortalStore } from '../vendor-portal-store';

const KINDS: readonly IntegrationLinkKind[] = ['listing', 'docs'];
const COLUMN: Record<IntegrationLinkKind, keyof IntegrationSideLinks> = {
  listing: 'listing_url',
  docs: 'docs_url',
};

/** Why a typed value cannot be saved, or `null` when it can. Blank is valid: it
 *  means "remove this link". Uses the server's own schema, so the two agree. */
export function linkValueProblem(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return HttpsUrlSchema.safeParse(trimmed).success
    ? null
    : $localize`:@@vendor.links.error.url:Use a full link that starts with https://, such as https://example.com/integrations.`;
}

/** The save error, worded for the vendor. */
export function linkSaveErrorMessage(err: unknown): string {
  const info = readVendorApiError(err);
  switch (info?.code) {
    case 'INTEGRATION_CONNECTOR_POWERED':
      return $localize`:@@vendor.links.error.connector:This integration is delivered through a connector product, so it cannot take your own links yet.`;
    case 'INTEGRATION_RETIRED':
      return $localize`:@@vendor.links.error.retired:This integration was retired by its owner, so its links cannot change until it is restored.`;
    case 'VALIDATION_FAILED':
      return $localize`:@@vendor.links.error.invalid:One of the links is not valid. Check it and try again.`;
    case 'NOT_FOUND':
      return $localize`:@@vendor.links.error.notFound:Your company no longer lists this product, so you cannot set its links. Reload the page.`;
    case 'RATE_LIMITED':
      return $localize`:@@vendor.links.error.rate:Too many requests in a short time. Wait a minute and try again.`;
    default:
      return $localize`:@@vendor.links.error.generic:Could not save your links. Try again.`;
  }
}

/**
 * "Your links" on an integration card (AECI-1007 / ADR 0035 decision 6 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.7).
 *
 * The caller's OWN listing and docs links for its product on this integration,
 * shown on the public pair page beside the other side's, labelled with the
 * caller's company name. The other side's links are not edited here, and the
 * integration's owner has no say over them.
 *
 * ── WHO SEES IT ─────────────────────────────────────────────────────────────
 * The card renders the full form when `integration.attestable` is true. `false` is
 * the server's connector-powered verdict, and decision 9 keeps new per-side links
 * off those rows. There is no entitlement or Verified check: a seat is the whole
 * gate (decision 15), so a vendor that cannot yet author data flows can still say
 * where its own listing lives.
 *
 * ── STRANDED LINKS ──────────────────────────────────────────────────────────
 * Promote can make an unclaimed row connector-powered in place, after a vendor set
 * its links. Those links stay stored, and the pair page stops showing them. The
 * card then renders this block read-only: the stored links, a sentence saying why
 * they are hidden, and a Remove action per link. The API lets a DELETE through the
 * connector fence for exactly this (`vendor-integration-links.ts` rule 4). With no
 * stored link the card renders nothing on a connector-powered row, as before.
 *
 * ── PESSIMISTIC ─────────────────────────────────────────────────────────────
 * Two fields, one Save. Each changed field is one `PUT` (a value) or `DELETE`
 * (blank). The form waits for every answer, splices each echo into the store,
 * announces once through the portal's one live region, and closes. No optimistic
 * render: a form stays pessimistic (`STAGE_2_REALTIME_SPEC.md` §5).
 *
 * Mirrors the contest form's disclosure and control classes on purpose. The two
 * sit next to each other on the same card and must read as one family.
 */
@Component({
  selector: 'aec-vendor-integration-links-form',
  styles: [':host { display: block; }'],
  template: `
    <div class="border-t border-(--border-default) px-5 py-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 max-w-prose space-y-1">
          <p
            [id]="fieldId('title')"
            class="text-sm font-semibold text-(--text-primary)"
            i18n="@@vendor.links.title"
          >
            Your links
          </p>
          <p class="text-xs text-(--text-secondary)">{{ intro() }}</p>
          @if (stranded()) {
            <dl class="mt-2 space-y-2 text-xs" data-testid="stranded-links">
              @for (row of strandedRows(); track row.kind) {
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <dt class="shrink-0 text-(--text-secondary)">{{ row.label }}</dt>
                  <dd class="min-w-0 break-all text-(--text-primary)">{{ row.value }}</dd>
                  <dd>
                    <button
                      type="button"
                      [class]="secondaryButtonClass"
                      [disabled]="saving()"
                      [attr.aria-label]="removeLabel(row.kind)"
                      (click)="remove(row.kind)"
                      i18n="@@vendor.links.stranded.remove"
                    >
                      Remove
                    </button>
                  </dd>
                </div>
              }
            </dl>
            @if (notice(); as message) {
              <p role="alert" class="mt-2 text-sm font-medium text-(--text-primary)">
                {{ message }}
              </p>
            }
          } @else if (!open()) {
            <dl class="mt-2 space-y-1 text-xs" data-testid="own-links-summary">
              @for (row of summary(); track row.kind) {
                <div class="flex min-w-0 gap-2">
                  <dt class="shrink-0 text-(--text-secondary)">{{ row.label }}</dt>
                  <dd class="min-w-0 break-all text-(--text-primary)">
                    {{ row.value ?? notSetLabel }}
                  </dd>
                </div>
              }
            </dl>
          }
        </div>
        @if (!stranded()) {
          <button
            #trigger
            type="button"
            [attr.aria-expanded]="open()"
            [attr.aria-controls]="fieldId('panel')"
            (click)="toggle()"
            [class]="triggerClass"
            i18n="@@vendor.links.trigger"
          >
            Edit your links
          </button>
        }
      </div>

      @if (open() && !stranded()) {
        <form
          [id]="fieldId('panel')"
          class="mt-4 space-y-5"
          novalidate
          (submit)="onSubmit($event)"
          [attr.aria-labelledby]="fieldId('title')"
        >
          @for (kind of kinds; track kind) {
            <div class="max-w-2xl space-y-2">
              <label [for]="fieldId(kind)" [class]="labelClass">{{ kindLabel(kind) }}</label>
              <input
                [id]="fieldId(kind)"
                type="url"
                inputmode="url"
                autocomplete="url"
                placeholder="https://"
                [attr.maxlength]="maxLength"
                [value]="draft()[kind]"
                (input)="onInput(kind, inputValue($event))"
                [attr.aria-invalid]="showError(kind) ? 'true' : null"
                [attr.aria-describedby]="
                  fieldId(kind) + '-hint' + (showError(kind) ? ' ' + fieldId(kind) + '-error' : '')
                "
                [class]="inputClass"
              />
              <p [id]="fieldId(kind) + '-hint'" class="text-xs text-(--text-secondary)">
                {{ kindHint(kind) }}
              </p>
              @if (showError(kind)) {
                <p
                  [id]="fieldId(kind) + '-error'"
                  role="alert"
                  class="text-xs font-medium text-(--text-primary)"
                >
                  {{ problem(kind) }}
                </p>
              }
            </div>
          }

          <div class="flex flex-wrap items-center gap-3 border-t border-(--border-default) pt-4">
            <button type="submit" [class]="primaryButtonClass" [disabled]="saving()">
              @if (saving()) {
                <span i18n="@@vendor.links.saving">Saving…</span>
              } @else {
                <span i18n="@@vendor.links.save">Save links</span>
              }
            </button>
            <button
              type="button"
              [class]="secondaryButtonClass"
              [disabled]="saving()"
              (click)="close()"
              i18n="@@vendor.links.cancel"
            >
              Cancel
            </button>
          </div>

          @if (notice(); as message) {
            <p role="alert" class="text-sm font-medium text-(--text-primary)">{{ message }}</p>
          }
        </form>
      }
    </div>
  `,
})
export class VendorIntegrationLinksForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);
  private readonly announcer = inject(VendorPortalAnnouncer);

  readonly integration = input.required<VendorIntegration>();
  readonly vendorName = input.required<string>();

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');

  protected readonly kinds = KINDS;
  protected readonly maxLength = HTTPS_URL_MAX_LENGTH;
  protected readonly notSetLabel = $localize`:@@vendor.links.notSet:Not set`;

  protected readonly open = signal(false);
  protected readonly saving = signal(false);
  protected readonly attempted = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly draft = signal<Record<IntegrationLinkKind, string>>({ listing: '', docs: '' });

  private readonly saved = computed(() => this.integration().own_links);

  /** A connector-powered row still holding this vendor's links (see the header). */
  protected readonly stranded = computed(() => !this.integration().attestable);

  /** The stored links on a stranded row, set ones only. */
  protected readonly strandedRows = computed(() =>
    KINDS.flatMap((kind) => {
      const value = this.saved()[COLUMN[kind]];
      return value ? [{ kind, label: this.kindLabel(kind), value }] : [];
    }),
  );

  protected readonly intro = computed(() =>
    this.stranded()
      ? $localize`:@@vendor.links.stranded.intro:This integration is now delivered through a connector product, so it no longer takes your own links and readers no longer see them. You can remove them.`
      : $localize`:@@vendor.links.intro:Where readers find ${this.integration().context_product.name}:product:’s side of this integration. They appear on the public integration page under ${this.vendorName()}:vendor:’s name, beside ${this.integration().other_product.name}:other:’s own links.`,
  );

  protected readonly summary = computed(() =>
    KINDS.map((kind) => ({
      kind,
      label: this.kindLabel(kind),
      value: this.saved()[COLUMN[kind]],
    })),
  );

  protected kindLabel(kind: IntegrationLinkKind): string {
    return kind === 'listing'
      ? $localize`:@@vendor.links.listing:Listing page`
      : $localize`:@@vendor.links.docs:Documentation`;
  }

  protected removeLabel(kind: IntegrationLinkKind): string {
    return kind === 'listing'
      ? $localize`:@@vendor.links.stranded.removeListing:Remove your listing page link`
      : $localize`:@@vendor.links.stranded.removeDocs:Remove your documentation link`;
  }

  /** Remove one stranded link. Pessimistic, like the form: wait, splice, announce. */
  protected async remove(kind: IntegrationLinkKind): Promise<void> {
    if (this.saving()) return;
    const integration = this.integration();
    this.notice.set(null);
    this.saving.set(true);
    try {
      const res = await this.api.deleteIntegrationLink(
        integration.id,
        integration.context_product.id,
        kind,
      );
      this.spliceEcho(res.integration_id, res.product_id, res.links);
      this.announcer.announce(
        $localize`:@@vendor.links.live.removed:Your link for ${integration.context_product.name}:product: is removed.`,
      );
    } catch (err) {
      this.notice.set(linkSaveErrorMessage(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected kindHint(kind: IntegrationLinkKind): string {
    return kind === 'listing'
      ? $localize`:@@vendor.links.listing.hint:Your marketplace or app listing for this integration. Leave blank to remove it.`
      : $localize`:@@vendor.links.docs.hint:Your setup or help page for this integration. Leave blank to remove it.`;
  }

  protected problem(kind: IntegrationLinkKind): string | null {
    return linkValueProblem(this.draft()[kind]);
  }

  protected showError(kind: IntegrationLinkKind): boolean {
    return this.problem(kind) !== null && this.attempted();
  }

  protected toggle(): void {
    if (this.open()) this.close();
    else this.openForm();
  }

  protected openForm(): void {
    const saved = this.saved();
    this.draft.set({ listing: saved.listing_url ?? '', docs: saved.docs_url ?? '' });
    this.attempted.set(false);
    this.notice.set(null);
    this.open.set(true);
  }

  /** Close and return focus to the trigger, so a keyboard user is not dropped at
   *  the top of the page when the form unmounts. */
  close(): void {
    this.open.set(false);
    this.notice.set(null);
    this.attempted.set(false);
    this.trigger()?.nativeElement.focus();
  }

  protected onInput(kind: IntegrationLinkKind, value: string): void {
    this.draft.update((d) => ({ ...d, [kind]: value }));
    this.notice.set(null);
  }

  protected async onSubmit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.saving()) return;
    this.attempted.set(true);
    this.notice.set(null);
    if (KINDS.some((kind) => this.problem(kind) !== null)) return;

    const integration = this.integration();
    const changes = KINDS.map((kind) => ({
      kind,
      next: this.draft()[kind].trim(),
      before: this.saved()[COLUMN[kind]] ?? '',
    })).filter((c) => c.next !== c.before);
    if (changes.length === 0) {
      this.close();
      return;
    }

    this.saving.set(true);
    try {
      for (const change of changes) {
        const res =
          change.next === ''
            ? await this.api.deleteIntegrationLink(
                integration.id,
                integration.context_product.id,
                change.kind,
              )
            : await this.api.putIntegrationLink(
                integration.id,
                integration.context_product.id,
                change.kind,
                change.next,
              );
        // Splice each echo as it lands, so a later failure still shows what saved.
        // A splice, never a whole-list refetch: replacing the list would clobber a
        // concurrent data-flow write on this tab (see vendor-integrations-section.ts).
        this.spliceEcho(res.integration_id, res.product_id, res.links);
      }
      this.announcer.announce(
        $localize`:@@vendor.links.live.saved:Your links for ${integration.context_product.name}:product: and ${integration.other_product.name}:other: are saved and live on the public page.`,
      );
      this.saving.set(false);
      this.close();
    } catch (err) {
      this.notice.set(linkSaveErrorMessage(err));
      this.saving.set(false);
    }
  }

  /** Write one echo into the entry for (integration, own product). A vendor that
   *  owns both endpoints has a second entry for the other product, untouched. */
  private spliceEcho(integrationId: string, productId: string, links: IntegrationSideLinks): void {
    this.store
      .apply('integrations', (list) =>
        list.map((entry) =>
          entry.id === integrationId && entry.context_product.id === productId
            ? { ...entry, own_links: links }
            : entry,
        ),
      )
      .commit();
  }

  protected fieldId(key: string): string {
    return `vendor-links-${this.integration().id}-${this.integration().context_product.id}-${key}`;
  }

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected readonly triggerClass =
    'inline-flex shrink-0 items-center rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly labelClass =
    'block text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';
  protected readonly inputClass =
    'w-full rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly primaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly secondaryButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
}
