import { VendorPortalAnnouncer } from '../vendor-announcer';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import {
  UpdateVendorProductSchema,
  lockedField,
  type LockedField,
  type UpdateVendorProductInput,
  type VendorProduct,
} from '@aeci/shared';
import { PRODUCT_FIELD_CAPABILITIES } from '@aeci/shared/entitlements';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { VendorLockedNote } from './vendor-locked-note';
import { VendorLogoField, type SaveLogo } from './vendor-logo-field';
import { RequestTrigger } from '../../requests/request-trigger';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { productCan } from '../vendor-capabilities';

type ProductTextKey =
  | 'description'
  | 'website'
  | 'tool_integrations_url'
  | 'api_docs_url'
  | 'logo_url';
type Control = 'url' | 'textarea';

interface FieldConfig {
  readonly key: ProductTextKey;
  readonly label: string;
  readonly control: Control;
}

/**
 * Edit-owned-product form for the vendor dashboard (AECI-522), backed by
 * `PATCH /api/vendor/products/:id` (AECI-520). Renders the vendor-editable
 * allow-list only — `name`/`slug` are AECi-owned (a rename breaks the URL, the
 * Algolia record, and every inbound link, so it stays a correction request) and
 * are shown read-only with a hint.
 *
 * Validation is the shared `UpdateVendorProductSchema` (single source of truth,
 * client + server); only changed fields are sent (the endpoint requires ≥1). The
 * PATCH echo re-seeds the baseline so the form settles clean. The confirmation
 * must NOT promise instant search — edits reach Algolia on the nightly sync
 * (≤24h) while SSR repaints immediately (AECI-529).
 *
 * ── TAXONOMY LIVES ELSEWHERE (AECI-994) ─────────────────────────────────────
 * This form is the product Profile tab only. Each taxonomy facet, and the "How
 * teams use it" points that hang off Audiences and Phases, is edited on its own
 * tab by `vendor-product-facet-editor.ts`, which owns its own dirty-diff and Save.
 *
 * ── PER-FIELD GATES (AECI-1214) ─────────────────────────────────────────────
 * Each field is gated by its own capability on THIS product's plan, read with
 * `productCan` from `PRODUCT_FIELD_CAPABILITIES` — the same table the server's
 * field gate reads. On the Free plan description, website and logo are editable
 * and the two doc URLs are `readonly` (never `disabled`, so the value stays in
 * the accessibility tree). A locked field is never sent: the server refuses a
 * request naming one WHOLE. Since AECI-1218 each locked field carries a visible
 * reason under its label, tied to the control with `aria-describedby`, and one
 * notice above the fields names them all (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18).
 *
 * ── UNSAVED EDITS vs. REVALIDATION (AECI-628) ───────────────────────────────
 * Same contract as `vendor-profile-form.ts`: the baseline re-seeds from the input so a clean form tracks the server,
 * and while `hasChanges()` is true the form registers with
 * {@link VendorPortalStore.markDirty} so a fresh `me` payload is stashed rather
 * than applied. The registration is keyed by PRODUCT ID, because the section
 * renders one of these per owned product and a clean sibling must not be able to
 * cancel a dirty one's protection.
 */
@Component({
  selector: 'aec-vendor-product-form',
  imports: [VendorLogoField, RequestTrigger, NewTabIcon, VendorLockedNote],
  template: `
    <div class="space-y-6">
      <!-- Read-only identity: rename is a correction request, not a vendor edit. -->
      <div class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4">
        <p class="font-display text-lg text-(--text-primary)">{{ product().name }}</p>
        <p class="mt-1 text-xs text-(--text-secondary)">
          <span class="font-mono">/{{ product().slug }}</span>
        </p>
        <!--
          AECI-967 (section 6.9). The sentence named the action and gave no way
          to take it. The anchor opens the shared correction drawer in place
          (aecRequestTrigger); its href is the no-JS fallback and carries
          the new-tab treatment because that path really does navigate, and
          this form's unsaved state has no CanDeactivate guard behind it.

          The i18n stays on the <p>: Angular extracts the anchor as a
          placeholder, so the sentence remains ONE translatable message. No
          bodyPrefill: a correction already carries (target_type, slug), so
          there is no context here the request does not already have.
        -->
        <p
          class="mt-2 max-w-prose text-xs leading-relaxed text-(--text-secondary)"
          i18n="@@vendor.product.renameHint"
        >
          To change the product name,
          <a
            aecRequestTrigger
            [entity]="'product'"
            [kind]="'correction'"
            [slug]="product().slug"
            [href]="'/products/' + product().slug + '/correction'"
            target="_blank"
            rel="noopener"
            class="text-(--accent-primary) underline underline-offset-2"
            >file a correction request
            <span class="inline-flex align-middle"><aec-new-tab-icon /></span></a
          >. Renaming would break its links and search entry.
        </p>
      </div>

      <form class="space-y-6" novalidate (submit)="$event.preventDefault(); onSave()">
        @if (updatedElsewhere()) {
          <div
            class="flex flex-wrap items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
          >
            <p class="text-sm text-(--text-primary)" i18n="@@vendor.product.updatedElsewhere">
              This product changed somewhere else while you were editing. Your unsaved changes are
              still here.
            </p>
            <button
              type="button"
              [class]="reloadButtonClass"
              (click)="reloadSection()"
              i18n="@@vendor.product.reloadSection"
            >
              Reload this section
            </button>
          </div>
        }

        @if (!canEdit()) {
          <!--
            AECI-1218. Every known plan edits the description, website and logo
            (section 13.3), so this shows only for a plan block that holds none
            of the product capabilities, which the server does not serve today.
          -->
          <div
            class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
          >
            <p
              class="max-w-prose text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@vendor.product.readOnly"
            >
              This seat cannot edit this product right now. The product stays published exactly as
              it is, and everything on record is here to read.
            </p>
          </div>
        } @else if (lockedLabels().length > 0) {
          <!--
            AECI-1218 (STAGE_2_VENDOR_PORTAL_SPEC.md section 6.18): the Managed-only
            fields stay visible and readonly, each with its own reason below it.
            This line says once, up front, which ones and why.
          -->
          <div
            class="flex items-start gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
            data-testid="product-locked-notice"
          >
            <svg
              aria-hidden="true"
              class="mt-0.5 h-4 w-4 shrink-0 text-(--text-secondary)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            <div class="max-w-prose text-sm leading-relaxed">
              <p class="font-medium text-(--text-primary)">{{ lockedNotice() }}</p>
              <p class="mt-1 text-(--text-secondary)" i18n="@@vendor.product.locked.correction">
                Spot something wrong in one of them?
                <a
                  aecRequestTrigger
                  [entity]="'product'"
                  [kind]="'correction'"
                  [slug]="product().slug"
                  [href]="'/products/' + product().slug + '/correction'"
                  target="_blank"
                  rel="noopener"
                  class="text-(--accent-primary) underline underline-offset-2"
                  >Request a correction
                  <span class="inline-flex align-middle"><aec-new-tab-icon /></span
                ></a>
                and the AECi team fixes it.
              </p>
            </div>
          </div>
        }

        <!-- The logo saves from its own dialog, so it is not part of this form's diff. -->
        <aec-vendor-logo-field
          [fieldId]="fieldId('logo_url')"
          [logoUrl]="product().logo_url"
          [canEdit]="editable()['logo_url']"
          [save]="saveLogo"
          (announce)="announcer.announce($event)"
        />

        @for (cfg of formFields; track cfg.key) {
          <div class="space-y-1.5">
            <label [for]="fieldId(cfg.key)" [class]="labelClass">{{ cfg.label }}</label>
            @if (!editable()[cfg.key]) {
              <!--
                AECI-1218: the locked field's reason, visible and tied to the
                control with aria-describedby so a screen reader reads it too.
              -->
              <p
                [id]="fieldId(cfg.key) + '-locked'"
                class="flex items-center gap-1.5 text-xs text-(--text-secondary)"
                data-testid="locked-reason"
              >
                <svg
                  aria-hidden="true"
                  class="h-3.5 w-3.5 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <rect x="5" y="11" width="14" height="10" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                <span i18n="@@vendor.product.locked.reason"
                  >Part of Managed for this product. The current value stays published.</span
                >
              </p>
            }
            @if (cfg.control === 'textarea') {
              <textarea
                [id]="fieldId(cfg.key)"
                rows="4"
                [value]="model()[cfg.key]"
                [readOnly]="!editable()[cfg.key] || !!aeciLock(cfg.key)"
                (input)="onInput(cfg.key, $event)"
                [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
                [attr.aria-describedby]="describedBy(cfg.key)"
                [class]="controlClass(cfg.key)"
              ></textarea>
            } @else {
              <input
                [id]="fieldId(cfg.key)"
                type="url"
                [value]="model()[cfg.key]"
                [readOnly]="!editable()[cfg.key] || !!aeciLock(cfg.key)"
                (input)="onInput(cfg.key, $event)"
                [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
                [attr.aria-describedby]="describedBy(cfg.key)"
                [class]="controlClass(cfg.key)"
              />
            }
            @if (aeciLock(cfg.key); as lock) {
              <aec-vendor-locked-note [lock]="lock" [noteId]="fieldId(cfg.key) + '-aeci'" />
            }
            @if (fieldErrors()[cfg.key]; as err) {
              <p
                [id]="fieldId(cfg.key) + '-error'"
                class="text-xs font-medium text-(--text-primary)"
                role="alert"
              >
                {{ err }}
              </p>
            }
          </div>
        }

        <div class="flex flex-wrap items-center gap-4">
          @if (canEdit()) {
            <button type="submit" [disabled]="saveDisabled()" [class]="saveButtonClass">
              @if (saving()) {
                <span i18n="@@vendor.product.saving">Saving…</span>
              } @else {
                <span i18n="@@vendor.product.save">Save changes</span>
              }
            </button>
          }
          @if (saved()) {
            <p
              class="text-sm font-medium text-(--accent-primary)"
              role="status"
              i18n="@@vendor.product.saved"
            >
              Product updated. Your listing shows the change now; search results refresh within a
              day.
            </p>
          } @else if (saveLocked()) {
            <p
              class="text-sm font-medium text-(--text-primary)"
              role="alert"
              i18n="@@vendor.product.saveLocked"
            >
              AEC Integrations has locked a field you changed, so nothing was saved. Reload this
              section to see the locked value.
            </p>
          } @else if (saveError()) {
            <p
              class="text-sm font-medium text-(--text-primary)"
              role="alert"
              i18n="@@vendor.product.saveError"
            >
              Something went wrong saving your changes. Please try again.
            </p>
          }
        </div>
      </form>
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorProductForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);

  readonly product = input.required<VendorProduct>();

  /** Field → may this product's plan edit it (AECI-1214, §13.3). */
  protected readonly editable = computed<Record<ProductTextKey, boolean>>(() => {
    const product = this.product();
    const out = {} as Record<ProductTextKey, boolean>;
    for (const cfg of this.textFields) {
      out[cfg.key] = productCan(product, PRODUCT_FIELD_CAPABILITIES[cfg.key]);
    }
    return out;
  });
  /** The labels of the fields this product's plan locks, in form order. */
  protected readonly lockedLabels = computed(() =>
    this.textFields.filter((cfg) => !this.editable()[cfg.key]).map((cfg) => cfg.label),
  );

  /** One sentence naming the locked fields (AECI-1218, §6.18). */
  protected readonly lockedNotice = computed(() => {
    const labels = this.lockedLabels();
    const fields =
      labels.length <= 1
        ? labels.join('')
        : $localize`:@@vendor.product.locked.list:${labels.slice(0, -1).join(', ')}:HEAD: and ${labels[labels.length - 1]}:LAST:`;
    return $localize`:@@vendor.product.locked.notice:Editing the ${fields}:FIELDS: needs Managed for this product.`;
  });

  /** The control's descriptions: its locked reason and its error, when shown. */
  protected describedBy(key: ProductTextKey): string | null {
    const ids: string[] = [];
    if (!this.editable()[key]) ids.push(`${this.fieldId(key)}-locked`);
    if (this.aeciLock(key)) ids.push(`${this.fieldId(key)}-aeci`);
    if (this.fieldErrors()[key]) ids.push(`${this.fieldId(key)}-error`);
    return ids.length > 0 ? ids.join(' ') : null;
  }

  /**
   * AECI-1237 (§11d.5): AECi's lock on a field, when it corrected one. A separate
   * axis from `editable`, which is the plan: a plan lock says "needs Managed", an AECi
   * lock says who set the value and why.
   */
  protected aeciLock(key: string): LockedField | undefined {
    return lockedField(this.product().locked_fields, key);
  }

  /** Any field editable: drives the Save button and the read-only notice. */
  protected readonly canEdit = computed(() => Object.values(this.editable()).some(Boolean));

  protected readonly textFields: readonly FieldConfig[] = [
    {
      key: 'description',
      control: 'textarea',
      label: $localize`:@@vendor.product.field.description:Description`,
    },
    { key: 'website', control: 'url', label: $localize`:@@vendor.product.field.website:Website` },
    {
      key: 'tool_integrations_url',
      control: 'url',
      label: $localize`:@@vendor.product.field.integrationsUrl:Integrations page URL`,
    },
    {
      key: 'api_docs_url',
      control: 'url',
      label: $localize`:@@vendor.product.field.apiDocsUrl:API documentation URL`,
    },
    { key: 'logo_url', control: 'url', label: $localize`:@@vendor.product.field.logo:Logo` },
  ];
  /** The fields this form renders and diffs. The logo is in {@link textFields} for
   *  the plan gate and the locked notice only: it saves from its own dialog. */
  protected readonly formFields = this.textFields.filter((cfg) => cfg.key !== 'logo_url');

  private readonly baseline = signal<VendorProduct | null>(null);
  protected readonly model = signal<Record<string, string>>({});

  protected readonly announcer = inject(VendorPortalAnnouncer);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal(false);
  /** AECI-1237: the save was refused with `409 FIELD_LOCKED_BY_AECI`. */
  protected readonly saveLocked = signal(false);

  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  /** Everything but the background, which is the read-only tell. Two `bg-*`
   *  utilities on one element would race on stylesheet order. */
  private readonly inputBase =
    'w-full rounded-(--radius-md) border border-(--border-default) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected controlClass(key: ProductTextKey): string {
    return this.editable()[key] && !this.aeciLock(key)
      ? `${this.inputBase} bg-(--surface-base)`
      : `${this.inputBase} bg-(--surface-sunken)`;
  }
  protected readonly saveButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly reloadButtonClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected readonly fieldErrors = computed<Record<string, string | null>>(() => {
    const m = this.model();
    const out: Record<string, string | null> = {};
    for (const cfg of this.formFields) {
      const raw = (m[cfg.key] ?? '').trim();
      if (raw === '') {
        out[cfg.key] = null;
        continue;
      }
      const res = UpdateVendorProductSchema.safeParse({ [cfg.key]: raw });
      out[cfg.key] =
        cfg.control === 'url' && !res.success
          ? $localize`:@@vendor.product.error.url:Enter a URL starting with http:// or https://`
          : res.success
            ? null
            : $localize`:@@vendor.product.error.tooLong:This value is too long.`;
    }
    return out;
  });

  /**
   * The submit button's payload: the text fields. Facets and "How teams use it"
   * are PATCHed by `vendor-product-facet-editor.ts` on their own tabs.
   */
  protected readonly diff = computed<UpdateVendorProductInput>(() => {
    const base = this.baseline();
    const out: Record<string, unknown> = {};
    if (!base) return out as UpdateVendorProductInput;
    const m = this.model();
    const editable = this.editable();
    for (const cfg of this.formFields) {
      // A locked field is never sent, even if trimming made it look changed: the
      // server refuses the whole request when it names one.
      if (!editable[cfg.key]) continue;
      const raw = (m[cfg.key] ?? '').trim();
      const next = raw === '' ? null : raw;
      if (next !== ((base[cfg.key] as string | null) ?? null)) out[cfg.key] = next;
    }
    return out as UpdateVendorProductInput;
  });

  protected readonly hasChanges = computed(() => Object.keys(this.diff()).length > 0);

  protected readonly hasErrors = computed(() =>
    Object.values(this.fieldErrors()).some((e) => e !== null),
  );
  protected readonly saveDisabled = computed(
    () => !this.canEdit() || this.saving() || !this.hasChanges() || this.hasErrors(),
  );

  /** The store deferred a fresh `me` payload because THIS product form is
   *  holding it. Keyed by product id, so a sibling form's edits do not put a
   *  reload prompt on a product nobody touched. */
  protected readonly updatedElsewhere = computed(() =>
    this.store.isStale('products', this.product().id),
  );

  /** One-shot override for the re-seed guard: see `vendor-profile-form.ts`. */
  private readonly acceptNextPayload = signal(false);

  constructor() {
    // Re-seed from the input whenever the payload changes and there is nothing
    // unsaved to lose.
    effect(() => {
      const p = this.product();
      untracked(() => {
        if (this.hasChanges() && !this.acceptNextPayload()) return;
        this.acceptNextPayload.set(false);
        this.seed(p);
      });
    });

    // Register/withdraw this product's unsaved-edit protection.
    effect(() => {
      const dirty = this.hasChanges();
      untracked(() => {
        const id = this.product().id;
        if (dirty) this.store.markDirty('products', id);
        else this.store.clearDirty('products', id);
      });
    });
  }

  /** Take the server's copy and drop the unsaved edits. */
  protected reloadSection(): void {
    this.acceptNextPayload.set(true);
    void this.store.reload('products');
  }

  protected fieldId(key: string): string {
    return `vendor-product-${this.product().id}-${key.replace(/_/g, '-')}`;
  }

  /**
   * The logo dialog's save: `{ logo_url }` alone, so the rest of this form's
   * unsaved edits stay unsaved. Only the logo is spliced into `me`, for the same
   * reason: the echo's other fields would land under a dirty form.
   */
  protected readonly saveLogo: SaveLogo = async (logoUrl) => {
    const id = this.product().id;
    const res = await this.api.updateProduct(id, { logo_url: logoUrl });
    this.store
      .apply('me', (me) =>
        me
          ? {
              ...me,
              products: me.products.map((p) =>
                p.id === id ? { ...p, logo_url: res.product.logo_url } : p,
              ),
            }
          : me,
      )
      .commit();
    return res.product.logo_url;
  };

  protected onInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.model.update((m) => ({ ...m, [key]: value }));
    this.saved.set(false);
  }

  protected async onSave(): Promise<void> {
    // Enter from a focused (read-only, still focusable) field submits the form
    // even with no rendered submit button, so guard the handler too.
    if (!this.canEdit()) return;
    this.saved.set(false);
    this.saveError.set(false);
    this.saveLocked.set(false);
    const parsed = UpdateVendorProductSchema.safeParse(this.diff());
    if (!parsed.success) return; // guarded by saveDisabled; defensive
    this.saving.set(true);
    try {
      const res = await this.api.updateProduct(this.product().id, parsed.data);
      this.seed(res.product);
      // Splice the echo into `me` so the product's other tabs mount on the saved
      // value rather than waiting for the next poll (AECI-994).
      this.store
        .apply('me', (me) =>
          me
            ? {
                ...me,
                products: me.products.map((p) => (p.id === res.product.id ? res.product : p)),
              }
            : me,
        )
        .commit();
      this.saved.set(true);
    } catch (err) {
      if (apiErrorCode(err) === 'FIELD_LOCKED_BY_AECI') this.saveLocked.set(true);
      else this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  private seed(p: VendorProduct): void {
    this.baseline.set(p);
    this.model.set({
      description: p.description ?? '',
      website: p.website ?? '',
      tool_integrations_url: p.tool_integrations_url ?? '',
      api_docs_url: p.api_docs_url ?? '',
    });
  }
}

/** The `code` from the API's `{ error: { code } }` envelope, read structurally. */
function apiErrorCode(err: unknown): string | null {
  const inner = (err as { error?: { error?: { code?: unknown } } } | null)?.error?.error;
  return typeof inner?.code === 'string' ? inner.code : null;
}
