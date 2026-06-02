/**
 * Shared envelope for the typed `core/api/*` SSR fetch wrappers. Each entity
 * accessor (`fetchProductBySlug`, `fetchVendorBySlug`, …) repeats the same
 * `try { client.request<T>(path) } catch { 404 NOT_FOUND → null; else throw }`
 * shape; this hoists it so the wrappers stay typed one-liners.
 *
 * The `isServerApiError` structural guard is the essential bit (it survives
 * bundle splitting where `instanceof` would not) and lives here so the entity
 * files don't each import it.
 */
import { isServerApiError, type ServerApiClient } from '../../../server-api-client';

/**
 * GET `path` through the SSR service-binding client, mapping the canonical
 * `NOT_FOUND` envelope (HTTP 404 with `error.code === 'NOT_FOUND'`) to `null`
 * so resolvers can render an inline NotFound panel without try/catch noise.
 * Any other API error rethrows.
 */
export async function fetchOrNull<T>(client: ServerApiClient, path: string): Promise<T | null> {
  try {
    return await client.request<T>(path);
  } catch (err) {
    // Structural check, not `instanceof` — see `isServerApiError` for why.
    if (isServerApiError(err) && err.status === 404 && err.code === 'NOT_FOUND') {
      return null;
    }
    throw err;
  }
}
