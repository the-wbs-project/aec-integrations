import { describe, expect, it } from 'vitest';
import {
  activationChanges,
  isTelemetryWrite,
  judgeOnInput,
  onInputEffect,
  pointerCancelVerdict,
  reducedMotionProblems,
  snapshotChanges,
  type ActivationState,
  type ControlFacts,
  type OnInputEntry,
  type PageSnapshot,
  type RecordedAnimation,
} from './interaction-rules';

// AECI-1882: the pure verdicts behind the interaction checks.

const state = (over: Partial<ActivationState> = {}): ActivationState => ({
  url: 'http://localhost/admin/reviews',
  doc: 'doc-1',
  writes: 0,
  popups: 0,
  states: ['a[0] aria-expanded=false'],
  ...over,
});

describe('isTelemetryWrite', () => {
  it('passes over the page-view beacon and PostHog', () => {
    expect(isTelemetryWrite('http://localhost:8790/api/page-views')).toBe(true);
    expect(isTelemetryWrite('http://localhost:8790/api/page-views/browser-evidence')).toBe(true);
    expect(isTelemetryWrite('https://us.i.posthog.com/e/')).toBe(true);
  });

  it('counts every other write', () => {
    expect(isTelemetryWrite('http://localhost:8790/api/admin/reviews/1')).toBe(false);
    expect(isTelemetryWrite('https://abc.supabase.co/auth/v1/logout')).toBe(false);
    expect(isTelemetryWrite('not a url')).toBe(false);
  });
});

describe('activationChanges', () => {
  it('finds nothing when nothing changed', () => {
    expect(activationChanges(state(), state())).toEqual([]);
  });

  it('names a new document rather than its URL', () => {
    expect(activationChanges(state(), state({ doc: 'doc-2', url: 'http://localhost/x' }))).toEqual([
      'a new document loaded',
    ]);
  });

  it('names a URL change, a write, a popup and a state flip', () => {
    const after = state({
      url: 'http://localhost/admin/requests',
      writes: 1,
      popups: 1,
      states: ['a[0] aria-expanded=true'],
    });
    expect(activationChanges(state(), after)).toEqual([
      'the URL changed to http://localhost/admin/requests',
      '1 write(s) were sent',
      'open popups went from 0 to 1',
      'state changed: was a[0] aria-expanded=false; now a[0] aria-expanded=true',
    ]);
  });
});

describe('pointerCancelVerdict', () => {
  const open = state({ states: ['a[0] aria-expanded=true'] });

  it('passes a press that changed nothing, with no second run', () => {
    expect(pointerCancelVerdict(state(), state(), null)).toEqual([]);
  });

  it('fails a press that changed the page when there is no hover run to compare', () => {
    expect(pointerCancelVerdict(state(), open, null)).toHaveLength(1);
  });

  it('passes a change the same pointer path makes with no press (opens on hover)', () => {
    expect(pointerCancelVerdict(state(), open, { before: state(), after: open })).toEqual([]);
  });

  it('fails what only the press added', () => {
    const pressed = state({ states: ['a[0] aria-expanded=true'], writes: 1 });
    expect(pointerCancelVerdict(state(), pressed, { before: state(), after: open })).toEqual([
      '1 write(s) were sent',
    ]);
  });
});

describe('onInputEffect', () => {
  const base = {
    beforeUrl: 'http://localhost/products',
    afterUrl: 'http://localhost/products',
    sameDocument: true,
    newWindows: 0,
    focusStayed: true,
  };

  it('is none when the page stays and focus stays on the control', () => {
    expect(onInputEffect(base)).toBe('none');
  });

  it('tells a query change from a new path', () => {
    expect(onInputEffect({ ...base, afterUrl: 'http://localhost/products?categories=x' })).toBe(
      'url-query',
    );
    expect(onInputEffect({ ...base, afterUrl: 'http://localhost/vendors' })).toBe('navigates');
  });

  it('reads a new document or window as the bigger change', () => {
    expect(onInputEffect({ ...base, sameDocument: false })).toBe('navigates');
    expect(onInputEffect({ ...base, newWindows: 1, sameDocument: false })).toBe('new-window');
  });

  it('reads focus leaving the control as a change of context', () => {
    expect(onInputEffect({ ...base, focusStayed: false })).toBe('focus-moved');
  });
});

describe('judgeOnInput', () => {
  const facet: ControlFacts = {
    host: 'aec-search-refinement-list',
    role: 'checkbox',
    tag: 'input',
    type: 'checkbox',
    name: 'Bid Management',
    inSharedChrome: false,
  };
  const email: ControlFacts = {
    ...facet,
    host: 'aec-mailing-list-signup',
    role: 'textbox',
    type: 'email',
    name: 'Email',
  };
  const entry: OnInputEntry = {
    id: 'facet-filters',
    surfaces: (id) => id === 'product-index',
    control: (c) => c.host === 'aec-search-refinement-list' && c.role === 'checkbox',
    effect: 'url-query',
    status: 'pending-ruling',
    does: 'filters the list and writes the filter to the URL',
    why: 'facet filters need Chris’s ruling',
  };

  it('passes a listed change and returns the entry it matched', () => {
    const out = judgeOnInput('product-index', [{ control: facet, effect: 'url-query' }], [entry]);
    expect(out).toEqual({ problems: [], matched: [entry] });
  });

  it('fails an unlisted change, and a listed control that changes in another way', () => {
    expect(
      judgeOnInput('product-index', [{ control: email, effect: 'navigates' }], [entry]).problems,
    ).toEqual([
      'aec-mailing-list-signup textbox "Email": changing it navigates and it is not listed',
    ]);
    expect(
      judgeOnInput('product-index', [{ control: facet, effect: 'navigates' }], [entry]).problems,
    ).toHaveLength(1);
  });

  it('applies an entry only on its own surfaces', () => {
    expect(
      judgeOnInput('vendor-index', [{ control: facet, effect: 'url-query' }], [entry]).problems,
    ).toHaveLength(1);
  });

  it('fails a listed control that no longer changes the page, so the list stays true', () => {
    expect(
      judgeOnInput('product-index', [{ control: facet, effect: 'none' }], [entry]).problems,
    ).toEqual(['facet-filters is listed but no longer changes the page here: remove it']);
  });

  it('fails a control the check could not change', () => {
    expect(
      judgeOnInput(
        'product-index',
        [{ control: email, effect: null, note: 'it left the page' }],
        [],
      ).problems,
    ).toEqual(['aec-mailing-list-signup textbox "Email": could not be changed (it left the page)']);
  });
});

describe('snapshotChanges', () => {
  const snap: PageSnapshot = {
    url: 'http://localhost/',
    title: 'Home',
    scroll: '0,0',
    focus: 'the page body',
    popups: 0,
    elements: 500,
    text: 'Home',
  };

  it('finds nothing when nothing changed', () => {
    expect(snapshotChanges(snap, snap, false)).toEqual([]);
  });

  it('names a moved focus and a scroll', () => {
    expect(
      snapshotChanges(snap, { ...snap, focus: 'input (key 3)', scroll: '0,400' }, false),
    ).toEqual([
      'the page scrolled from 0,0 to 0,400',
      'focus moved from the page body to input (key 3)',
    ]);
  });

  it('compares text only on a page that holds still by itself', () => {
    const changed = { ...snap, text: 'Home, 1 minute ago' };
    expect(snapshotChanges(snap, changed, false)).toEqual(['the text of the page changed']);
    expect(snapshotChanges(snap, changed, true)).toEqual([]);
  });
});

describe('reducedMotionProblems', () => {
  const anim = (over: Partial<RecordedAnimation>): RecordedAnimation => ({
    kind: 'CSSTransition',
    name: 'opacity',
    target: 'div',
    iterations: 1,
    duration: 0.01,
    activeDuration: 0.01,
    ...over,
  });

  it('passes motion the reduced-motion block has shortened', () => {
    expect(reducedMotionProblems([anim({})])).toEqual([]);
  });

  it('fails a long or endless motion, once per target and name', () => {
    const spin = anim({
      kind: 'CSSAnimation',
      name: 'spin',
      duration: 1000,
      activeDuration: Infinity,
      iterations: Infinity,
    });
    expect(
      reducedMotionProblems([spin, spin, anim({ activeDuration: 300, duration: 300 })]),
    ).toEqual([
      'CSSAnimation "spin" on div (endless, 1000ms a loop)',
      'CSSTransition "opacity" on div (300ms)',
    ]);
  });
});
