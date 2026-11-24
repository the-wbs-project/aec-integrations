import { describe, expect, it } from 'vitest';
import { classifyProblems } from './known-barriers';

// AECI-1879: a known barrier covers only the problems it matches. A new problem
// on the same page, and a known issue that stopped reproducing, both surface.

const about = { issue: 'AECI-2077' as const, matches: (p: string) => p.startsWith('"About"') };

describe('classifyProblems', () => {
  it('finds nothing to report when every problem is known and every issue reproduces', () => {
    expect(classifyProblems(['"About" links to /about and /p#about'], [about])).toEqual({
      unknown: [],
      fixed: [],
    });
  });

  it('reports a problem no known issue matches, even beside a known one', () => {
    const problems = ['"About" links to /about and /p#about', '"Source" links to /a and /b'];
    expect(classifyProblems(problems, [about]).unknown).toEqual(['"Source" links to /a and /b']);
  });

  it('reports a known issue that matches nothing, so its mark comes off', () => {
    expect(classifyProblems([], [about]).fixed).toEqual(['AECI-2077']);
  });

  it('with no known issues, every problem is unknown', () => {
    expect(classifyProblems(['x'], [])).toEqual({ unknown: ['x'], fixed: [] });
  });
});
