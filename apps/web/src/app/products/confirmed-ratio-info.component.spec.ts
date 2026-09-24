/**
 * ConfirmedRatioInfo render tests. Named `.component.spec.ts` so it runs under
 * `ng test` (TestBed). The popover body is projected into a CDK overlay on
 * `document.body`, so assertions click the trigger and query the document.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmedRatioInfo } from './confirmed-ratio-info';

function open(
  inputs: {
    context?: string | null;
    other?: string | null;
    singleSource?: boolean;
    aeciOnly?: boolean;
  } = {},
): { host: HTMLElement; popoverText: string } {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ConfirmedRatioInfo);
  fixture.componentRef.setInput('contextVendorName', inputs.context ?? null);
  fixture.componentRef.setInput('otherVendorName', inputs.other ?? null);
  fixture.componentRef.setInput('showSingleSource', inputs.singleSource ?? false);
  fixture.componentRef.setInput('aeciOnly', inputs.aeciOnly ?? false);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  host.querySelector('button')!.click();
  fixture.detectChanges();
  return { host, popoverText: document.body.textContent ?? '' };
}

describe('ConfirmedRatioInfo', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
  });

  it('labels the trigger for screen readers', () => {
    const { host } = open();
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe(
      'What confirmed by both vendors means',
    );
  });

  it('names both vendors and says the unit is a data object', () => {
    const { popoverText } = open({ context: 'Autodesk', other: 'Esri' });
    expect(popoverText).toContain(
      'A data object counts as confirmed once both Autodesk and Esri have signed off on it.',
    );
  });

  it('credits AECi research only while every attestation is AECi’s', () => {
    expect(open({ aeciOnly: true }).popoverText).toContain('AECi’s own research');
    TestBed.resetTestingModule();
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
    expect(open({ aeciOnly: false }).popoverText).not.toContain('AECi’s own research');
  });

  it('falls back to generic phrasing for a missing or shared vendor', () => {
    expect(open({ context: 'Autodesk', other: null }).popoverText).toContain(
      'once both vendors have signed off',
    );
    TestBed.resetTestingModule();
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
    const shared = open({ context: 'Autodesk', other: 'Autodesk' }).popoverText;
    expect(shared).toContain('once both vendors have signed off');
    expect(shared).not.toContain('Autodesk and Autodesk');
  });

  it('explains the one-vendor clause only when the ratio shows it', () => {
    expect(open().popoverText).not.toContain('Confirmed by one vendor only');
    TestBed.resetTestingModule();
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
    expect(open({ singleSource: true }).popoverText).toContain('Confirmed by one vendor only');
  });
});
