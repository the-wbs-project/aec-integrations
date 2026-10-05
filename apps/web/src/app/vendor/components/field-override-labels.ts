import type { IntegrationEditField } from '@aeci/shared';

import { editFieldLabel } from './vendor-contest-labels';

/**
 * A lockable field (AECI-1237), as the portal and the admin panel name it. Integration
 * fields reuse the portal's edit labels, so both sides name a field the same way.
 * Unknown names render as-is.
 */
export function fieldOverrideLabel(field: string): string {
  switch (field) {
    case 'website':
      return $localize`:@@fieldOverride.field.website:Website`;
    case 'headquarters':
      return $localize`:@@fieldOverride.field.headquarters:Headquarters`;
    case 'founded_year':
      return $localize`:@@fieldOverride.field.foundedYear:Founded year`;
    case 'public_private':
      return $localize`:@@fieldOverride.field.ownership:Ownership`;
    case 'parent_company':
      return $localize`:@@fieldOverride.field.parentCompany:Parent company`;
    case 'contact_email':
      return $localize`:@@fieldOverride.field.contactEmail:Contact email`;
    case 'phone_number':
      return $localize`:@@fieldOverride.field.phoneNumber:Phone number`;
    case 'linkedin_url':
      return $localize`:@@fieldOverride.field.linkedin:LinkedIn`;
    case 'x_url':
      return $localize`:@@fieldOverride.field.x:X (Twitter)`;
    case 'facebook_url':
      return $localize`:@@fieldOverride.field.facebook:Facebook`;
    case 'instagram_url':
      return $localize`:@@fieldOverride.field.instagram:Instagram`;
    case 'youtube_url':
      return $localize`:@@fieldOverride.field.youtube:YouTube`;
    case 'crunchbase_url':
      return $localize`:@@fieldOverride.field.crunchbase:Crunchbase`;
    case 'wiki_url':
      return $localize`:@@fieldOverride.field.wiki:Wikipedia`;
    case 'github_org':
      return $localize`:@@fieldOverride.field.github:GitHub organization`;
    case 'tool_integrations_url':
      return $localize`:@@fieldOverride.field.toolIntegrations:Integrations page`;
    case 'api_docs_url':
      return $localize`:@@fieldOverride.field.apiDocs:API documentation`;
    case 'name':
    case 'mechanism_kind':
    case 'mechanism_name':
    case 'direction':
    case 'description':
    case 'listing_url':
    case 'docs_url':
    case 'pricing_model':
    case 'maturity':
    case 'pricing_url':
      return editFieldLabel(field as IntegrationEditField);
    default:
      return field;
  }
}
