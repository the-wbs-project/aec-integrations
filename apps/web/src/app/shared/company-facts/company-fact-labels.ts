import type { CompanySizeBand, FundingStage, OwnershipType } from '@aeci/shared';

/** Display labels for the company-fact vocabularies (AECI-1310). The one place they live. */

export function companySizeLabel(band: CompanySizeBand): string {
  switch (band) {
    case '1-10':
      return $localize`:@@companyFacts.size.1to10:1–10`;
    case '11-50':
      return $localize`:@@companyFacts.size.11to50:11–50`;
    case '51-200':
      return $localize`:@@companyFacts.size.51to200:51–200`;
    case '201-1000':
      return $localize`:@@companyFacts.size.201to1000:201–1,000`;
    case '1001+':
      return $localize`:@@companyFacts.size.1001plus:1,001+`;
  }
}

export function ownershipTypeLabel(type: OwnershipType): string {
  switch (type) {
    case 'public':
      return $localize`:@@vendor.profile.ownership.public:Public`;
    case 'private':
      return $localize`:@@vendor.profile.ownership.private:Private`;
    case 'subsidiary':
      return $localize`:@@companyFacts.ownership.subsidiary:Subsidiary`;
    case 'nonprofit':
      return $localize`:@@companyFacts.ownership.nonprofit:Nonprofit`;
  }
}

export function fundingStageLabel(stage: FundingStage): string {
  switch (stage) {
    case 'Bootstrapped':
      return $localize`:@@companyFacts.funding.bootstrapped:Bootstrapped`;
    case 'Pre-seed':
      return $localize`:@@companyFacts.funding.preSeed:Pre-seed`;
    case 'Seed':
      return $localize`:@@companyFacts.funding.seed:Seed`;
    case 'Series A':
      return $localize`:@@companyFacts.funding.seriesA:Series A`;
    case 'Series B':
      return $localize`:@@companyFacts.funding.seriesB:Series B`;
    case 'Series C':
      return $localize`:@@companyFacts.funding.seriesC:Series C`;
    case 'Series D+':
      return $localize`:@@companyFacts.funding.seriesD:Series D+`;
    case 'Public':
      return $localize`:@@companyFacts.funding.public:Publicly traded`;
  }
}
