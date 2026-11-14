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

  it('shows a Bone fill, Forest text and a Bone ring on focus, so it is visible over the Forest header', () => {
    const fixture = TestBed.createComponent(SkipLink);
    fixture.detectChanges();

    const classes = (fixture.nativeElement.querySelector('a') as HTMLElement).className;
    expect(classes).toContain('focus:bg-(--accent-warm)');
    expect(classes).toContain('focus:text-(--accent-primary)');
    expect(classes).toContain('focus:outline-(--focus-ring-on-brand)!');
    expect(classes).not.toContain('focus:bg-(--accent-primary)');
  });
});
