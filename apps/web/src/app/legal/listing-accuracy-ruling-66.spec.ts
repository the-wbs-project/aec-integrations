/**
 * AECI-2192 — the Listing Accuracy Policy and its mirrors say what ruling 66 says
 * (after counsel's Q73 and Q74), and no longer say what it replaced.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CONTENT = join(process.cwd(), 'src', 'content');
const read = (...parts: string[]) => readFileSync(join(CONTENT, ...parts), 'utf8');
const POLICY = read('legal', 'listing-accuracy-policy.md');
const USER_FACING = [
  POLICY,
  read('methodology.md'),
  read('docs', 'vendors', 'requesting-changes-and-appeals.md'),
  read('docs', 'vendors', 'connector-vendors.md'),
  read('docs', 'vendors', 'owning-an-integration.md'),
];

describe('ruling 66 in the Listing Accuracy Policy', () => {
  it('drops the replaced sentences', () => {
    expect(POLICY).not.toContain('We do not review a removal.');
    expect(POLICY).not.toContain('We may end a removal only where');
  });

  it("carries counsel's three disclosures", () => {
    expect(POLICY).toContain('Whether we list something is at our discretion.');
    expect(POLICY).toContain('a listing gives no one a right to stay visible');
    expect(POLICY).toContain('may remove it from its product, even when the listing is accurate');
    expect(POLICY).toContain(
      'We do not guarantee that an integration a third company delivers stays listed.',
    );
  });

  it('states the removal, the notice, the grounds and the exception', () => {
    expect(POLICY).toContain('It must choose its reason from a fixed list');
    expect(POLICY).toContain('we record the reason and the time');
    expect(POLICY).toContain('The Sync Service is told at once, with the vendor');
    expect(POLICY).toContain('The public site shows nothing about a removal');
    expect(POLICY).toContain('on three grounds only');
    expect(POLICY).toContain("the vendor's own public materials show that it supports");
    expect(POLICY).toContain("where the vendor's claim to that product ends or is suspended");
    expect(POLICY).toContain('We tell both vendors why.');
    expect(POLICY).toMatch(
      /remove an accurate listing simply because a vendor asks us to\.\*\*[^\n]*The one exception is an integration a Sync Service delivers/,
    );
  });

  it('keeps the sentences the ruling did not change', () => {
    expect(POLICY).toContain('The Sync Service cannot restore the integration or add it again.');
    expect(POLICY).toContain('it returns only when both have withdrawn');
    expect(POLICY).toContain('within five business days');
  });

  it("carries the legal agent's read of the final text (2026-11-26)", () => {
    expect(POLICY).toContain('has three rights, sent from its vendor account:');
    expect(POLICY).toContain(
      'Our view is advice, and the Sync Service decides the listing of that data flow.',
    );
    expect(POLICY).toContain(
      'On an integration the Sync Service has claimed, the Sync Service maintains its data flows and we cannot change one. So we take the integration off the public site.',
    );
    expect(POLICY).toContain(
      'If we do not agree with an objection, we tell the Sync Service why. We answer an objection within five business days of receiving it.',
    );
    expect(POLICY).toContain('Business days are Monday to Friday, excluding US federal holidays.');
  });

  it('no user-facing page keeps a replaced sentence or a dropped reason', () => {
    for (const text of USER_FACING) {
      expect(text).not.toContain('three more rights');
      expect(text).not.toContain('It is not offered for our product');
      expect(text).not.toContain('ended our relationship');
      expect(text).not.toMatch(/decides the listing\./);
      expect(text).not.toContain('we do that by taking the integration off');
    }
    for (const text of USER_FACING.slice(1)) {
      expect(text).toContain('within five business days of receiving it');
    }
  });

  it('no user-facing page offers a neutrality disclaimer', () => {
    for (const text of USER_FACING) expect(text.toLowerCase()).not.toContain('neutral');
  });
});
