import { describe, expect, it } from 'vitest';
import {
  clipFindings,
  formatClip,
  formatOverlap,
  isRotated,
  overlapFindings,
  scrollsSideways,
  snippet,
  visibleRects,
  type Box,
  type ContainerFact,
  type TextFact,
  type TextFacts,
} from './magnify-geometry';

// AECI-1881: the clip detector's decisions, against the facts the probe reads
// from fixture pages. jsdom has no layout, so each fixture is written as the
// boxes Chromium gives for the HTML in its comment.

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});

function container(over: Partial<ContainerFact> & { box: Box }): ContainerFact {
  const width = over.box.right - over.box.left;
  const height = over.box.bottom - over.box.top;
  return {
    desc: '<div>',
    overflowX: 'hidden',
    overflowY: 'hidden',
    scrollWidth: width,
    clientWidth: width,
    scrollHeight: height,
    clientHeight: height,
    lineClamp: null,
    textOverflow: 'clip',
    ...over,
  };
}

function text(over: Partial<TextFact> & { rects: Box[] }): TextFact {
  return { text: 'Some words', el: '<p>', near: '', layer: 0, chain: [], ...over };
}

const facts = (texts: TextFact[], containers: ContainerFact[] = []): TextFacts => ({
  texts,
  containers,
});

describe('clipFindings', () => {
  // <div style="height:40px; overflow:hidden"><p>three lines of 20px</p></div>
  it('flags a line pushed out of a fixed-height box that hides its overflow', () => {
    const c = container({ box: box(0, 0, 200, 40), scrollHeight: 60 });
    const t = text({
      rects: [box(0, 0, 200, 20), box(0, 20, 200, 40), box(0, 40, 200, 60)],
      chain: [0],
    });
    expect(clipFindings(facts([t], [c]))).toEqual([
      { clip: 'hidden', axis: 'y', text: 'Some words', el: '<p>', near: '', container: '<div>' },
    ]);
  });

  // The same box with room for the text: scrollHeight equals clientHeight.
  it('passes text that fits', () => {
    const c = container({ box: box(0, 0, 200, 60) });
    const t = text({ rects: [box(0, 0, 200, 20), box(0, 20, 200, 40)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toEqual([]);
  });

  // <h3 class="leading-none overflow-hidden">: the content area pokes out by a
  // tenth of the line, and nothing is cut.
  it('passes a tight line whose content area pokes past the box by under a quarter', () => {
    const c = container({ box: box(0, 2, 200, 22), scrollHeight: 21 });
    const t = text({ rects: [box(0, 0, 200, 24)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toEqual([]);
  });

  // <p class="line-clamp-3">: four lines, the fourth is hidden.
  it('names a line clamp', () => {
    const c = container({ box: box(0, 0, 300, 60), scrollHeight: 80, lineClamp: '3' });
    const t = text({
      rects: [box(0, 0, 300, 20), box(0, 20, 300, 40), box(0, 40, 300, 60), box(0, 60, 120, 80)],
      chain: [0],
    });
    expect(clipFindings(facts([t], [c]))[0]?.clip).toBe('line-clamp');
  });

  // <span class="truncate" style="width:100px">A long product name</span>
  it('names an ellipsis cut on the inline axis', () => {
    const c = container({
      box: box(0, 0, 100, 20),
      scrollWidth: 180,
      textOverflow: 'ellipsis',
    });
    const t = text({ rects: [box(0, 0, 180, 20)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toMatchObject([{ clip: 'ellipsis', axis: 'x' }]);
  });

  // <div style="overflow:auto; height:40px">: a scroll container loses nothing.
  it('passes text that a scroll container lets the reader scroll to', () => {
    const c = container({
      box: box(0, 0, 200, 40),
      overflowX: 'auto',
      overflowY: 'auto',
      scrollHeight: 80,
    });
    const t = text({ rects: [box(0, 40, 200, 80)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toEqual([]);
  });

  // <span class="sr-only">Opens in a new tab</span>: a 1px box on purpose.
  it('passes visually hidden text', () => {
    const c = container({ box: box(0, 0, 1, 1), scrollWidth: 120, scrollHeight: 20 });
    const t = text({ rects: [box(0, 0, 120, 20)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toEqual([]);
  });

  // <div style="overflow:clip; width:100px">: no scroll container, so no scroll sizes.
  it('flags overflow: clip from the line boxes alone', () => {
    const c = container({ box: box(0, 0, 100, 20), overflowX: 'clip', overflowY: 'clip' });
    const t = text({ rects: [box(0, 0, 160, 20)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toMatchObject([{ clip: 'hidden', axis: 'x' }]);
  });

  // <div style="overflow:hidden"><div style="overflow-x:auto">chips…</div></div>:
  // the far chip is reachable by scrolling the inner row, so the outer box does not cut it.
  it('passes text past a scroll container that an outer box also hides', () => {
    const strip = container({
      box: box(0, 0, 300, 30),
      overflowX: 'auto',
      overflowY: 'hidden',
      scrollWidth: 600,
    });
    const card = container({ box: box(0, 0, 320, 200), scrollWidth: 600 });
    const t = text({ rects: [box(400, 5, 480, 25)], chain: [0, 1] });
    expect(clipFindings(facts([t], [strip, card]))).toEqual([]);
  });

  // An image past the edge makes the box overflow, but the text inside fits.
  it('passes text that fits in a box another child overflows', () => {
    const c = container({ box: box(0, 0, 200, 40), scrollHeight: 90 });
    const t = text({ rects: [box(0, 0, 200, 20)], chain: [0] });
    expect(clipFindings(facts([t], [c]))).toEqual([]);
  });
});

describe('overlapFindings', () => {
  // <div style="height:20px"><p>two lines</p></div><p>next</p>: the first
  // paragraph's second line spills over the next one.
  it('flags text painted over other text', () => {
    const a = text({ text: 'First paragraph', rects: [box(0, 0, 200, 20), box(0, 20, 200, 40)] });
    const b = text({ text: 'Next paragraph', el: '<h2>', rects: [box(0, 22, 200, 42)] });
    expect(overlapFindings(facts([a, b]))).toEqual([
      {
        a: { text: 'First paragraph', el: '<p>' },
        b: { text: 'Next paragraph', el: '<h2>' },
        near: '',
      },
    ]);
  });

  // "Hello <b>world</b>": two text nodes side by side on one line.
  it('passes two text nodes that touch on one line', () => {
    const a = text({ text: 'Hello', rects: [box(0, 0, 40.5, 20)] });
    const b = text({ text: 'world', el: '<b>', rects: [box(40, 0, 80, 20)] });
    expect(overlapFindings(facts([a, b]))).toEqual([]);
  });

  // A heading at line-height 1 over a paragraph: the content areas meet by a few px.
  it('passes lines whose content areas meet by less than the threshold', () => {
    const a = text({ text: 'Heading', el: '<h2>', rects: [box(0, 0, 200, 30)] });
    const b = text({ text: 'Body', rects: [box(0, 26, 200, 46)] });
    expect(overlapFindings(facts([a, b]))).toEqual([]);
  });

  // The consent banner is fixed over the page on purpose.
  it('does not compare text in a fixed layer with the page under it', () => {
    const a = text({ text: 'Page', rects: [box(0, 600, 300, 620)] });
    const b = text({ text: 'Banner', layer: 1, rects: [box(0, 600, 300, 620)] });
    expect(overlapFindings(facts([a, b]))).toEqual([]);
  });

  // A chip row that scrolls sideways: the chip past the edge is not painted.
  it('compares only the part of a line its scroll container shows', () => {
    const strip = container({
      box: box(0, 0, 300, 30),
      overflowX: 'auto',
      overflowY: 'hidden',
      scrollWidth: 600,
    });
    const hidden = text({ text: 'Far chip', rects: [box(400, 5, 480, 25)], chain: [0] });
    const beside = text({ text: 'Beside', rects: [box(400, 5, 480, 25)] });
    expect(visibleRects(hidden, [strip])).toEqual([]);
    expect(overlapFindings(facts([hidden, beside], [strip]))).toEqual([]);
  });

  it('reports a pair once, however many of their lines cross', () => {
    const a = text({ text: 'A', rects: [box(0, 0, 100, 20), box(0, 20, 100, 40)] });
    const b = text({ text: 'B', rects: [box(0, 0, 100, 20), box(0, 20, 100, 40)] });
    expect(overlapFindings(facts([a, b]))).toHaveLength(1);
  });
});

describe('scrollsSideways', () => {
  it('allows one pixel of rounding', () => {
    expect(scrollsSideways({ scrollWidth: 321, clientWidth: 320 })).toBe(false);
    expect(scrollsSideways({ scrollWidth: 322, clientWidth: 320 })).toBe(true);
  });

  // PR #1321: on Linux the root's scrollWidth leaves out the scrollbar gutter.
  it('passes a root narrower than its client box', () => {
    expect(scrollsSideways({ scrollWidth: 305, clientWidth: 320 })).toBe(false);
  });
});

describe('isRotated', () => {
  it('reads no rotation from none or a plain translate', () => {
    expect(isRotated('none', 'none')).toBe(false);
    expect(isRotated('matrix(1, 0, 0, 1, 20, 0)', 'none')).toBe(false);
    expect(isRotated('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)', 'none')).toBe(
      false,
    );
  });

  it('reads a quarter turn from transform, from matrix3d and from rotate', () => {
    expect(isRotated('matrix(0, 1, -1, 0, 0, 0)', 'none')).toBe(true);
    expect(isRotated('matrix3d(0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)', 'none')).toBe(
      true,
    );
    expect(isRotated('none', '90deg')).toBe(true);
    expect(isRotated('none', '0deg')).toBe(false);
  });
});

describe('problem strings', () => {
  it('mask digits and cut long text, so the seed does not change them', () => {
    expect(snippet('Showing 12 of 340   results')).toBe('Showing ## of ### results');
    expect(snippet('x'.repeat(60))).toHaveLength(48);
  });

  it('name the text, its element, the container and the nearest test id', () => {
    expect(
      formatClip({
        clip: 'line-clamp',
        axis: 'y',
        text: 'A description',
        el: '<p>',
        near: '[data-testid="term-card"]',
        container: '<p>',
      }),
    ).toBe('clipped (line-clamp) "A description" in <p> by <p> near [data-testid="term-card"]');
    expect(
      formatOverlap({ a: { text: 'A', el: '<p>' }, b: { text: 'B', el: '<h2>' }, near: '' }),
    ).toBe('"A" in <p> overlaps "B" in <h2>');
  });
});
