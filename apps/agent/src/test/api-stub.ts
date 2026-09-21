/**
 * A stub `Fetcher` for the `API` service binding, plus a body-release probe.
 *
 * AECI-666's failure is invisible from the outside: an unread body holds a
 * connection, and past the limit the runtime cancels the response and the
 * fetch promise NEVER settles, so nothing throws and nothing is logged. The
 * only way to assert the fix is to watch whether the stream was cancelled, which
 * is what `cancelled` records here.
 */
export type ApiStub = {
  fetcher: { fetch: (request: Request) => Promise<Response> };
  /** Paths requested, in order. */
  calls: string[];
  /** True once the response body stream was cancelled (or fully read). */
  cancelled: () => boolean;
};

export function makeApiStub(handler: (path: string) => { status: number; body: unknown }): ApiStub {
  const calls: string[] = [];
  let cancelled = false;

  return {
    calls,
    cancelled: () => cancelled,
    fetcher: {
      fetch: async (request: Request) => {
        const url = new URL(request.url);
        calls.push(url.pathname);
        const { status, body } = handler(url.pathname);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
            controller.close();
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, {
          status,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  };
}
