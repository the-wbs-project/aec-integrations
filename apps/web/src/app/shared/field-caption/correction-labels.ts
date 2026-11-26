/**
 * The public name of a field AECi can correct or hide (AECI-1666), keyed by the override's
 * wire name (`field_overrides.field`). One map for every public page, so the listing
 * provenance panel and the inline "Under review" lines name a field the same way on the
 * product, vendor and pair pages.
 *
 * The names follow the page, not the portal: "Project phases" is the product page's
 * heading, and "Price" is the pair card's At a glance label. The portal and the admin
 * panel keep their own names in `vendor/components/field-override-labels.ts`.
 *
 * Each entry is a function so `$localize` runs at call time. An unknown name renders
 * as-is rather than blank. `correction-labels.component.spec.ts` asserts the map covers
 * every field the server can lock.
 */
const LABELS: Readonly<Record<string, () => string>> = {
  // Company fields (VENDOR_OVERRIDE_FIELDS).
  website: () => $localize`:@@correctionLabel.website:Website`,
  headquarters: () => $localize`:@@correctionLabel.headquarters:Headquarters`,
  founded_year: () => $localize`:@@correctionLabel.foundedYear:Founded`,
  ownership_type: () => $localize`:@@correctionLabel.ownership:Ownership`,
  // The name on rows recorded before AECI-1310.
  public_private: () => $localize`:@@correctionLabel.ownership:Ownership`,
  parent_company: () => $localize`:@@correctionLabel.parentCompany:Parent company`,
  company_size: () => $localize`:@@correctionLabel.companySize:Company size`,
  funding_stage: () => $localize`:@@correctionLabel.fundingStage:Funding stage`,
  contact_email: () => $localize`:@@correctionLabel.contactEmail:Contact email`,
  phone_number: () => $localize`:@@correctionLabel.phoneNumber:Phone number`,
  linkedin_url: () => $localize`:@@correctionLabel.linkedin:LinkedIn`,
  x_url: () => $localize`:@@correctionLabel.x:X (Twitter)`,
  facebook_url: () => $localize`:@@correctionLabel.facebook:Facebook`,
  instagram_url: () => $localize`:@@correctionLabel.instagram:Instagram`,
  youtube_url: () => $localize`:@@correctionLabel.youtube:YouTube`,
  crunchbase_url: () => $localize`:@@correctionLabel.crunchbase:Crunchbase`,
  wiki_url: () => $localize`:@@correctionLabel.wiki:Wikipedia`,
  github_org: () => $localize`:@@correctionLabel.github:GitHub organization`,
  // AECI-1628: an admin logo overwrite on a held record is recorded as a correction.
  logo_url: () => $localize`:@@correctionLabel.logo:Logo`,
  // Product fields (PRODUCT_OVERRIDE_FIELDS): the two Resources links, then the facets.
  tool_integrations_url: () => $localize`:@@correctionLabel.toolIntegrations:Integrations page`,
  api_docs_url: () => $localize`:@@correctionLabel.apiDocs:API documentation`,
  // AECI-2198: hideable, never lockable. The hero marks it in its slot.
  summary: () => $localize`:@@correctionLabel.summary:Summary`,
  category_slugs: () => $localize`:@@correctionLabel.categories:Categories`,
  audience_slugs: () => $localize`:@@correctionLabel.audiences:Audiences`,
  trade_slugs: () => $localize`:@@correctionLabel.trades:Trades`,
  phase_slugs: () => $localize`:@@correctionLabel.phases:Project phases`,
  // Integration fields (INTEGRATION_EDIT_FIELDS), as the pair card names them.
  name: () => $localize`:@@correctionLabel.name:Name`,
  mechanism_kind: () => $localize`:@@correctionLabel.mechanismKind:How you get it`,
  mechanism_name: () => $localize`:@@correctionLabel.mechanismName:Connection name`,
  direction: () => $localize`:@@correctionLabel.direction:Direction`,
  description: () => $localize`:@@correctionLabel.description:Description`,
  listing_url: () => $localize`:@@correctionLabel.listingUrl:Listing link`,
  docs_url: () => $localize`:@@correctionLabel.docsUrl:Documentation link`,
  pricing_model: () => $localize`:@@correctionLabel.pricingModel:Price`,
  pricing_url: () => $localize`:@@correctionLabel.pricingUrl:Pricing page`,
  maturity: () => $localize`:@@correctionLabel.maturity:Release stage`,
  // AECI-1628: a contest-only field an AECi accept can record as a correction.
  mechanism_url: () => $localize`:@@correctionLabel.mechanismUrl:Connection link`,
  // AECI-2139: AECi's correction of one data flow on a Sync Service pair. The line names
  // no data type, so a removed flow still shows nowhere on the page.
  data_flow: () => $localize`:@@correctionLabel.dataFlow:A data flow`,
};

/** The public name of `field`, or `field` itself when the map does not know it. */
export function correctionLabel(field: string): string {
  return Object.hasOwn(LABELS, field) ? LABELS[field]() : field;
}

/** Whether the map names `field`. For the coverage spec. */
export function hasCorrectionLabel(field: string): boolean {
  return Object.hasOwn(LABELS, field);
}
