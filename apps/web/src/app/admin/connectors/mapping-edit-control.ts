import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';

import {
  CONNECTOR_DECISION_STATUSES,
  CONNECTOR_MAPPING_CONFIDENCES,
  CONNECTOR_MAPPING_STATUSES,
  type AdminConnectorMapping,
  type ConnectorStubMappingEditResponse,
  type LinkRef,
  type UpdateConnectorStubMappingInput,
} from '@aeci/shared';

import { AecSelect, type AecSelectOption } from '../../shared/aec-select/aec-select';
import { mappingConfidenceLabel, mappingStatusLabel } from './connector-labels';
import { MappingEditApi } from './mapping-edit-api';

/**
 * Edit one mapping on a VENDOR-MANAGED catalogue (AECI-724 — `ADMIN_PANEL_SPEC.md`
 * §5.9), over `PATCH /api/admin/connector-stub-mappings/:id`.
 *
 * ── THE HOST DECIDES WHETHER IT EXISTS ─────────────────────────────────────
 * `/admin/connectors/:id` renders this only when `managed_by = 'vendor'`. On a
 * `review`-managed catalogue the endpoint answers 409 `CATALOG_REVIEW_MANAGED`,
 * because the next sync page would overwrite the edit. A control that could only
 * ever fail is not rendered. The 409 is still handled here, for the lane being
 * reclaimed while the form is open.
 *
 * ── WHAT IT EDITS ───────────────────────────────────────────────────────────
 * The product pointer (status + product) and the depth (confidence + evidence),
 * the four columns the endpoint accepts. It sends all four on save; the server
 * answers an unchanged row as a 200 no-op that writes nothing. It says out loud
 * that saving stamps the operator as the decider, because that is what makes a
 * `mapped` row publishable on the public reach line.
 *
 * ── HOST-OWNED CHROME ───────────────────────────────────────────────────────
 * No heading and no live region, the `ManagedByControl` contract: the host owns its
 * single `role="status"` region and announcements go out through {@link announce}.
 */
@Component({
  selector: 'aec-mapping-edit-control',
  imports: [AecSelect],
  templateUrl: './mapping-edit-control.html',
})
export class MappingEditControl {
  private readonly api = inject(MappingEditApi);

  readonly mapping = input.required<AdminConnectorMapping>();
  /** The listing's label, for copy that names what is being edited. */
  readonly listing = input.required<string>();
  /** Stem for the form's `id`/`for` pairs. One control per mapping row. */
  readonly idPrefix = input.required<string>();

  /** The committed row. Emitted rather than refetched: the PATCH returns it. */
  readonly changed = output<ConnectorStubMappingEditResponse>();
  readonly announce = output<string>();

  protected readonly open = signal(false);
  protected readonly pending = signal(false);
  protected readonly failedMessage = signal('');

  protected readonly status = signal<string>('mapped');
  protected readonly product = signal<LinkRef | null>(null);
  protected readonly confidence = signal<string | null>(null);
  protected readonly evidenceUrl = signal('');

  protected readonly productQuery = signal('');
  protected readonly productResults = signal<readonly LinkRef[]>([]);
  protected readonly productSearching = signal(false);
  protected readonly searchNotice = signal('');

  /** §9a.4: `mapped` / `ruled_out` name a product, the decision statuses name none. */
  protected readonly namesProduct = computed(
    () => !(CONNECTOR_DECISION_STATUSES as readonly string[]).includes(this.status()),
  );

  protected readonly statusOptions: readonly AecSelectOption[] = CONNECTOR_MAPPING_STATUSES.map(
    (value) => ({ value, label: mappingStatusLabel(value) }),
  );
  protected readonly confidenceOptions: readonly AecSelectOption[] = [
    { value: null, label: mappingConfidenceLabel(null) },
    ...CONNECTOR_MAPPING_CONFIDENCES.map((value) => ({
      value,
      label: mappingConfidenceLabel(value),
    })),
  ];

  protected openForm(): void {
    const m = this.mapping();
    this.status.set(m.status);
    this.product.set(m.product);
    this.confidence.set(m.confidence);
    this.evidenceUrl.set(m.evidence_url ?? '');
    this.productQuery.set('');
    this.productResults.set([]);
    this.searchNotice.set('');
    this.failedMessage.set('');
    this.open.set(true);
  }

  protected closeForm(): void {
    this.open.set(false);
    this.productResults.set([]);
    this.failedMessage.set('');
  }

  protected onStatusChange(value: string | null): void {
    if (value) this.status.set(value);
  }

  protected onConfidenceChange(value: string | null): void {
    this.confidence.set(value);
  }

  protected onEvidenceInput(event: Event): void {
    this.evidenceUrl.set((event.target as HTMLInputElement).value);
  }

  protected onProductQueryInput(event: Event): void {
    this.productQuery.set((event.target as HTMLInputElement).value);
  }

  protected async searchProducts(): Promise<void> {
    const query = this.productQuery().trim();
    if (query.length < 2) {
      this.searchNotice.set(
        $localize`:@@admin.connectors.mapping.search.short:Type at least two letters of the product name.`,
      );
      return;
    }
    if (this.productSearching()) return;
    this.productSearching.set(true);
    this.searchNotice.set('');
    try {
      const page = await this.api.searchProducts(query);
      const found = page.data.map((p) => ({ id: p.id, name: p.name, slug: p.slug }));
      this.productResults.set(found);
      if (found.length === 0) {
        this.searchNotice.set(
          $localize`:@@admin.connectors.mapping.search.none:No published product matches that name.`,
        );
      }
    } catch {
      this.productResults.set([]);
      this.searchNotice.set(
        $localize`:@@admin.connectors.mapping.search.failed:The search did not work. Try again.`,
      );
    } finally {
      this.productSearching.set(false);
    }
  }

  protected chooseProduct(product: LinkRef): void {
    this.product.set(product);
    this.productResults.set([]);
    this.productQuery.set('');
  }

  protected clearProduct(): void {
    this.product.set(null);
  }

  protected async submit(): Promise<void> {
    if (this.pending()) return;
    const namesProduct = this.namesProduct();
    const product = namesProduct ? this.product() : null;
    if (namesProduct && !product) {
      this.failedMessage.set(
        $localize`:@@admin.connectors.mapping.error.needsProduct:Choose the product this listing is, or pick a status that names none.`,
      );
      return;
    }
    const evidence = this.evidenceUrl().trim();
    const body: UpdateConnectorStubMappingInput = {
      status: this.status() as UpdateConnectorStubMappingInput['status'],
      productId: product?.id ?? null,
      confidence: this.confidence() as UpdateConnectorStubMappingInput['confidence'],
      evidenceUrl: evidence === '' ? null : evidence,
    };

    this.failedMessage.set('');
    this.pending.set(true);
    try {
      const result = await this.api.updateMapping(this.mapping().id, body);
      this.changed.emit(result);
      this.closeForm();
      const listing = this.listing();
      this.announce.emit(
        result.changed
          ? $localize`:@@admin.connectors.mapping.announce.saved:Mapping for ${listing}:LISTING: saved.`
          : $localize`:@@admin.connectors.mapping.announce.unchanged:Nothing changed on the mapping for ${listing}:LISTING:.`,
      );
    } catch (err) {
      this.failedMessage.set(messageForError(err));
    } finally {
      this.pending.set(false);
    }
  }
}

/** The endpoint's refusals, each in words the operator can act on. */
function messageForError(err: unknown): string {
  if (err instanceof HttpErrorResponse) {
    const code = (err.error as { error?: { code?: string; message?: string } } | null)?.error;
    if (code?.code === 'CATALOG_REVIEW_MANAGED') {
      return $localize`:@@admin.connectors.mapping.error.reviewManaged:This catalogue went back to the review app, so the edit was not saved. Reload to see where it stands.`;
    }
    if (code?.code === 'MAPPING_CONFLICT') {
      return $localize`:@@admin.connectors.mapping.error.conflict:This listing already has that mapping, or already carries a listing-level decision. Edit that row instead.`;
    }
    if (err.status === 422 || err.status === 400) {
      return $localize`:@@admin.connectors.mapping.error.invalid:Check the product and the evidence link. The evidence link must start with https://.`;
    }
    if (err.status === 404) {
      return $localize`:@@admin.connectors.mapping.error.gone:This mapping no longer exists. Reload the page.`;
    }
    if (err.status === 403) {
      return $localize`:@@admin.connectors.mapping.error.forbidden:You do not have permission to edit mappings.`;
    }
  }
  return $localize`:@@admin.connectors.mapping.error.failed:Something went wrong. Please try again.`;
}
