/**
 * In-memory R2 bucket stub for the reindex specs.
 *
 * It exists to answer ONE question the reindex route cannot otherwise be asked:
 * did the fan-out actually stay inside the Worker connection budget (AECI-666)?
 * Asserting that `mapWithConcurrency` was *called* proves nothing — the defect
 * class is an unbounded `Promise.all`, which also calls the right function names
 * right up until it opens two hundred connections at once. So `put()` here
 * records the PEAK number of overlapping in-flight calls, and the spec asserts
 * that number.
 *
 * `put()` is deliberately asynchronous (it yields before resolving). A stub that
 * resolved synchronously would show a peak of 1 whatever the caller did, and the
 * test would pass over the bug.
 */

export type R2Stub = {
  /** The stub, typed as `R2Bucket` for the engine under test. */
  bucket: R2Bucket;
  /** Stored objects, by key. */
  objects: Map<
    string,
    { body: string; customMetadata?: Record<string, string>; contentType?: string }
  >;
  /** Highest number of `put()` calls in flight simultaneously. */
  peakInFlight: () => number;
  /** Keys passed to `delete()`, flattened, in call order. */
  deleted: string[];
  /** Make the next `put()` for this key reject. */
  failOn: (key: string, message: string) => void;
};

export function makeR2Stub(): R2Stub {
  const objects = new Map<
    string,
    { body: string; customMetadata?: Record<string, string>; contentType?: string }
  >();
  const deleted: string[] = [];
  const failures = new Map<string, string>();
  let inFlight = 0;
  let peak = 0;

  const bucket = {
    async put(
      key: string,
      body: string,
      options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        // Yield twice, so overlapping callers are genuinely concurrent across
        // microtask boundaries rather than merely interleaved once.
        await Promise.resolve();
        await Promise.resolve();
        const failure = failures.get(key);
        if (failure) throw new Error(failure);
        objects.set(key, {
          body,
          customMetadata: options?.customMetadata,
          contentType: options?.httpMetadata?.contentType,
        });
        return { key };
      } finally {
        inFlight -= 1;
      }
    },

    async list(options?: { prefix?: string; cursor?: string }) {
      const prefix = options?.prefix ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      return { objects: keys.map((key) => ({ key })), truncated: false as const };
    },

    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        deleted.push(key);
        objects.delete(key);
      }
    },
  };

  return {
    bucket: bucket as unknown as R2Bucket,
    objects,
    peakInFlight: () => peak,
    deleted,
    failOn: (key, message) => failures.set(key, message),
  };
}
