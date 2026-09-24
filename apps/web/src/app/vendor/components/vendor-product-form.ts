import { VendorPortalAnnouncer } from '../vendor-announcer';
import { LogoInput } from '../../shared/logo-input/logo-input';
import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import {
  UpdateVendorProductSchema,
  type UpdateVendorProductInput,
  type VendorProduct,
} from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { RequestTrigger } from '../../requests/request-trigger';
import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';
import { vendorIsCatalogueSeat } from '../vendor-capabilities';

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
  imports: [LogoInput, RequestTrigger, NewTabIcon],
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
          @if (catalogueSeat()) {
            <!-- AECI-1082: the catalogue seat never had product editing, so it is not paused. -->
            <div
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
            >
              <p
                class="max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                i18n="@@vendor.product.readOnly.catalogue"
              >
                Product details stay with the AECi team, so this seat cannot edit them. This product
                stays published exactly as it is, and everything on record is here to read.
              </p>
            </div>
          } @else {
            <div
              class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
            >
              <p
                class="max-w-prose text-sm leading-relaxed text-(--text-secondary)"
                i18n="@@vendor.product.readOnly"
              >
                Editing is paused while your account access is inactive. This product stays
                published exactly as it is, and everything on record is here to read. The account
                panel on Vendor Overview has the renewal path.
              </p>
            </div>
          }
        }

        @for (cfg of textFields; track cfg.key) {
          <div class="space-y-1.5">
            @if (cfg.key === 'logo_url') {
              <aec-logo-input
                [inputId]="fieldId(cfg.key)"
                [value]="model()['logo_url'] ?? ''"
                [readOnly]="!canEdit()"
                [disabled]="saving()"
                (valueChange)="onLogoChange($event)"
                (pendingChange)="logoPending.set($event)"
                (announce)="announcer.announce($event)"
              />
            } @else {
              <label [for]="fieldId(cfg.key)" [class]="labelClass">{{ cfg.label }}</label>
              @if (cfg.control === 'textarea') {
                <textarea
                  [id]="fieldId(cfg.key)"
                  rows="4"
                  [value]="model()[cfg.key]"
                  [readOnly]="!canEdit()"
                  (input)="onInput(cfg.key, $event)"
                  [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
                  [attr.aria-describedby]="
                    fieldErrors()[cfg.key] ? fieldId(cfg.key) + '-error' : null
                  "
                  [class]="controlClass()"
                ></textarea>
              } @else {
                <input
                  [id]="fieldId(cfg.key)"
                  type="url"
                  [value]="model()[cfg.key]"
                  [readOnly]="!canEdit()"
                  (input)="onInput(cfg.key, $event)"
                  [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
                  [attr.aria-describedby]="
                    fieldErrors()[cfg.key] ? fieldId(cfg.key) + '-error' : null
                  "
                  [class]="controlClass()"
                />
              }
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
  /** The §8.9 connector seat (AECI-1082): its read-only notice is not paused copy. */
  protected readonly catalogueSeat = vendorIsCatalogueSeat(this.store);

  readonly product = input.required<VendorProduct>();
  /** The §8 entitlement gate (AECI-614): `product.edit`. Defaults open. */
  readonly canEdit = input<boolean>(true);

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
    { key: 'logo_url', control: 'url', label: $localize`:@@vendor.product.field.logoUrl:Logo URL` },
  ];

  private readonly baseline = signal<VendorProduct | null>(null);
  protected readonly model = signal<Record<string, string>>({});

  protected readonly announcer = inject(VendorPortalAnnouncer);
  protected readonly saving = signal(false);
  protected readonly logoPending = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal(false);

  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  /** Everything but the background, which is the read-only tell. Two `bg-*`
   *  utilities on one element would race on stylesheet order. */
  private readonly inputBase =
    'w-full rounded-(--radius-md) border border-(--border-default) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly controlClass = computed(() =>
    this.canEdit()
      ? `${this.inputBase} bg-(--surface-base)`
      : `${this.inputBase} bg-(--surface-sunken)`,
  );
  protected readonly saveButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly reloadButtonClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected readonly fieldErrors = computed<Record<string, string | null>>(() => {
    const m = this.model();
    const out: Record<string, string | null> = {};
    for (const cfg of this.textFields) {
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
    for (const cfg of this.textFields) {
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
    () =>
      !this.canEdit() ||
      this.saving() ||
      this.logoPending() ||
      !this.hasChanges() ||
      this.hasErrors(),
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

    // Register/withdraw this product's unsaved-edit protection. An in-flight
    // logo upload counts as dirty even though the model has not moved yet: the
    // store would otherwise push a fresh payload mid-upload and the re-seed
    // above would drop the draft the upload is about to land on. Same guard as
    // the profile form.
    effect(() => {
      const dirty = this.hasChanges() || this.logoPending();
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

  protected onLogoChange(value: string): void {
    this.model.update((m) => ({ ...m, logo_url: value }));
    this.saved.set(false);
  }

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
    } catch {
      this.saveError.set(true);
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
      logo_url: p.logo_url ?? '',
    });
  }
}
