/**
 * Content + tuning for the review seeder (scripts/seed-reviews.ts).
 *
 * This is a DEV/DEMO fixture, not production data. It exists so an operator can
 * preview a "fully going" catalog — product pages with rating summaries, the
 * 5-review averages threshold, pagination, and a realistic mix of busy vs. quiet
 * products. All seeded rows are anonymous (reviewer_id NULL) and approved.
 *
 * Fragments are grouped by sentiment so the title/body never contradict the star
 * rating the runner draws. `tags` softly steers a fragment toward products in a
 * matching AEC category; an untagged fragment is generic and fits any product.
 * `{product}` in a title or body is replaced with the product's display name.
 */

/** Sentiment tier — mapped to a rating band by the runner. */
export type Sentiment = 'positive' | 'mixed' | 'critical';

export interface ReviewFragment {
  /** 5–100 chars. May contain the `{product}` token. */
  title: string;
  /** ≥50 chars. May contain the `{product}` token. */
  body: string;
  sentiment: Sentiment;
  /**
   * Loose category keywords this fragment fits best. Matched as substrings
   * against a product's taxonomy-category slugs. Omit for a generic fragment.
   */
  tags?: string[];
}

/** Per-product review-count distribution. Weights need not sum to 1 (the runner
 * normalizes them). Tuned for a ~45-product catalog to land near 150–200 total
 * while leaving a handful of products at 0 and pushing many past the ≥5 threshold. */
export interface DistributionBucket {
  label: string;
  weight: number;
  min: number;
  max: number;
}

export const DISTRIBUTION: DistributionBucket[] = [
  { label: '0 reviews', weight: 0.16, min: 0, max: 0 },
  { label: '1–4 reviews', weight: 0.4, min: 1, max: 4 },
  { label: '5–7 reviews', weight: 0.32, min: 5, max: 7 },
  { label: '8–12 reviews', weight: 0.12, min: 8, max: 12 },
];

/** Share of reviews by sentiment (positively skewed, like real review sites). */
export const SENTIMENT_MIX: Record<Sentiment, number> = {
  positive: 0.56,
  mixed: 0.3,
  critical: 0.14,
};

export const ROLES = ['practitioner', 'manager', 'IT', 'exec', 'other'] as const;

/** ~60% of seeded reviews carry the verified-work-email badge. */
export const VERIFIED_WORK_EMAIL_RATE = 0.6;

/** Reviews are dated across roughly the past year. */
export const MAX_AGE_DAYS = 380;

export const REVIEW_FRAGMENTS: ReviewFragment[] = [
  // ─── Positive ──────────────────────────────────────────────────────────────
  {
    title: 'Cut our coordination time in half',
    body: 'We push models between {product} and the rest of our BIM stack daily and the sync just works. Clashes that used to take a full afternoon to round-trip now resolve in minutes.',
    sentiment: 'positive',
    tags: ['bim', 'design', 'authoring', 'coordination'],
  },
  {
    title: 'The integration we wished we had years ago',
    body: 'Data flows cleanly in both directions and we stopped re-keying anything by hand. {product} earned its place in our standard toolkit within the first month.',
    sentiment: 'positive',
  },
  {
    title: 'Solid native connector, no middleware needed',
    body: 'No third-party glue, no brittle exports. The native link held up across a 14-discipline project and the field team never noticed a hiccup.',
    sentiment: 'positive',
    tags: ['bim', 'construction', 'field'],
  },
  {
    title: 'Onboarding was genuinely painless',
    body: 'Stood it up in an afternoon following the docs. The setup wizard mapped our project structure correctly on the first try and support answered our one question same-day.',
    sentiment: 'positive',
    tags: ['project-management', 'construction', 'docs'],
  },
  {
    title: 'Reliable sync at scale',
    body: 'We run {product} across nine concurrent jobs and the data stays consistent. Versioning is clear and rollbacks have saved us more than once.',
    sentiment: 'positive',
    tags: ['accounting', 'erp', 'finance', 'project-management'],
  },
  {
    title: 'Reality capture finally fits our workflow',
    body: 'Point clouds land in our authoring tool aligned and decimated sensibly. Scan-to-BIM used to be a week of cleanup; with {product} it is closer to a day.',
    sentiment: 'positive',
    tags: ['reality-capture', 'scan', 'bim'],
  },
  {
    title: 'Accounting and field data finally agree',
    body: 'Cost codes map straight through and our monthly close stopped being a reconciliation nightmare. Finance and PMs are looking at the same numbers for once.',
    sentiment: 'positive',
    tags: ['accounting', 'erp', 'finance'],
  },
  {
    title: 'Best-in-class documentation',
    body: 'Every endpoint we needed was documented with real examples. Our developers wired up the {product} API in two days without a single support ticket.',
    sentiment: 'positive',
    tags: ['api', 'docs', 'ai'],
  },
  {
    title: 'Field crews actually adopted it',
    body: 'Punch lists and RFIs sync back to the office without anyone thinking about it. Adoption on site was near-instant because the mobile flow is so simple.',
    sentiment: 'positive',
    tags: ['field', 'construction', 'project-management'],
  },
  {
    title: 'Rock-solid structural round-trip',
    body: 'Analytical models go out and updated sections come back without breaking the physical model. That two-way link alone justified the {product} subscription.',
    sentiment: 'positive',
    tags: ['analysis', 'structural', 'bim'],
  },
  {
    title: 'Saved us from a custom build',
    body: 'We had budgeted to build this connector ourselves. {product} did everything we scoped out of the box and we redeployed those dev hours elsewhere.',
    sentiment: 'positive',
    tags: ['api', 'erp', 'accounting'],
  },
  {
    title: 'Support team knows AEC',
    body: 'You are not explaining what an RFI or a CDE is to first-line support. They understand the workflows and the fixes land fast.',
    sentiment: 'positive',
    tags: ['construction', 'docs', 'project-management'],
  },
  {
    title: 'Clean civil-to-construction handoff',
    body: 'Corridor and surface data carries into the construction model with georeferencing intact. {product} removed the manual re-survey step entirely.',
    sentiment: 'positive',
    tags: ['civil', 'infrastructure', 'construction'],
  },
  {
    title: 'Exactly what a connector should be',
    body: 'It is invisible in the best way — set it once, then forget it. Months in and it has never silently dropped a record on us.',
    sentiment: 'positive',
  },
  {
    title: 'Fast, predictable, well-supported',
    body: 'Performance is consistent even on our largest federated models. Release notes are honest and the roadmap has actually shipped what they promised.',
    sentiment: 'positive',
    tags: ['bim', 'coordination', 'design'],
  },
  {
    title: 'Took our document control to another level',
    body: 'Transmittals and markups stay in sync across the whole team and the audit trail is bulletproof. {product} is now central to how we run submittals.',
    sentiment: 'positive',
    tags: ['docs', 'construction', 'project-management'],
  },
  {
    title: 'Scheduling data that everyone trusts',
    body: 'The link kept our schedule and our model in lockstep through three major revisions. 4D reviews went from a chore to something the owner actually enjoys.',
    sentiment: 'positive',
    tags: ['project-management', 'construction', 'bim'],
  },
  {
    title: 'Worth it for the time savings alone',
    body: 'Conservatively this gives each coordinator back a few hours a week. Across the team that is a meaningful chunk of capacity we redirected to design.',
    sentiment: 'positive',
  },
  {
    title: 'Handled our messy legacy data',
    body: 'We were sure our historical data would choke the import. {product} mapped it with surprisingly few exceptions and flagged the ones it could not resolve.',
    sentiment: 'positive',
    tags: ['accounting', 'erp', 'finance', 'data'],
  },
  {
    title: 'The two-way sync is the real deal',
    body: 'Changes made anywhere propagate everywhere within seconds and conflicts are surfaced clearly instead of silently overwritten. Exactly the behavior you want.',
    sentiment: 'positive',
    tags: ['api', 'bim', 'data'],
  },
  {
    title: 'Great fit for a mid-size practice',
    body: 'Powerful without needing a dedicated admin. We are a 40-person firm and {product} scaled with us without a painful enterprise rollout.',
    sentiment: 'positive',
    tags: ['design', 'architecture', 'bim'],
  },
  {
    title: 'Estimating and model stay aligned',
    body: 'Quantities pulled straight from the model into our estimate and stayed current as the design moved. No more stale takeoffs sneaking into a bid.',
    sentiment: 'positive',
    tags: ['estimating', 'construction', 'bim'],
  },
  {
    title: 'Onboarding support went above and beyond',
    body: 'Their implementation team joined two calls and tailored the field mapping to how we actually work. We were live and trusting the data inside a week.',
    sentiment: 'positive',
    tags: ['erp', 'accounting', 'project-management'],
  },
  {
    title: 'AI features that are actually useful',
    body: 'The automated tagging and clash suggestions are not gimmicks — they cut real review time. {product} keeps getting smarter with each release.',
    sentiment: 'positive',
    tags: ['ai', 'coordination', 'bim'],
  },

  // ─── Mixed ───────────────────────────────────────────────────────────────────
  {
    title: 'Powerful, but the setup is a slog',
    body: 'Once configured it runs beautifully, but getting there took us the better part of two weeks and a few support tickets. Budget real time for the initial mapping.',
    sentiment: 'mixed',
    tags: ['erp', 'accounting', 'project-management'],
  },
  {
    title: 'Great product, rough onboarding',
    body: 'The core sync is excellent and we rely on it daily. The documentation, though, is thin in places and we learned several gotchas the hard way.',
    sentiment: 'mixed',
    tags: ['api', 'docs', 'bim'],
  },
  {
    title: 'Does the job, with caveats',
    body: '{product} handles the common cases well but struggles with our more exotic family parameters. We keep a manual checklist for the edge cases it misses.',
    sentiment: 'mixed',
    tags: ['bim', 'authoring', 'design'],
  },
  {
    title: 'Reliable once you learn its quirks',
    body: 'There is a learning curve and the error messages are not always helpful. After a month you internalize the patterns and it becomes dependable.',
    sentiment: 'mixed',
  },
  {
    title: 'Solid sync, dated interface',
    body: 'The data side is trustworthy but the UI feels a decade old and slows down new staff. Function over form, and you feel it during onboarding.',
    sentiment: 'mixed',
    tags: ['project-management', 'docs', 'construction'],
  },
  {
    title: 'Good value, occasional hiccups',
    body: 'For the price it covers a lot of ground. Every few weeks a sync stalls and needs a manual nudge, but nothing has ever been lost.',
    sentiment: 'mixed',
    tags: ['accounting', 'finance', 'erp'],
  },
  {
    title: 'Strong core, gaps at the edges',
    body: 'The headline integration with {product} is genuinely good. Support for our secondary tools is clearly an afterthought and lags behind.',
    sentiment: 'mixed',
    tags: ['bim', 'coordination', 'analysis'],
  },
  {
    title: 'Capable but needs an internal champion',
    body: 'This will not roll itself out. We got real value only after one of our coordinators took ownership and built the templates the rest of us follow.',
    sentiment: 'mixed',
    tags: ['construction', 'project-management', 'bim'],
  },
  {
    title: 'Mostly there on field-to-office',
    body: 'Photos and forms come back fine; the more complex form logic does not always survive the trip. Close, but we still double-check the important submittals.',
    sentiment: 'mixed',
    tags: ['field', 'construction', 'docs'],
  },
  {
    title: 'Improved a lot, still maturing',
    body: 'Early on it was frustrating, but the last few releases fixed our biggest pain points. {product} is clearly heading the right direction — just not finished.',
    sentiment: 'mixed',
    tags: ['ai', 'reality-capture', 'civil'],
  },
  {
    title: 'Works, but performance varies',
    body: 'On smaller projects it is instant. On our 2GB federated models the sync crawls and we schedule it overnight. Your mileage depends heavily on model size.',
    sentiment: 'mixed',
    tags: ['bim', 'coordination', 'reality-capture'],
  },
  {
    title: 'Decent, but support is hit or miss',
    body: 'When you reach a knowledgeable rep, problems get solved fast. Getting there can mean a day or two in the queue, which stings mid-deadline.',
    sentiment: 'mixed',
    tags: ['erp', 'accounting', 'project-management'],
  },
  {
    title: 'Right idea, half-documented',
    body: 'The integration concept is exactly what our team needed. The docs assume you already know the data model, so the first week was a lot of trial and error.',
    sentiment: 'mixed',
    tags: ['api', 'docs', 'data'],
  },
  {
    title: 'Fine for standard workflows',
    body: 'If you work the way {product} expects, it is smooth. The moment your process deviates, the rigidity shows and workarounds pile up.',
    sentiment: 'mixed',
    tags: ['project-management', 'construction'],
  },
  {
    title: 'Good bones, pricing creeps',
    body: 'The integration itself is dependable. What started as a clean cost grew as we added seats and modules — keep an eye on the line items.',
    sentiment: 'mixed',
    tags: ['accounting', 'finance', 'erp'],
  },
  {
    title: 'Steep curve, real payoff',
    body: 'Plan for a rough first month. We nearly gave up during setup, but the team that pushed through now would not work without it.',
    sentiment: 'mixed',
    tags: ['bim', 'analysis', 'structural'],
  },
  {
    title: 'Trustworthy data, clunky admin',
    body: 'The actual record sync has never let us down. Managing users and permissions, on the other hand, is more manual than it should be in this day and age.',
    sentiment: 'mixed',
    tags: ['erp', 'docs', 'project-management'],
  },
  {
    title: 'Promising, watch the edge cases',
    body: 'Handles the 90% beautifully. For the last 10% — unusual units, custom schedules — we built a small validation step to catch what {product} drops.',
    sentiment: 'mixed',
    tags: ['civil', 'infrastructure', 'data'],
  },

  // ─── Critical ────────────────────────────────────────────────────────────────
  {
    title: 'Sync conflicts cost us a day',
    body: 'Two people edited the same model region and {product} overwrote one set of changes without warning. We have since locked down our workflow, but the trust took a hit.',
    sentiment: 'critical',
    tags: ['bim', 'coordination', 'design'],
  },
  {
    title: 'Onboarding nearly broke us',
    body: 'The initial data mapping was undocumented and we corrupted a project on the first import. It took support a week to help us recover. Not a gentle start.',
    sentiment: 'critical',
    tags: ['erp', 'accounting', 'data'],
  },
  {
    title: 'Promised two-way, delivered one',
    body: 'Marketing said bi-directional; in practice the return path is fragile and we stopped relying on it. We export manually now, which defeats the purpose.',
    sentiment: 'critical',
    tags: ['api', 'bim', 'data'],
  },
  {
    title: 'Too brittle for production',
    body: 'A minor schema change on our side silently broke the {product} connection and no one noticed for three days. The lack of failure alerts is a real problem.',
    sentiment: 'critical',
    tags: ['api', 'data', 'erp'],
  },
  {
    title: 'Support could not keep up',
    body: 'We hit a blocking bug during a deadline and waited four days for a substantive reply. For a tool this central, that response time is hard to accept.',
    sentiment: 'critical',
    tags: ['project-management', 'construction', 'docs'],
  },
  {
    title: 'Performance falls apart at scale',
    body: 'Fine in the demo, unusable on our real federated models. Syncs time out and we have given up running it on anything over a gigabyte.',
    sentiment: 'critical',
    tags: ['bim', 'coordination', 'reality-capture'],
  },
  {
    title: 'Lost data, no clear audit trail',
    body: 'Records went missing after a sync and there was no log to tell us what happened. We could not reconstruct the change history, which is unacceptable for our QA.',
    sentiment: 'critical',
    tags: ['accounting', 'finance', 'docs'],
  },
  {
    title: 'Field app fights you',
    body: 'Forms time out on poor signal and lose entries, which is exactly when crews need them most. {product} clearly was not tested on a real job site.',
    sentiment: 'critical',
    tags: ['field', 'construction'],
  },
  {
    title: 'Constant manual cleanup',
    body: 'Every sync leaves duplicates and mismatched mappings we have to fix by hand. It creates nearly as much work as it saves.',
    sentiment: 'critical',
    tags: ['erp', 'accounting', 'data', 'project-management'],
  },
  {
    title: 'Not ready for civil workflows',
    body: 'Georeferencing dropped on import and our alignments shifted meters off. We reverted to our old manual handoff until {product} sorts this out.',
    sentiment: 'critical',
    tags: ['civil', 'infrastructure'],
  },
  {
    title: 'Documentation is effectively nonexistent',
    body: 'There is no real reference for the API and the examples are out of date. We reverse-engineered the payloads from network traffic, which is not a great look.',
    sentiment: 'critical',
    tags: ['api', 'docs'],
  },
  {
    title: 'Hidden limits we hit fast',
    body: 'Undocumented record caps throttled our larger projects with no warning. By the time we understood the limits we had already committed the workflow.',
    sentiment: 'critical',
    tags: ['data', 'erp', 'project-management'],
  },
  {
    title: 'Expected more for the price',
    body: 'At this tier the reliability should be far better. Between the stalls and the manual fixes, we are actively evaluating alternatives to {product}.',
    sentiment: 'critical',
    tags: ['accounting', 'finance', 'erp'],
  },
];
