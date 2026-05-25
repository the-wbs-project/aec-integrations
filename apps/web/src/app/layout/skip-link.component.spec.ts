import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { SkipLink } from './skip-link';

describe('SkipLink (harness smoke)', () => {
  it('renders the skip-to-main anchor', () => {
    const fixture = TestBed.createComponent(SkipLink);
    fixture.detectChanges();

    const anchor = fixture.nativeElement.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe('#main');
  });
});
