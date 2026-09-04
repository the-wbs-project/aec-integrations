import { describe, expect, it } from 'vitest';

import { readerFacingNote } from './drizzle-helpers';

/**
 * AECI-779. The rule itself lives here; that it is actually WIRED at both reader
 * mappers is pinned by the route tests, because the two payloads come from
 * different routes:
 *
 * - `routes/product-pair.spec.ts` — the provenance popover (`toPairClaimAttestation`)
 * - `routes/pair-timeline.spec.ts` — the History section (`toClaimTimelineEntry`)
 *
 * Both are needed. A suppression applied to one mapper leaves the note published
 * on the other surface.
 */
describe('readerFacingNote — AECi seed notes are curation-internal (AECI-779)', () => {
  it('drops the note on an AECi-seeded attestation', () => {
    expect(
      readerFacingNote(
        'aeci',
        'ai_seed: Zapier Pipedrive↔Procore connector — edge marked bidirectional',
      ),
    ).toBeNull();
  });

  it('keeps a vendor-authored note in BOTH slots — the deliberate §6 authoring field', () => {
    expect(readerFacingNote('vendor_a', 'Only RFIs created after 2025.')).toBe(
      'Only RFIs created after 2025.',
    );
    expect(readerFacingNote('vendor_b', 'We do not expose RFIs here.')).toBe(
      'We do not expose RFIs here.',
    );
  });

  it('returns null — not undefined — for an absent note, so the wire shape is one spelling', () => {
    // `note` is `.nullable()` on both reader schemas, never `.optional()`: a
    // suppressed note must serialise exactly like an attestation that has none.
    expect(readerFacingNote('aeci', null)).toBeNull();
    expect(readerFacingNote('vendor_a', null)).toBeNull();
  });

  it('suppresses an EMPTY-STRING AECi note too — the gate is the source, not the content', () => {
    expect(readerFacingNote('aeci', '')).toBeNull();
    // ...and never inspects vendor text: no marker regex, no length rule.
    expect(
      readerFacingNote('vendor_a', 'ai_seed: looks internal but is the vendor’s own words'),
    ).toBe('ai_seed: looks internal but is the vendor’s own words');
  });
});
