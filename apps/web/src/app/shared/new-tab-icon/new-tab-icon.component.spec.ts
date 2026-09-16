/**
 * AECI-980 — `NewTabIcon`, the one new-tab cue.
 *
 * Everything here fails SILENTLY if it regresses, which is why it is pinned. A
 * missing SVG still renders a working link; what it costs is the sighted
 * reader's warning that their tab is about to be left behind. A missing
 * `aria-hidden` still renders; what it costs is a screen reader announcing a
 * decorative glyph. And a missing `sr-only` note still renders; what it costs is
 * the disclosure itself. None of the three shows up in a visual review, and axe
 * reports none of them.
 */
import { Component, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { NewTabIcon } from './new-tab-icon';

@Component({
  selector: 'aec-new-tab-icon-host',
  imports: [NewTabIcon],
  template: `
    <a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">
      <span>Visit website</span>
      <aec-new-tab-icon [announce]="announce" />
    </a>
  `,
})
class Host {
  announce = true;
}

async function create(announce = true) {
  const fixture: ComponentFixture<Host> = TestBed.createComponent(Host);
  fixture.componentInstance.announce = announce;
  fixture.detectChanges();
  return fixture;
}

const anchor = (fixture: ComponentFixture<Host>) =>
  (fixture.nativeElement as HTMLElement).querySelector('a') as HTMLAnchorElement;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
});

describe('NewTabIcon', () => {
  it('draws the cue for a sighted reader', async () => {
    const svg = anchor(await create()).querySelector('svg');

    expect(svg).not.toBeNull();
    // Two paths: the corner and the diagonal of Lucide's arrow-up-right.
    expect(svg?.querySelectorAll('path')).toHaveLength(2);
  });

  it('hides the glyph from assistive tech', async () => {
    const svg = anchor(await create()).querySelector('svg');

    // The note below is the accessible half. A named glyph beside it would be
    // announced twice.
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('mirrors the glyph in RTL', async () => {
    const svg = anchor(await create()).querySelector('svg');

    // The cue points away from the start of the line, which flips with the
    // writing direction. Without this it points back into the text.
    expect(svg?.getAttribute('class')).toContain('rtl:-scale-x-100');
  });

  it('announces the new tab from INSIDE the anchor', async () => {
    const link = anchor(await create());
    const note = link.querySelector('.sr-only');

    expect(note?.textContent?.trim()).toBe('(opens in a new tab)');
    // Inside, not beside. A sibling span is not read in a VoiceOver rotor or an
    // NVDA+F7 links list, so a disclosure parked outside the anchor reaches only
    // browse mode. Inside, it is part of the accessible name.
    expect(link.contains(note)).toBe(true);
  });

  it('suppresses the note on request', async () => {
    const link = anchor(await create(false));

    // For the rare anchor whose own visible text already says "new window". NOT
    // for silencing it under a caller-supplied aria-label, which replaces the
    // anchor's contents and so suppresses the note without any help.
    expect(link.querySelector('.sr-only')).toBeNull();
    expect(link.querySelector('svg')).not.toBeNull();
  });
});
