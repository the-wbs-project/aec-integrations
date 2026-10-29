import { describe, expect, it } from 'vitest';

import { buildManagedPlanJsonLd } from './managed-plan-json-ld';

describe('buildManagedPlanJsonLd', () => {
  const input = {
    canonical: 'https://www.aecintegrations.com/vendor-program?utm_source=linkedin',
    siteName: 'AEC Integrations',
    name: 'Managed plan',
    description: 'A paid license on one product.',
    monthlyName: 'Managed, monthly',
    annualName: 'Managed, yearly',
    unitText: 'product',
    monthlyCents: 2500,
    annualCents: 25000,
  };

  it('is a Service with one per-product Offer per billing interval', () => {
    const ld = buildManagedPlanJsonLd(input);
    expect(ld['@type']).toBe('Service');
    expect(ld['@id']).toBe('https://www.aecintegrations.com/vendor-program#managed-plan');
    expect(ld.url).toBe('https://www.aecintegrations.com/vendor-program');
    expect(ld.provider).toEqual({
      '@type': 'Organization',
      name: 'AEC Integrations',
      url: 'https://www.aecintegrations.com/',
    });
    expect(ld.offers).toEqual([
      {
        '@type': 'Offer',
        name: 'Managed, monthly',
        price: '25.00',
        priceCurrency: 'USD',
        url: 'https://www.aecintegrations.com/vendor-program',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '25.00',
          priceCurrency: 'USD',
          billingDuration: 'P1M',
          referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitText: 'product' },
        },
      },
      {
        '@type': 'Offer',
        name: 'Managed, yearly',
        price: '250.00',
        priceCurrency: 'USD',
        url: 'https://www.aecintegrations.com/vendor-program',
        priceSpecification: {
          '@type': 'UnitPriceSpecification',
          price: '250.00',
          priceCurrency: 'USD',
          billingDuration: 'P1Y',
          referenceQuantity: { '@type': 'QuantitativeValue', value: 1, unitText: 'product' },
        },
      },
    ]);
  });

  it('follows the price it is given', () => {
    const ld = buildManagedPlanJsonLd({ ...input, monthlyCents: 3050, annualCents: 30000 });
    expect(ld.offers.map((o) => o.price)).toEqual(['30.50', '300.00']);
  });
});
