import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { LOGO_MAX_BYTES, UploadLogoResponseSchema } from '@aeci/shared';
import { catchError, map, throwError, type Observable } from 'rxjs';

export type LogoUploadEndpoint = '/api/vendor/logo' | '/api/admin/logo';

/**
 * The upload half of the logo controls (AECI-955), shared by `aec-logo-input`
 * and the vendor portal's logo dialog so both say the same thing about the same
 * failure. Uploading writes no catalog row: it returns the stored
 * `/api/logos/<hash>` path, and the caller decides when to save it
 * (`STAGE_2_5_SPEC.md` §11.1).
 */

/** The one file to upload, or the localized reason it cannot be sent. */
export function pickLogoFile(files: FileList | null): { file: File } | { error: string } | null {
  if (!files?.length) return null;
  const file = files.item(0);
  if (files.length !== 1 || !file) {
    return { error: $localize`:@@logo.oneFile:Choose one image at a time.` };
  }
  if (!file.size || file.size > LOGO_MAX_BYTES) {
    return { error: $localize`:@@logo.size:Choose an image no larger than 2 MiB.` };
  }
  return { file };
}

/** POST the file. Emits the stored path; errors carry a localized message. */
export function uploadLogo(
  http: HttpClient,
  endpoint: LogoUploadEndpoint,
  file: File,
): Observable<string> {
  const body = new FormData();
  body.append('file', file);
  return http.post<unknown>(endpoint, body).pipe(
    catchError((error: unknown) =>
      throwError(
        () =>
          new Error(
            error instanceof HttpErrorResponse && error.status === 429
              ? $localize`:@@logo.rateLimited:Too many uploads. Wait a moment and try again.`
              : $localize`:@@logo.uploadFailed:We couldn't upload this image. Check the format, size and dimensions, then try again.`,
          ),
      ),
    ),
    map((response) => {
      const result = UploadLogoResponseSchema.safeParse(response);
      if (!result.success) {
        throw new Error($localize`:@@logo.invalidResponse:Upload failed. Please try again.`);
      }
      return result.data.logo_url;
    }),
  );
}
