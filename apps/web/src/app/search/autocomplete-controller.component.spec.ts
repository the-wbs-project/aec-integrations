import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutocompleteController } from './autocomplete-controller';
import type { AutocompleteResult, AutocompleteSuggestion } from './autocomplete-mapping';

function suggestion(title: string): AutocompleteSuggestion {
  return {
    kind: 'product',
    objectID: title,
    title,
    subtitle: null,
    routerLink: ['/products', title],
  };
}

function result(...titles: string[]): AutocompleteResult {
  return { products: titles.map(suggestion), vendors: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Flush pending microtasks (resolved promises) — fake timers don't cover these. */
const flush = () => Promise.resolve();

describe('AutocompleteController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('mirrors the query to the signal immediately, before the debounce', () => {
    const searchFn = vi.fn().mockResolvedValue(result());
    const controller = new AutocompleteController(searchFn);
    controller.setQuery('rev');
    expect(controller.query()).toBe('rev');
    expect(searchFn).not.toHaveBeenCalled();
  });

  it('debounces the network search by ~180ms', async () => {
    const searchFn = vi.fn().mockResolvedValue(result('Revit'));
    const controller = new AutocompleteController(searchFn);
    controller.setQuery('rev');
    expect(searchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(179);
    expect(searchFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(searchFn).toHaveBeenCalledExactlyOnceWith('rev');
    await flush();
    expect(controller.products().map((s) => s.title)).toEqual(['Revit']);
    expect(controller.hasSearched()).toBe(true);
    expect(controller.loading()).toBe(false);
  });

  it('coalesces rapid keystrokes into a single trailing search', () => {
    const searchFn = vi.fn().mockResolvedValue(result());
    const controller = new AutocompleteController(searchFn);
    controller.setQuery('r');
    vi.advanceTimersByTime(100);
    controller.setQuery('re');
    vi.advanceTimersByTime(100);
    controller.setQuery('rev');
    vi.advanceTimersByTime(180);
    expect(searchFn).toHaveBeenCalledExactlyOnceWith('rev');
  });

  it('does not search on a blank query and clears prior results', async () => {
    const searchFn = vi.fn().mockResolvedValue(result('Revit'));
    const controller = new AutocompleteController(searchFn);
    controller.setQuery('rev');
    vi.advanceTimersByTime(180);
    await flush();
    expect(controller.products()).toHaveLength(1);

    controller.setQuery('   ');
    vi.advanceTimersByTime(180);
    expect(searchFn).toHaveBeenCalledTimes(1); // no second call
    expect(controller.products()).toEqual([]);
    expect(controller.vendors()).toEqual([]);
    expect(controller.hasSearched()).toBe(false);
  });

  it('drops a stale response when a newer query has already fired', async () => {
    const first = deferred<AutocompleteResult>();
    const second = deferred<AutocompleteResult>();
    const searchFn = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const controller = new AutocompleteController(searchFn);

    controller.setQuery('a');
    vi.advanceTimersByTime(180); // runSearch('a') → seq 1
    controller.setQuery('ab');
    vi.advanceTimersByTime(180); // runSearch('ab') → seq 2

    second.resolve(result('B')); // newer settles first
    await flush();
    first.resolve(result('A')); // older settles late → must be ignored
    await flush();

    expect(controller.products().map((s) => s.title)).toEqual(['B']);
  });

  it('reports isEmpty only after a settled query returns nothing', async () => {
    const searchFn = vi.fn().mockResolvedValue(result());
    const controller = new AutocompleteController(searchFn);
    expect(controller.isEmpty()).toBe(false); // nothing searched yet
    controller.setQuery('zzz');
    vi.advanceTimersByTime(180);
    await flush();
    expect(controller.isEmpty()).toBe(true);
  });

  it('degrades cleanly when the search rejects (e.g. Algolia index missing)', async () => {
    const searchFn = vi.fn().mockRejectedValue(new Error('Index does not exist'));
    const controller = new AutocompleteController(searchFn);
    controller.setQuery('rev');
    vi.advanceTimersByTime(180);
    await flush();
    await flush(); // settle the rejected promise's catch
    expect(controller.products()).toEqual([]);
    expect(controller.vendors()).toEqual([]);
    expect(controller.loading()).toBe(false);
    expect(controller.hasSearched()).toBe(true); // settled → no stuck spinner
  });

  describe('autocomplete_searched telemetry (AECI-717)', () => {
    /** A clock that returns each value in turn: start, then end. */
    function clock(...times: number[]) {
      return vi.fn(() => times.shift() ?? 0);
    }

    it('emits ok with the client round-trip and a bucket from the TRUE nbHits', async () => {
      const searchFn = vi.fn().mockResolvedValue({ ...result('Revit'), nbHits: 42 });
      const onSearch = vi.fn();
      const controller = new AutocompleteController(searchFn, onSearch, clock(100, 137.6));
      controller.setQuery('rev');
      vi.advanceTimersByTime(180);
      await flush();
      // One suggestion shown, 42 total: the bucket follows the total.
      expect(onSearch).toHaveBeenCalledExactlyOnceWith({
        status: 'ok',
        duration_ms: 38,
        results_bucket: '21+',
        superseded: false,
      });
    });

    it('emits error with duration_ms 0 on reject', async () => {
      const searchFn = vi.fn().mockRejectedValue(new Error('boom'));
      const onSearch = vi.fn();
      const controller = new AutocompleteController(searchFn, onSearch, clock(100, 900));
      controller.setQuery('rev');
      vi.advanceTimersByTime(180);
      await flush();
      await flush();
      expect(onSearch).toHaveBeenCalledExactlyOnceWith({
        status: 'error',
        duration_ms: 0,
        results_bucket: 'none',
        superseded: false,
      });
    });

    it('still emits a superseded response, flagged, before the stale guard drops it', async () => {
      const first = deferred<AutocompleteResult>();
      const second = deferred<AutocompleteResult>();
      const searchFn = vi
        .fn()
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const onSearch = vi.fn();
      const controller = new AutocompleteController(searchFn, onSearch, () => 0);

      controller.setQuery('a');
      vi.advanceTimersByTime(180);
      controller.setQuery('ab');
      vi.advanceTimersByTime(180);

      second.resolve({ ...result('B'), nbHits: 1 });
      await flush();
      first.resolve({ ...result('A'), nbHits: 3 });
      await flush();

      expect(onSearch.mock.calls.map((c) => c[0].superseded)).toEqual([false, true]);
      expect(controller.products().map((s) => s.title)).toEqual(['B']);
    });

    it('emits once per settled round-trip: nothing for debounced keystrokes or a blank query', async () => {
      const searchFn = vi.fn().mockResolvedValue(result());
      const onSearch = vi.fn();
      const controller = new AutocompleteController(searchFn, onSearch, () => 0);
      controller.setQuery('r');
      vi.advanceTimersByTime(100);
      controller.setQuery('re');
      vi.advanceTimersByTime(180);
      await flush();
      controller.setQuery('  ');
      vi.advanceTimersByTime(180);
      await flush();
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(onSearch.mock.calls[0]![0].results_bucket).toBe('none'); // nbHits omitted → 0
    });

    it('a throwing emitter never breaks the suggestions', async () => {
      const searchFn = vi.fn().mockResolvedValue(result('Revit'));
      const onSearch = vi.fn(() => {
        throw new Error('analytics down');
      });
      const controller = new AutocompleteController(searchFn, onSearch, () => 0);
      controller.setQuery('rev');
      vi.advanceTimersByTime(180);
      await flush();
      expect(onSearch).toHaveBeenCalledTimes(1);
      expect(controller.products().map((s) => s.title)).toEqual(['Revit']);
      expect(controller.loading()).toBe(false);
    });
  });

  it('dispose() cancels a pending debounced search', () => {
    const searchFn = vi.fn().mockResolvedValue(result());
    const controller = new AutocompleteController(searchFn);
    controller.setQuery('rev');
    controller.dispose();
    vi.advanceTimersByTime(500);
    expect(searchFn).not.toHaveBeenCalled();
  });
});
