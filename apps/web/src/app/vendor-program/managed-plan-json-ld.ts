import { originOf, stripQueryParams } from '../core/meta.helpers';

/** One billing interval of a plan, as a `schema.org/Offer` nested in {@link PlanServiceLd}. */
export interface PlanOfferLd {
  '@type': 'Offer';
  name: string;
  price: string;
  priceCurrency: 'USD';
  url: string;
  priceSpecification: {
    '@type': 'UnitPriceSpecification';
    price: string;
    priceCurrency: 'USD';
    billingDuration: 'P1M' | 'P1Y';
    referenceQuantity: { '@type': 'QuantitativeValue'; value: 1; unitText: string };
  };
}

export interface PlanServiceLd {
  '@context': 'https://schema.org';
  '@type': 'Service';
  '@id': string;
  name: string;
  description: string;
  url: string;
  provider: { '@type': 'Organization'; name: string; url: string };
  offers: PlanOfferLd[];
}

/** US cents to the schema.org price string, e.g. `2500` to `"25.00"`. */
function ldPrice(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * Build the `schema.org/Service` JSON-LD for the Managed plan on `/vendor-program`
 * (AECI-1431, `VENDOR_PROGRAM_PAGE_SPEC.md` §2.3). One `Offer` per billing
 * interval, each priced per product through a `UnitPriceSpecification`.
 *
 * A `Service`, not a `Product`: Managed is a subscription to a hosted service, and
 * Google's product rich results expect a merchant listing with shipping and returns.
 * The prices come from the same constants the page copy reads, so the two cannot
 * drift (`docs/PRICING_RULES.md` §8). The founding discount is private, so it is
 * never published here.
 *
 * It lives in this lazy chunk, not in `core/meta.helpers.ts`, because the meta
 * helpers ship in the initial bundle and this builder only serves one page.
 */
export function buildManagedPlanJsonLd(input: {
  canonical: string;
  siteName: string;
  name: string;
  description: string;
  monthlyName: string;
  annualName: string;
  unitText: string;
  monthlyCents: number;
  annualCents: number;
}): PlanServiceLd {
  const canonical = stripQueryParams(input.canonical);
  const offer = (name: string, cents: number, billingDuration: 'P1M' | 'P1Y'): PlanOfferLd => ({
    '@type': 'Offer',
    name,
    price: ldPrice(cents),
    priceCurrency: 'USD',
    url: canonical,
    priceSpecification: {
      '@type': 'UnitPriceSpecification',
      price: ldPrice(cents),
      priceCurrency: 'USD',
      billingDuration,
      referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitText: input.unitText },
    },
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'Service',
    '@id': `${canonical}#managed-plan`,
    name: input.name,
    description: input.description,
    url: canonical,
    provider: { '@type': 'Organization', name: input.siteName, url: `${originOf(canonical)}/` },
    offers: [
      offer(input.monthlyName, input.monthlyCents, 'P1M'),
      offer(input.annualName, input.annualCents, 'P1Y'),
    ],
  };
}
