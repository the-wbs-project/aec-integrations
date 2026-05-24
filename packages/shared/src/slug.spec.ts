import { describe, expect, it } from 'vitest';

import { DEFAULT_RESERVED_SLUGS, SlugReservedError, disambiguateSlug, slugify } from './slug';

describe('slugify', () => {
  describe('ASCII folding', () => {
    it('folds combining diacritics', () => {
      expect(slugify('Procoré')).toBe('procore');
      expect(slugify('Müller')).toBe('muller');
      expect(slugify('Æthelstan')).toBe('aethelstan');
      expect(slugify('Café Crème')).toBe('cafe-creme');
    });

    it('folds Latin compounds that NFKD leaves alone', () => {
      expect(slugify('Bjørn')).toBe('bjorn');
      expect(slugify('Straße')).toBe('strasse');
      expect(slugify('Łukasz')).toBe('lukasz');
    });
  });

  describe('run collapse and trim', () => {
    it('collapses whitespace and punctuation runs to a single hyphen', () => {
      expect(slugify('  Hello   World!! ')).toBe('hello-world');
      expect(slugify('Foo___Bar/Baz')).toBe('foo-bar-baz');
    });

    it('strips leading and trailing hyphens', () => {
      expect(slugify('---hello---')).toBe('hello');
      expect(slugify('!!hello!!')).toBe('hello');
    });
  });

  describe('idempotence', () => {
    it('leaves an already-valid slug unchanged', () => {
      expect(slugify('procore')).toBe('procore');
      expect(slugify('autodesk-build')).toBe('autodesk-build');
    });

    it('is idempotent — slugify(slugify(x)) === slugify(x)', () => {
      for (const input of ['Procoré', '  Hello World!! ', 'Bjørn 2.0']) {
        const once = slugify(input);
        expect(slugify(once)).toBe(once);
      }
    });
  });

  describe('empty input', () => {
    it('throws TypeError when the input collapses to nothing', () => {
      expect(() => slugify('!!!')).toThrow(TypeError);
      expect(() => slugify('   ')).toThrow(TypeError);
      expect(() => slugify('')).toThrow(TypeError);
    });
  });

  describe('reserved-word reject', () => {
    it('throws SlugReservedError for each default reserved slug', () => {
      for (const reserved of DEFAULT_RESERVED_SLUGS) {
        expect(() => slugify(reserved)).toThrow(SlugReservedError);
      }
    });

    it('throws when input slugifies to a reserved entry containing dots', () => {
      // `sitemap.xml` is reserved verbatim; both the literal and the
      // slug-shaped variant should be rejected.
      expect(() => slugify('sitemap.xml')).toThrow(SlugReservedError);
      expect(() => slugify('Sitemap XML')).toThrow(SlugReservedError);
    });

    it('attaches the offending slug and a stable code to the error', () => {
      try {
        slugify('Admin');
        expect.unreachable('expected slugify to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(SlugReservedError);
        const e = err as SlugReservedError;
        expect(e.code).toBe('SLUG_RESERVED');
        expect(e.slug).toBe('admin');
        expect(e.name).toBe('SlugReservedError');
      }
    });

    it('replaces the default reserved list when opts.reserved is provided', () => {
      // `admin` is no longer reserved in this caller's namespace.
      expect(slugify('admin', { reserved: ['other'] })).toBe('admin');
    });

    it('rejects custom reserved entries supplied by the caller', () => {
      expect(() => slugify('foo', { reserved: ['foo'] })).toThrow(SlugReservedError);
    });
  });
});

describe('disambiguateSlug', () => {
  it('returns the base slug when there is no collision', () => {
    expect(disambiguateSlug('procore', [])).toBe('procore');
    expect(disambiguateSlug('procore', ['autodesk', 'bluebeam'])).toBe('procore');
  });

  it('appends the vendor slug on a single collision', () => {
    expect(disambiguateSlug('build', ['build'], 'autodesk')).toBe('build-autodesk');
  });

  it('falls through to a numeric suffix when the vendor suffix is also taken', () => {
    expect(disambiguateSlug('build', ['build', 'build-autodesk'], 'autodesk')).toBe('build-2');
  });

  it('walks past existing numeric suffixes to find the first free slot', () => {
    expect(disambiguateSlug('build', ['build', 'build-autodesk', 'build-2'], 'autodesk')).toBe(
      'build-3',
    );
  });

  it('uses numeric suffixes directly when no vendorSlug is given', () => {
    expect(disambiguateSlug('build', ['build'])).toBe('build-2');
    expect(disambiguateSlug('build', ['build', 'build-2'])).toBe('build-3');
  });

  it('skips the vendor suffix when vendorSlug equals the base', () => {
    // Single-product vendor case: avoid `procore-procore`.
    expect(disambiguateSlug('procore', ['procore'], 'procore')).toBe('procore-2');
  });
});
