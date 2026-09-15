import { z } from 'zod';

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MAX_DIMENSION = 2048;
export const LogoKeySchema = z.string().regex(/^[a-f0-9]{64}$/);
export const LogoPathSchema = z.string().regex(/^\/api\/logos\/[a-f0-9]{64}$/);
// Read compatibility includes legacy absolute URLs. New writes require HTTPS.
export const LogoReadUrlSchema = z.union([z.string().url(), LogoPathSchema]);
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
