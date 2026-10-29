/**
 * An in-memory R2 bucket for specs (AECI-1228). It implements the three calls the
 * `page_views` archive makes, `put`, `head` and `get`, with R2's shapes: `put` and
 * `head` resolve an object with `size` and `customMetadata`, a missing key resolves
 * `null`. `get` adds `arrayBuffer()`, so a spec can gunzip what was written.
 *
 * `failPut` and `corruptHead` make one key misbehave, so a spec can check that a
 * refused or unconfirmed write records nothing.
 */

interface StoredObject {
  key: string;
  body: ArrayBuffer;
  customMetadata: Record<string, string>;
  httpMetadata: { contentType?: string };
}

export interface FakeR2Bucket {
  put(
    key: string,
    value: ArrayBuffer,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
      sha256?: string;
    },
  ): Promise<{ key: string; size: number; customMetadata: Record<string, string> } | null>;
  head(
    key: string,
  ): Promise<{ key: string; size: number; customMetadata: Record<string, string> } | null>;
  get(key: string): Promise<{
    key: string;
    size: number;
    customMetadata: Record<string, string>;
    httpMetadata: { contentType?: string };
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null>;
  /** Every stored key, sorted. */
  keys(): string[];
  /** Make `put` throw for keys matching `pattern`. */
  failPut(pattern: RegExp): void;
  /** Make `head` report a wrong size for keys matching `pattern`. */
  corruptHead(pattern: RegExp): void;
  /** Every `put` call's key, in order. */
  readonly puts: string[];
}

export function makeFakeR2Bucket(): FakeR2Bucket {
  const store = new Map<string, StoredObject>();
  const failing: RegExp[] = [];
  const corrupt: RegExp[] = [];
  const puts: string[] = [];

  const meta = (o: StoredObject) => ({
    key: o.key,
    size: o.body.byteLength,
    customMetadata: { ...o.customMetadata },
  });

  return {
    puts,
    async put(key, value, options) {
      puts.push(key);
      if (failing.some((p) => p.test(key))) throw new Error(`fake R2 put failed for ${key}`);
      const object: StoredObject = {
        key,
        body: value.slice(0),
        customMetadata: { ...(options?.customMetadata ?? {}) },
        httpMetadata: { ...(options?.httpMetadata ?? {}) },
      };
      store.set(key, object);
      return meta(object);
    },
    async head(key) {
      const object = store.get(key);
      if (!object) return null;
      const m = meta(object);
      return corrupt.some((p) => p.test(key)) ? { ...m, size: m.size + 1 } : m;
    },
    async get(key) {
      const object = store.get(key);
      if (!object) return null;
      return {
        ...meta(object),
        httpMetadata: { ...object.httpMetadata },
        arrayBuffer: async () => object.body.slice(0),
      };
    },
    // Binary order, like R2's own listing.
    keys: () => [...store.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    failPut: (pattern) => void failing.push(pattern),
    corruptHead: (pattern) => void corrupt.push(pattern),
  };
}
