import { z } from 'zod';

import { LogoPathSchema } from './logo-read';

/**
 * The WRITE half of the logo contract (AECI-955 / ADR 0032).
 *
 * The read half lives in `./logo-read` and is re-exported below. The split is
 * load-bearing rather than tidy: see that file's docblock — every schema here is
 * reachable only from a lazy route, and keeping them beside the read schemas put
 * them in `apps/web`'s eager bundle and broke its `initial` budget.
 */
export * from './logo-read';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_DIMENSION = 2048;
export const LogoKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * What a client may WRITE to a logo column: an HTTPS URL with no embedded
 * credentials, or one of our own stored objects. Never `http:`, never a
 * `data:` / `javascript:` URL, never a bare relative path.
 */
export const LogoUrlSchema = z.union([
  z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      } catch {
        return false;
      }
    }),
  LogoPathSchema,
]);

export const UpdateLogoSchema = z.object({ logo_url: LogoUrlSchema.nullable() }).strict();
export const UploadLogoResponseSchema = z.object({ logo_url: LogoPathSchema });
export type UploadLogoResponse = z.infer<typeof UploadLogoResponseSchema>;
export type UpdateLogoInput = z.infer<typeof UpdateLogoSchema>;
