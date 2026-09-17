import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorBulletListEditor, newBullet, type BulletDraft } from './vendor-bullet-list-editor';

/**
 * `VendorBulletListEditor` (AECI-994): add at the bottom, remove any row, reorder
 * with buttons. Driven through a host that owns the array, because the editor is
 * stateless and every behaviour is "emit the right array".
 */
@Component({
  selector: 'aec-test-bullets-host',
  imports: [VendorBulletListEditor],
  template: `
    <form (submit)="submitted.set(true); $event.preventDefault()">
      <aec-vendor-bullet-list-editor
        label="How Architects use it"
        idPrefix="t"
        [bullets]="bullets()"
        [maxBullets]="3"
        [maxLength]="20"
        [disabled]="disabled()"
        (bulletsChange)="bullets.set($event)"
      />
    </form>
  `,
})
class Host {
  readonly bullets = signal<readonly BulletDraft[]>([newBullet('one'), newBullet('two')]);
  readonly disabled = signal(false);
  readonly submitted = signal(false);
}

describe('VendorBulletListEditor', () => {
  let announce: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    announce = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: VendorPortalAnnouncer, useValue: { announce } },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function create(): ComponentFixture<Host> {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    return fixture;
  }

  const texts = (f: ComponentFixture<Host>) => f.componentInstance.bullets().map((b) => b.text);
  const inputs = (f: ComponentFixture<Host>) =>
    Array.from(f.nativeElement.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
  const button = (f: ComponentFixture<Host>, label: string) =>
    f.nativeElement.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  const settle = async (f: ComponentFixture<Host>) => {
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
  };

  it('names every control by list and position', () => {
    const f = create();
    const labels = Array.from(f.nativeElement.querySelectorAll('label.sr-only')).map((l) =>
      (l as HTMLElement).textContent?.trim(),
    );
    expect(labels).toEqual(['How Architects use it, point 1', 'How Architects use it, point 2']);
    expect(button(f, 'Move point 1 up').disabled).toBe(true);
    expect(button(f, 'Move point 2 down').disabled).toBe(true);
  });

  it('adds a point at the bottom and focuses it', async () => {
    const f = create();
    (f.nativeElement.querySelector('[data-action="add"]') as HTMLButtonElement).click();
    await settle(f);

    expect(texts(f)).toEqual(['one', 'two', '']);
    expect(document.activeElement).toBe(inputs(f)[2]);
  });

  it('stops adding at the cap', async () => {
    const f = create();
    const add = () => f.nativeElement.querySelector('[data-action="add"]') as HTMLButtonElement;
    add().click();
    await settle(f);
    expect(add().disabled).toBe(true);
    expect(f.nativeElement.textContent).toContain('3 of 3 points');
  });

  it('removes any row, focuses its neighbour, and announces it', async () => {
    const f = create();
    button(f, 'Remove point 1').click();
    await settle(f);

    expect(texts(f)).toEqual(['two']);
    expect(document.activeElement).toBe(inputs(f)[0]);
    expect(announce).toHaveBeenCalledWith('Point 1 removed.');
  });

  it('moves a row and keeps focus on a usable control', async () => {
    const f = create();
    button(f, 'Move point 1 down').click();
    await settle(f);

    expect(texts(f)).toEqual(['two', 'one']);
    // The moved row is now last, so its "down" is disabled; focus goes to "up".
    expect(document.activeElement).toBe(button(f, 'Move point 2 up'));
    expect(announce).toHaveBeenCalledWith('Point moved to position 2 of 2.');
  });

  it('never lets Enter submit the form, and adds a row from the last one', async () => {
    const f = create();
    inputs(f)[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await settle(f);

    expect(f.componentInstance.submitted()).toBe(false);
    expect(texts(f)).toEqual(['one', 'two', '']);
  });

  it('flags a point over the length cap', () => {
    const f = create();
    const input = inputs(f)[0]!;
    input.value = 'x'.repeat(21);
    input.dispatchEvent(new Event('input'));
    f.detectChanges();

    expect(inputs(f)[0]!.getAttribute('aria-invalid')).toBe('true');
    expect(f.nativeElement.textContent).toContain('21 of 20 characters');
  });

  it('renders read-only with no controls when disabled', () => {
    const f = create();
    f.componentInstance.disabled.set(true);
    f.detectChanges();

    expect(inputs(f).every((i) => i.readOnly)).toBe(true);
    expect(f.nativeElement.querySelectorAll('button').length).toBe(0);
  });
});
