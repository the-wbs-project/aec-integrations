import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { UnclaimedNote } from './unclaimed-note';

/** The wording is counsel's, word for word, and it stays plain text. */
describe('UnclaimedNote', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  it('renders the exact wording as plain muted text', () => {
    const fixture = TestBed.createComponent(UnclaimedNote);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent?.trim()).toBe(
      'Unclaimed · not affiliated with or endorsed by this vendor',
    );
    expect(el.children.length).toBe(0);
  });
});
