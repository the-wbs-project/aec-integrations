/**
 * AECI-1346 — `TrafficClassesCard`, the Overview's lead card.
 *
 * What is load-bearing, per D19:
 *   - four rows in D19(b) order, each with views, visitors and a day delta;
 *   - internal traffic on its own line, never as a fifth class;
 *   - an unclassified day shows "Not classified" and NO zeros;
 *   - a null delta reads "Not comparable" with its reason, never "No change";
 *   - the heuristic caveat sits with the human-evidence row.
 *
 * axe is not importable in this runner (only `@axe-core/playwright` is a
 * dependency), so the live axe pass runs against the rendered page. The
 * structural checks below cover what axe would catch in this markup.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AdminClassificationSummary } from '@aeci/shared';

import type { NotComparableReason } from './stat-tile';
import { TrafficClassesCard } from './traffic-classes-card';

function summary(over: Partial<AdminClassificationSummary> = {}): AdminClassificationSummary {
  return {
    classifier_version: 'tc-2026.10.2',
    counts: [
      {
        class: 'identified_automation',
        views: 9100,
        visitors: 310,
        delta_day: { current: 9100, prior: 8800, diff: 300, pct: 3 },
      },
      {
        class: 'suspected_automation',
        views: 780,
        visitors: 95,
        delta_day: { current: 780, prior: 800, diff: -20, pct: -3 },
      },
      {
        class: 'browser_with_human_evidence',
        views: 412,
        visitors: 140,
        delta_day: { current: 412, prior: 412, diff: 0, pct: 0 },
      },
      {
        class: 'unresolved',
        views: 1203,
        visitors: 402,
        delta_day: { current: 1203, prior: 0, diff: 1203, pct: null },
      },
    ],
    internal_excluded: { views: 37, operator_leak_inferred: 4 },
    basis: 'requests',
    version_seam: null,
    method_seams: [],
    ...over,
  };
}

function withNullDeltas(s: AdminClassificationSummary): AdminClassificationSummary {
  return { ...s, counts: s.counts.map((c) => ({ ...c, delta_day: null })) };
}

@Component({
  imports: [TrafficClassesCard],
  template: `<aec-traffic-classes-card
    [summary]="summary()"
    day="2026-10-21"
    [notComparable]="reason()"
  />`,
})
class Host {
  readonly summary = signal<AdminClassificationSummary>(summary());
  readonly reason = signal<NotComparableReason | undefined>(undefined);
}

async function render(s: AdminClassificationSummary, reason?: NotComparableReason) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.summary.set(s);
  fixture.componentInstance.reason.set(reason);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

function rowText(el: HTMLElement, cls: string): string {
  return el.querySelector(`[data-class="${cls}"]`)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('TrafficClassesCard', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the four classes in D19(b) order with views, visitors and the day delta', async () => {
    const el = await render(summary());
    const order = [...el.querySelectorAll('[data-class]')].map((n) => n.getAttribute('data-class'));
    expect(order).toEqual([
      'identified_automation',
      'suspected_automation',
      'browser_with_human_evidence',
      'unresolved',
    ]);
    expect(rowText(el, 'identified_automation')).toContain('Identified automation');
    expect(rowText(el, 'identified_automation')).toContain('9,100');
    expect(rowText(el, 'identified_automation')).toContain('Visitors: 310');
    expect(rowText(el, 'identified_automation')).toContain('+300 (+3%) vs 8800 the prior day');
    expect(rowText(el, 'suspected_automation')).toContain('−20 (−3%) vs 800 the prior day');
    expect(rowText(el, 'browser_with_human_evidence')).toContain('No change vs the prior day');
    // pct null: the percentage is omitted, as the digest does.
    expect(rowText(el, 'unresolved')).toContain('+1203 vs 0 the prior day');
  });

  it('names its basis and its classifier version before any figure', async () => {
    const el = await render(summary());
    expect(el.querySelector('[data-classifier-version]')?.textContent?.trim()).toBe(
      'Classifier tc-2026.10.2',
    );
    expect(el.textContent).toContain('Requests, not people');
    expect(el.textContent).toContain('UTC day 2026-10-21');
  });

  it('puts the heuristic caveat under the human-evidence row only', async () => {
    const el = await render(summary());
    const caveats = el.querySelectorAll('[data-heuristic]');
    expect(caveats).toHaveLength(1);
    expect(caveats[0]!.closest('[data-class]')?.getAttribute('data-class')).toBe(
      'browser_with_human_evidence',
    );
    expect(caveats[0]!.textContent).toContain('does not prove a person was there');
  });

  it('keeps internal traffic on its own line, outside the class list', async () => {
    const el = await render(summary());
    const internal = el.querySelector('[data-internal]')!;
    expect(internal).not.toBeNull();
    expect(internal.closest('dl')).toBeNull();
    expect(internal.textContent).toContain('never inside one: 37');
    expect(internal.textContent).toContain('lapsed session: 4');
  });

  it('shows "Not classified" and never zeros when the classifier did not run', async () => {
    const zeros = summary({
      classifier_version: null,
      counts: summary().counts.map((c) => ({ ...c, views: 0, visitors: 0, delta_day: null })),
      internal_excluded: { views: 0, operator_leak_inferred: 0 },
    });
    const el = await render(zeros);
    expect(el.querySelector('[data-classifier-version]')?.textContent?.trim()).toBe(
      'Not classified',
    );
    expect(el.querySelector('[data-not-classified]')).not.toBeNull();
    expect(el.querySelector('dl')).toBeNull();
    expect(el.querySelector('[data-internal]')).toBeNull();
    expect(el.textContent).not.toMatch(/\b0\b/);
  });

  it.each([
    ['classifier_changed', 'Not comparable with the prior day (classifier changed)'],
    ['method_changed', 'Not comparable with the prior day (collection method changed)'],
    ['prior_not_classified', 'Not comparable with the prior day (prior day not classified)'],
    [undefined, 'Not comparable with the prior day'],
  ] as const)('renders a null delta as not comparable (%s)', async (reason, text) => {
    const el = await render(withNullDeltas(summary()), reason);
    const deltas = [...el.querySelectorAll('[data-delta]')].map((d) => d.textContent?.trim());
    expect(deltas).toEqual([text, text, text, text]);
    expect(el.textContent).not.toContain('No change');
  });

  it('is one labelled region with an h3 and no deeper heading', async () => {
    const el = await render(summary());
    const region = el.querySelector('section[aria-labelledby]')!;
    const heading = el.querySelector(`#${region.getAttribute('aria-labelledby')}`)!;
    expect(heading.tagName).toBe('H3');
    expect(heading.textContent?.trim()).toBe('Traffic by class');
    expect(el.querySelector('h4, h5, h6')).toBeNull();
    // Swatches are decoration: the class name is the text.
    for (const swatch of el.querySelectorAll('dt span')) {
      expect(swatch.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
