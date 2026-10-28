/**
 * A minimal in-memory `KVNamespace` for specs (AECI-1505). It covers the calls the
 * sitemap store makes: `get` as text, `getWithMetadata` as a stream, and `put` with
 * metadata. `failPut` makes the next puts reject, to exercise the swallow paths.
 * `times` limits how many reject; the default is every put from then on.
 */
export interface MemoryKv {
  kv: KVNamespace;
  store: Map<string, { value: string; metadata: unknown }>;
  failPut(error?: Error, times?: number): void;
}

export function memoryKv(): MemoryKv {
  const store = new Map<string, { value: string; metadata: unknown }>();
  let putError: Error | null = null;
  let failuresLeft = Infinity;

  const toStream = (value: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });

  const kv = {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async getWithMetadata(key: string, opts?: { type?: string }) {
      const hit = store.get(key);
      if (!hit) return { value: null, metadata: null };
      return {
        value: opts?.type === 'stream' ? toStream(hit.value) : hit.value,
        metadata: hit.metadata ?? null,
      };
    },
    async put(key: string, value: string, opts?: { metadata?: unknown }) {
      if (putError && failuresLeft > 0) {
        failuresLeft -= 1;
        throw putError;
      }
      store.set(key, { value, metadata: opts?.metadata ?? null });
    },
  };

  return {
    kv: kv as unknown as KVNamespace,
    store,
    failPut: (error = new Error('KV PUT failed: 429 Too Many Requests'), times = Infinity) => {
      putError = error;
      failuresLeft = times;
    },
  };
}
