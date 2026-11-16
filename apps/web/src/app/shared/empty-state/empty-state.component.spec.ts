import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { EmptyState } from './empty-state';

@Component({
  imports: [EmptyState],
  template: `<aec-empty-state class="max-w-prose"
    ><p>No products match these filters.</p></aec-empty-state
  >`,
})
class Host {}

describe('EmptyState (AECI-1793)', () => {
  it('projects the page words into a sunken panel at the card radius, with no dashed edge', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const panel = (fixture.nativeElement as HTMLElement).querySelector('aec-empty-state')!;
    expect(panel.textContent?.trim()).toBe('No products match these filters.');
    expect(panel.classList.contains('rounded-card')).toBe(true);
    expect(panel.classList.contains('bg-(--surface-sunken)')).toBe(true);
    expect(panel.className).not.toContain('border-dashed');
    expect(panel.className).not.toContain('text-center');
    // A caller's layout class is kept beside the shell's own.
    expect(panel.classList.contains('max-w-prose')).toBe(true);
  });
});
