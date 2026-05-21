export interface StarBucket {
  readonly stars: 1 | 2 | 3 | 4 | 5;
  readonly count: number;
}

export interface CategoryRanking {
  readonly category: string;
  readonly rank: number | null;
  readonly outOf: number;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly logoUrl: string;
  readonly reviewScore: number;
  readonly reviewCount: number;
  readonly distribution: ReadonlyArray<StarBucket>;
  readonly lastReviewed: string;
  readonly rankings: ReadonlyArray<CategoryRanking>;
}

export interface VendorSupport {
  readonly hours: string;
  readonly channels: ReadonlyArray<string>;
  readonly sla: string;
}

export interface VendorTopRanking {
  readonly product: string;
  readonly category: string;
  readonly rank: number;
  readonly reviewCount: number;
}

export interface Vendor {
  readonly name: string;
  readonly initial: string;
  readonly domain: string;
  readonly website: string;
  readonly tagline: string;
  readonly hq: string;
  readonly founded: number;
  readonly ownership: string;
  readonly employees: string;
  readonly description: ReadonlyArray<string>;
  readonly support: VendorSupport;
  readonly topRanking: VendorTopRanking;
}

export const VENDOR_FIXTURE: Vendor = {
  name: 'Procore',
  initial: 'P',
  domain: 'procore.com',
  website: 'https://www.procore.com',
  tagline:
    'Construction management software that connects the office, field, and crew on a single platform — preconstruction, project management, financials, quality, and safety in one record of work.',
  hq: 'Carpinteria, CA, US',
  founded: 2002,
  ownership: 'Public (NYSE: PCOR)',
  employees: '3,800+',
  description: [
    'Procore Technologies provides cloud-based construction management software used by owners, general contractors, and specialty contractors across commercial, industrial, infrastructure, and residential projects. The platform centralises drawings, RFIs, submittals, daily logs, and financials so the field and office work from the same record.',
    'The product suite covers the full project lifecycle: bid management and estimating in preconstruction; project management, scheduling, and document control during execution; budgeting, change orders, and subcontractor payments in financials; and inspection, observation, and incident workflows in quality & safety.',
    'Procore is delivered as a per-user, unlimited-projects subscription with open APIs and a mature integrations marketplace covering BIM authoring tools, accounting ERPs, and field hardware. Customers include Balfour Beatty, Skanska, and Webcor.',
    'Procore has been publicly traded on the NYSE since 2021 (ticker PCOR) and operates from offices in the US, Canada, the UK, Ireland, Australia, Mexico, and the Philippines.',
  ],
  support: {
    hours: '24 × 7',
    channels: ['Phone', 'Email', 'In-app'],
    sla: 'Enterprise SLAs available',
  },
  topRanking: {
    product: 'Project Management',
    category: 'Construction Project Management',
    rank: 1,
    reviewCount: 1842,
  },
};

export const PRODUCTS_FIXTURE: ReadonlyArray<Product> = [
  {
    id: 'project-management',
    name: 'Project Management',
    description:
      'Drawings, RFIs, submittals, schedules, and daily logs unified on a single record so the office and field never fall out of sync.',
    logoUrl: '',
    reviewScore: 4.5,
    reviewCount: 1842,
    distribution: [
      { stars: 5, count: 1102 },
      { stars: 4, count: 521 },
      { stars: 3, count: 142 },
      { stars: 2, count: 51 },
      { stars: 1, count: 26 },
    ],
    lastReviewed: '2026-04-30',
    rankings: [
      { category: 'Construction Project Management', rank: 1, outOf: 42 },
      { category: 'Drawing Management', rank: 2, outOf: 19 },
      { category: 'Submittal Workflow', rank: 3, outOf: 14 },
    ],
  },
  {
    id: 'financials',
    name: 'Financials',
    description:
      'Budgets, change orders, subcontractor payments, and forecasts tied to live cost data flowing from the field.',
    logoUrl: '',
    reviewScore: 4.3,
    reviewCount: 612,
    distribution: [
      { stars: 5, count: 312 },
      { stars: 4, count: 198 },
      { stars: 3, count: 64 },
      { stars: 2, count: 28 },
      { stars: 1, count: 10 },
    ],
    lastReviewed: '2026-04-18',
    rankings: [
      { category: 'Construction Accounting', rank: 3, outOf: 21 },
      { category: 'Job Cost Tracking', rank: 2, outOf: 17 },
      { category: 'Subcontractor Management', rank: null, outOf: 12 },
    ],
  },
  {
    id: 'quality-safety',
    name: 'Quality & Safety',
    description:
      'Inspections, observations, and incident workflows that move from punchlist to root-cause with attached photos and BIM context.',
    logoUrl: '',
    reviewScore: 4.4,
    reviewCount: 489,
    distribution: [
      { stars: 5, count: 274 },
      { stars: 4, count: 162 },
      { stars: 3, count: 35 },
      { stars: 2, count: 12 },
      { stars: 1, count: 6 },
    ],
    lastReviewed: '2026-05-02',
    rankings: [
      { category: 'EHS — Construction', rank: 2, outOf: 18 },
      { category: 'Inspection Management', rank: 4, outOf: 22 },
    ],
  },
  {
    id: 'preconstruction',
    name: 'Preconstruction',
    description:
      'Bid management, estimating, and BIM-linked quantity takeoff that feeds award decisions and downstream budgets without a re-key.',
    logoUrl: '',
    reviewScore: 4.2,
    reviewCount: 312,
    distribution: [
      { stars: 5, count: 154 },
      { stars: 4, count: 108 },
      { stars: 3, count: 32 },
      { stars: 2, count: 12 },
      { stars: 1, count: 6 },
    ],
    lastReviewed: '2026-03-28',
    rankings: [
      { category: 'Construction Estimating', rank: 4, outOf: 28 },
      { category: 'Bid Management', rank: 3, outOf: 16 },
    ],
  },
  {
    id: 'field-productivity',
    name: 'Field Productivity',
    description:
      'Crew time, equipment tracking, and production rates captured on tablets so labour costs land in the budget the same day.',
    logoUrl: '',
    reviewScore: 4.6,
    reviewCount: 287,
    distribution: [
      { stars: 5, count: 188 },
      { stars: 4, count: 76 },
      { stars: 3, count: 16 },
      { stars: 2, count: 5 },
      { stars: 1, count: 2 },
    ],
    lastReviewed: '2026-05-10',
    rankings: [
      { category: 'Construction Time Tracking', rank: null, outOf: 11 },
      { category: 'Field Service Management', rank: null, outOf: 9 },
    ],
  },
  {
    id: 'bim',
    name: 'BIM',
    description:
      'Federated model viewer with clash detection, issue tracking, and 2D drawing overlay accessible from the office and on-site.',
    logoUrl: '',
    reviewScore: 4.1,
    reviewCount: 198,
    distribution: [
      { stars: 5, count: 88 },
      { stars: 4, count: 70 },
      { stars: 3, count: 26 },
      { stars: 2, count: 9 },
      { stars: 1, count: 5 },
    ],
    lastReviewed: '2026-04-05',
    rankings: [
      { category: 'BIM Coordination', rank: 5, outOf: 24 },
      { category: 'Model Viewer', rank: null, outOf: 17 },
    ],
  },
];
