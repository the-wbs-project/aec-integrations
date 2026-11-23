import { afterEach, describe, expect, it } from 'vitest';

import { focusIsLost } from './focus-is-lost';

describe('focusIsLost (AECI-1839)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('treats <body> as lost', () => {
    expect(focusIsLost(document)).toBe(true);
  });

  it('treats the focusable <main id="main"> as lost, so a blank click does not block the restore', () => {
    const main = document.createElement('main');
    main.id = 'main';
    main.tabIndex = -1;
    document.body.appendChild(main);
    main.focus();
    expect(document.activeElement).toBe(main);
    expect(focusIsLost(document)).toBe(true);
  });

  it('does not treat a control the vendor moved to as lost', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    expect(focusIsLost(document)).toBe(false);
  });
});
