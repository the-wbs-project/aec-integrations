/**
 * AECI-1877: which surface checks the site header's popups, per persona.
 */
import { SURFACES, type A11ySurface } from '../surfaces';

/**
 * The surface that checks the site header's popups for a persona.
 *
 * The site header is one component on every page, and its popups (search, the
 * Browse menu, the account menu) differ only by who is signed in. So they are
 * checked once per persona: on the first surface of that persona, in manifest
 * order, that this run can reach. A `phase2` surface is passed over when the
 * fixtures are absent, so the check falls through to the next surface. A
 * missing session skips every surface of the persona, which the skip count
 * shows. Pure, so the plain Vitest runner pins it.
 */
export function headerOwnerFor(
  persona: A11ySurface['persona'],
  fixturesPresent: boolean,
  surfaces: readonly A11ySurface[] = SURFACES,
): string | null {
  const owner = surfaces.find(
    (s) => s.persona === persona && (s.fixture !== 'phase2' || fixturesPresent),
  );
  return owner?.id ?? null;
}
