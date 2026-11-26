import { expect, test, type Page } from '@playwright/test';

// AECI-2088: a Tailwind border-colour utility applies. Until AECI-2088 the global
// `* { border-color }` rule in `styles.css` sat outside any cascade layer, so it beat
// every layered utility and both tabs below rendered `--border-default` grey. The
// source half is `src/border-color-layer.guard.spec.ts`; this is the rendered half,
// because the cascade decides the colour and only a browser resolves it.
//
// `/preview/vendor-detail` needs no session. Its tabs carry `border-transparent` and
// `aria-selected:border-(--accent-primary)`, both plain utilities with no unlayered
// class beside them.

const PATH = '/preview/vendor-detail';

async function resolveToken(page: Page, token: string): Promise<string> {
  return page.evaluate((t) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${t})`;
    document.body.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, token);
}

test('a border-colour utility beats the global border default (AECI-2088)', async ({ page }) => {
  const res = await page.goto(PATH);
  expect(res?.status(), `GET ${PATH} must return 200`).toBe(200);

  const selected = page.getByRole('tab', { name: 'Overview' });
  const other = page.getByRole('tab', { name: /Products/ });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(other).not.toHaveAttribute('aria-selected', 'true');

  const underline = (tab: typeof selected) =>
    tab.evaluate((el) => getComputedStyle(el).borderBottomColor);

  // `aria-selected:border-(--accent-primary)`: the selected tab's underline is Forest.
  expect(await underline(selected)).toBe(await resolveToken(page, '--accent-primary'));
  // `border-transparent`: the other tab draws no underline.
  expect(await underline(other)).toBe('rgba(0, 0, 0, 0)');
  // And neither is the default the old unlayered rule forced on both.
  const fallback = await resolveToken(page, '--border-default');
  expect(await underline(selected)).not.toBe(fallback);
  expect(await underline(other)).not.toBe(fallback);
});
