import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Listbox, Option } from '@angular/aria/listbox';

import {
  UpdateVendorProfileSchema,
  type UpdateVendorProfileInput,
  type VendorAccount,
} from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

/** The vendor-editable text fields (`founded_year` is the one numeric field;
 *  `public_private` is a discrete choice, handled separately). */
type ProfileTextKey =
  | 'description'
  | 'website'
  | 'headquarters'
  | 'parent_company'
  | 'contact_email'
  | 'phone_number'
  | 'logo_url'
  | 'linkedin_url'
  | 'x_url'
  | 'facebook_url'
  | 'instagram_url'
  | 'youtube_url'
  | 'crunchbase_url'
  | 'wiki_url'
  | 'github_org';
type ProfileFieldKey = ProfileTextKey | 'founded_year';

type Control = 'text' | 'url' | 'email' | 'tel' | 'textarea' | 'year';

interface FieldConfig {
  readonly key: ProfileFieldKey;
  readonly label: string;
  readonly control: Control;
  readonly autocomplete?: string;
}

/**
 * Edit-vendor-content form for the vendor dashboard (AECI-522), backed by
 * `PATCH /api/vendor/profile` (AECI-520). Renders the vendor-editable allow-list
 * only — `slug`, `company_name`, `verified`, promotion/admin/VQS fields are
 * AECi-owned and never appear here.
 *
 * Validation is the shared `UpdateVendorProfileSchema` (the single source of
 * truth, client + server): each field is validated live by parsing a single-key
 * object against it (empty = cleared = valid, since every field is nullable), and
 * the assembled diff is re-checked before the PATCH. The template owns the
 * user-facing copy (`$localize`); the Zod messages are never rendered.
 *
 * Save UX (§8.2 "optimistic UI + on-demand revalidation, no socket"): the PATCH
 * echoes the post-edit vendor, which re-seeds the baseline so the form settles to
 * a clean state and shows a confirmation. Only changed fields are sent (the
 * endpoint requires ≥1, and the Save button is disabled until something changes).
 * The confirmation must NOT promise instant search freshness — vendor edits reach
 * Algolia on the nightly sync (≤24h); SSR repaints immediately (AECI-529).
 *
 * `public_private` is a discrete choice, so per ADR 0010 it uses the Angular Aria
 * single-select listbox stand-in (Aria@22 ships no `select`), mirroring the
 * review form's "would recommend" control.
 *
 * ── READ-ONLY (AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8) ──────────────────
 * `canEdit` is fed from `me.entitlement.capabilities` holding `profile.edit` —
 * the same field the API's `requireCapability` gate asserts on, so an enabled
 * Save can never mean a 403 (and a disabled one can never hide a write that
 * would have worked). It is `readonly`, deliberately, not `disabled`: a
 * read-only input keeps its value in the accessibility tree, stays focusable and
 * copyable, and is what a downgraded vendor needs — the §5.2 promise is that
 * their data is still THERE, just not editable. `disabled` would drop the whole
 * form out of tab order and read as "broken" rather than "paused".
 *
 * ── UNSAVED EDITS vs. REVALIDATION (AECI-628) ───────────────────────────────
 * `me` is live now: a poll, or another seat saving in another tab, can replace
 * the vendor payload under this form. Two things follow.
 *
 * 1. The baseline re-seeds from the INPUT rather than once in `ngOnInit`, so a
 *    clean form silently picks up whatever the server last said.
 * 2. While `hasChanges()` is true the form registers itself with
 *    {@link VendorPortalStore.markDirty}, which makes the store stash a fresh
 *    payload instead of applying it. The vendor is told, in place, that the
 *    profile moved and is offered an explicit reload. Half-typed text is never
 *    silently replaced, and it is never silently kept either.
 */
@Component({
  selector: 'aec-vendor-profile-form',
  imports: [Listbox, Option],
  template: `
    <form class="space-y-8" novalidate (submit)="$event.preventDefault(); onSave()">
      @if (updatedElsewhere()) {
        <div
          class="flex flex-wrap items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4"
        >
          <p class="text-sm text-(--text-primary)" i18n="@@vendor.profile.updatedElsewhere">
            This profile changed somewhere else while you were editing. Your unsaved changes are
            still here.
          </p>
          <button
            type="button"
            [class]="reloadButtonClass"
            (click)="reloadSection()"
            i18n="@@vendor.profile.reloadSection"
          >
            Reload this section
          </button>
        </div>
      }

      @if (!canEdit()) {
        <p
          class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-4 text-sm leading-relaxed text-(--text-secondary)"
          i18n="@@vendor.profile.readOnly"
        >
          Editing is paused while your verification is not active. Everything below stays published
          and is here to read. The verification panel on your dashboard has the renewal path.
        </p>
      }

      <fieldset class="space-y-5 border-0 p-0">
        <legend class="sr-only" i18n="@@vendor.profile.section.details">Profile details</legend>

        @for (cfg of profileFields; track cfg.key) {
          <div class="space-y-1.5">
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
                [type]="inputType(cfg.control)"
                [attr.inputmode]="cfg.control === 'year' ? 'numeric' : null"
                [attr.autocomplete]="cfg.autocomplete ?? null"
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

        <!-- public_private: Aria single-select listbox stand-in (ADR 0010). -->
        <div class="space-y-2">
          <span
            [id]="fieldId('public_private') + '-label'"
            [class]="labelClass"
            i18n="@@vendor.profile.ownership.label"
          >
            Ownership
          </span>
          <ul
            ngListbox
            orientation="horizontal"
            selectionMode="explicit"
            [readonly]="!canEdit()"
            [(value)]="publicPrivateSel"
            [attr.aria-labelledby]="fieldId('public_private') + '-label'"
            class="m-0 flex list-none flex-wrap gap-2 p-0"
          >
            @for (opt of ownershipOptions; track opt.value) {
              <li
                ngOption
                [value]="opt.value"
                [label]="opt.label"
                class="cursor-pointer rounded-(--radius-md) border border-(--border-default) px-4 py-2 text-sm font-medium text-(--text-primary) transition-colors data-[active=true]:border-(--border-strong) aria-selected:border-(--accent-primary) aria-selected:bg-(--accent-primary) aria-selected:text-(--surface-base) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                {{ opt.label }}
              </li>
            }
          </ul>
        </div>
      </fieldset>

      <fieldset class="space-y-5 border-0 p-0">
        <legend
          class="font-label text-sm font-semibold text-(--text-primary)"
          i18n="@@vendor.profile.section.links"
        >
          Links
        </legend>
        @for (cfg of linkFields; track cfg.key) {
          <div class="space-y-1.5">
            <label [for]="fieldId(cfg.key)" [class]="labelClass">{{ cfg.label }}</label>
            <input
              [id]="fieldId(cfg.key)"
              [type]="inputType(cfg.control)"
              [attr.autocomplete]="cfg.autocomplete ?? null"
              [value]="model()[cfg.key]"
              [readOnly]="!canEdit()"
              (input)="onInput(cfg.key, $event)"
              [attr.aria-invalid]="fieldErrors()[cfg.key] ? 'true' : null"
              [attr.aria-describedby]="fieldErrors()[cfg.key] ? fieldId(cfg.key) + '-error' : null"
              [class]="controlClass()"
            />
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
      </fieldset>

      <div class="flex flex-wrap items-center gap-4">
        @if (canEdit()) {
          <button type="submit" [disabled]="saveDisabled()" [class]="saveButtonClass">
            @if (saving()) {
              <span i18n="@@vendor.profile.saving">Saving…</span>
            } @else {
              <span i18n="@@vendor.profile.save">Save changes</span>
            }
          </button>
        }
        @if (saved()) {
          <p
            class="text-sm font-medium text-(--accent-primary)"
            role="status"
            i18n="@@vendor.profile.saved"
          >
            Profile updated. Your listing shows the change now; search results refresh within a day.
          </p>
        } @else if (saveError()) {
          <p
            class="text-sm font-medium text-(--text-primary)"
            role="alert"
            i18n="@@vendor.profile.saveError"
          >
            Something went wrong saving your changes. Please try again.
          </p>
        }
      </div>
    </form>
  `,
  styles: [':host { display: block; }'],
})
export class VendorProfileForm {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);

  readonly vendor = input.required<VendorAccount>();

  /** Whether the caller's entitlement holds `profile.edit` (§8). Defaults open so
   *  no existing caller changes behaviour; the shells feed it the real value. */
  readonly canEdit = input<boolean>(true);

  protected readonly profileFields: readonly FieldConfig[] = [
    {
      key: 'description',
      control: 'textarea',
      label: $localize`:@@vendor.profile.field.description:Description`,
    },
    {
      key: 'website',
      control: 'url',
      autocomplete: 'url',
      label: $localize`:@@vendor.profile.field.website:Website`,
    },
    {
      key: 'headquarters',
      control: 'text',
      label: $localize`:@@vendor.profile.field.headquarters:Headquarters`,
    },
    {
      key: 'founded_year',
      control: 'year',
      label: $localize`:@@vendor.profile.field.foundedYear:Founded year`,
    },
    {
      key: 'parent_company',
      control: 'text',
      label: $localize`:@@vendor.profile.field.parentCompany:Parent company`,
    },
    {
      key: 'contact_email',
      control: 'email',
      autocomplete: 'email',
      label: $localize`:@@vendor.profile.field.contactEmail:Contact email`,
    },
    {
      key: 'phone_number',
      control: 'tel',
      autocomplete: 'tel',
      label: $localize`:@@vendor.profile.field.phoneNumber:Phone number`,
    },
    {
      key: 'logo_url',
      control: 'url',
      label: $localize`:@@vendor.profile.field.logoUrl:Logo URL`,
    },
  ];

  protected readonly linkFields: readonly FieldConfig[] = [
    {
      key: 'linkedin_url',
      control: 'url',
      label: $localize`:@@vendor.profile.field.linkedin:LinkedIn`,
    },
    { key: 'x_url', control: 'url', label: $localize`:@@vendor.profile.field.x:X (Twitter)` },
    {
      key: 'facebook_url',
      control: 'url',
      label: $localize`:@@vendor.profile.field.facebook:Facebook`,
    },
    {
      key: 'instagram_url',
      control: 'url',
      label: $localize`:@@vendor.profile.field.instagram:Instagram`,
    },
    {
      key: 'youtube_url',
      control: 'url',
      label: $localize`:@@vendor.profile.field.youtube:YouTube`,
    },
    {
      key: 'crunchbase_url',
      control: 'url',
      label: $localize`:@@vendor.profile.field.crunchbase:Crunchbase`,
    },
    { key: 'wiki_url', control: 'url', label: $localize`:@@vendor.profile.field.wiki:Wikipedia` },
    {
      key: 'github_org',
      control: 'text',
      label: $localize`:@@vendor.profile.field.githubOrg:GitHub organization`,
    },
  ];

  private get allFields(): readonly FieldConfig[] {
    return [...this.profileFields, ...this.linkFields];
  }

  protected readonly ownershipOptions: ReadonlyArray<{ value: string; label: string }> = [
    { value: '', label: $localize`:@@vendor.profile.ownership.unset:Not specified` },
    { value: 'public', label: $localize`:@@vendor.profile.ownership.public:Public` },
    { value: 'private', label: $localize`:@@vendor.profile.ownership.private:Private` },
  ];

  /** The clean state to diff against — re-seeded from the PATCH echo on save. */
  private readonly baseline = signal<VendorAccount | null>(null);
  /** The editable string values, keyed by field. */
  protected readonly model = signal<Record<string, string>>({});
  /** Aria listbox value (always an array; `['']` = "Not specified"). */
  protected readonly publicPrivateSel = signal<string[]>(['']);

  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly saveError = signal(false);

  protected readonly labelClass =
    'block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)';
  /** Everything but the background, which is the read-only tell. Two `bg-*`
   *  utilities on one element would race on stylesheet order, so the surface
   *  token is chosen once, here, rather than appended as an override. */
  private readonly inputBase =
    'w-full rounded-(--radius-md) border border-(--border-default) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  /** Read-only fields sit on the sunken surface so "not editable" is visible as
   *  well as announced, without dimming the text below the contrast floor. */
  protected readonly controlClass = computed(() =>
    this.canEdit()
      ? `${this.inputBase} bg-(--surface-base)`
      : `${this.inputBase} bg-(--surface-sunken)`,
  );
  protected readonly saveButtonClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--accent-primary) px-5 py-2.5 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50';
  protected readonly reloadButtonClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-label text-(--text-primary) transition-colors hover:bg-(--surface-raised) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  /** Live per-field validity — an empty value is a valid "clear" (every field is
   *  nullable), otherwise the single field is checked against the shared schema. */
  protected readonly fieldErrors = computed<Record<string, string | null>>(() => {
    const m = this.model();
    const out: Record<string, string | null> = {};
    for (const cfg of this.allFields) {
      const raw = (m[cfg.key] ?? '').trim();
      if (raw === '') {
        out[cfg.key] = null;
        continue;
      }
      const value: unknown = cfg.control === 'year' ? Number(raw) : raw;
      const res = UpdateVendorProfileSchema.safeParse({ [cfg.key]: value });
      out[cfg.key] = res.success ? null : this.messageFor(cfg.control);
    }
    return out;
  });

  /** Only the changed fields — the PATCH body (the endpoint requires ≥1). */
  protected readonly diff = computed<UpdateVendorProfileInput>(() => {
    const base = this.baseline();
    const out: Record<string, unknown> = {};
    if (!base) return out as UpdateVendorProfileInput;
    const m = this.model();
    for (const cfg of this.allFields) {
      const raw = (m[cfg.key] ?? '').trim();
      const orig = base[cfg.key];
      if (cfg.control === 'year') {
        const next = raw === '' ? null : Number(raw);
        if (next !== ((orig as number | null) ?? null)) out[cfg.key] = next;
      } else {
        const next = raw === '' ? null : raw;
        if (next !== ((orig as string | null) ?? null)) out[cfg.key] = next;
      }
    }
    const pp = this.publicPrivateSel()[0] ?? '';
    const ppNext = pp === '' ? null : pp;
    if (ppNext !== (base.public_private ?? null)) out['public_private'] = ppNext;
    return out as UpdateVendorProfileInput;
  });

  protected readonly hasChanges = computed(() => Object.keys(this.diff()).length > 0);
  protected readonly hasErrors = computed(() =>
    Object.values(this.fieldErrors()).some((e) => e !== null),
  );
  protected readonly saveDisabled = computed(
    () => !this.canEdit() || this.saving() || !this.hasChanges() || this.hasErrors(),
  );

  /** The store deferred a fresh vendor payload because THIS form is holding it. */
  protected readonly updatedElsewhere = computed(() => this.store.isStale('profile'));

  /**
   * One-shot override for the re-seed guard below. "Reload this section" has to
   * beat "never clobber unsaved edits", and it cannot do that by clearing the
   * store's flag alone: the guard reads the local model, which is still dirty at
   * the moment the fresh payload arrives.
   */
  private readonly acceptNextPayload = signal(false);

  constructor() {
    // Re-seed from the input whenever the payload changes and there is nothing
    // unsaved to lose. Reading `hasChanges()` untracked keeps this an
    // input-driven effect rather than a per-keystroke one.
    effect(() => {
      const v = this.vendor();
      untracked(() => {
        if (this.hasChanges() && !this.acceptNextPayload()) return;
        this.acceptNextPayload.set(false);
        this.seed(v);
      });
    });

    // Tell the store when there is something to protect. `hasChanges` is a
    // computed boolean, so this only runs on the transitions.
    effect(() => {
      if (this.hasChanges()) untracked(() => this.store.markDirty('profile'));
      else untracked(() => this.store.clearDirty('profile'));
    });
  }

  /** Take the server's copy and drop the unsaved edits. Deliberately explicit:
   *  the affordance says what it will do before the vendor clicks it. */
  protected reloadSection(): void {
    this.acceptNextPayload.set(true);
    void this.store.reload('profile');
  }

  protected fieldId(key: string): string {
    return `vendor-profile-${key.replace(/_/g, '-')}`;
  }

  protected inputType(control: Control): string {
    switch (control) {
      case 'year':
        return 'number';
      case 'email':
        return 'email';
      case 'tel':
        return 'tel';
      case 'url':
        return 'url';
      default:
        return 'text';
    }
  }

  protected onInput(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.model.update((m) => ({ ...m, [key]: value }));
    this.saved.set(false);
  }

  protected async onSave(): Promise<void> {
    // The submit button is not rendered without `profile.edit`, but a form still
    // submits on Enter from a focused field, and read-only fields stay focusable
    // on purpose. Guard the handler, not just the button.
    if (!this.canEdit()) return;
    this.saved.set(false);
    this.saveError.set(false);
    const body = this.diff();
    const parsed = UpdateVendorProfileSchema.safeParse(body);
    if (!parsed.success) return; // guarded by saveDisabled; defensive
    this.saving.set(true);
    try {
      const res = await this.api.updateProfile(parsed.data);
      this.seed(res.vendor);
      this.saved.set(true);
    } catch {
      this.saveError.set(true);
    } finally {
      this.saving.set(false);
    }
  }

  private seed(v: VendorAccount): void {
    this.baseline.set(v);
    const m: Record<string, string> = {};
    for (const cfg of this.allFields) {
      const val = v[cfg.key];
      m[cfg.key] = val == null ? '' : String(val);
    }
    this.model.set(m);
    this.publicPrivateSel.set([v.public_private ?? '']);
  }

  private messageFor(control: Control): string {
    switch (control) {
      case 'url':
        return $localize`:@@vendor.profile.error.url:Enter a URL starting with http:// or https://`;
      case 'email':
        return $localize`:@@vendor.profile.error.email:Enter a valid email address.`;
      case 'year':
        return $localize`:@@vendor.profile.error.year:Enter a year between 1800 and 2100.`;
      default:
        return $localize`:@@vendor.profile.error.tooLong:This value is too long.`;
    }
  }
}
