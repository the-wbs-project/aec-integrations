/**
 * Tests for the dev-only error bench (AECI-643 / §6.5).
 *
 * The point of the bench is that the click handler throws SYNCHRONOUSLY from
 * inside an Angular event handler, which is the path Angular funnels into the
 * injected `ErrorHandler`. Asserting that here means the manual verification
 * only has to confirm the event reached PostHog, not that the button works.
 */
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { BENCH_ERROR_MESSAGE, ErrorBench } from './error-bench';

describe('ErrorBench', () => {
  it('carries a unique, greppable marker so a prod build can be proven clean', () => {
    // If this string ever changes, update the §6.5 verification grep.
    expect(BENCH_ERROR_MESSAGE).toContain('AECI_DEV_BENCH_THROW_9f4c2e1b');
  });

  it('throws the marker error from the click handler', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(ErrorBench);
    // `throwTestError` is `protected` (template-only); reach it structurally
    // rather than dispatching a real click, which jsdom re-raises past the
    // Angular ErrorHandler and fails the run with an unhandled error.
    const component = fixture.componentInstance as unknown as { throwTestError(): void };

    expect(() => component.throwTestError()).toThrowError(BENCH_ERROR_MESSAGE);
  });

  it('renders exactly one button, which is bound to that handler', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(ErrorBench);
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLElement>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0].textContent?.trim()).toBe('Throw a test error');
  });
});
