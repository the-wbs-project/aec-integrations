import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

const PROTECTED_PREFIX = '/api/';
// /api/health is intentionally public on the worker; don't bother attaching
// a token (and don't trigger logout on its responses).
const PUBLIC_API_PATHS = new Set(['/api/health']);

// Extract the URL path whether req.url is relative ("/api/stats") or absolute
// ("http://localhost:8787/api/stats"). withFetch() can hand us either form.
function getPath(url: string): string {
  if (url.startsWith('/')) return url.split('?')[0];
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const path = getPath(req.url);
  const isApi = path.startsWith(PROTECTED_PREFIX);
  const isPublic = PUBLIC_API_PATHS.has(path);
  if (!isApi || isPublic) {
    return next(req);
  }

  return from(auth.getAccessToken()).pipe(
    switchMap((token) => {
      const authed = token
        ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
        : req;
      return next(authed).pipe(
        catchError((err) => {
          if (err instanceof HttpErrorResponse && err.status === 401) {
            void auth.signOut().finally(() => {
              void router.navigate(['/login'], {
                queryParams: { returnUrl: router.url },
              });
            });
          }
          return throwError(() => err);
        })
      );
    })
  );
};
