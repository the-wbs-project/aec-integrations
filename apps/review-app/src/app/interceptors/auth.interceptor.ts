import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

const PROTECTED_PREFIX = '/api/';
// /api/health is intentionally public on the worker; don't bother attaching
// a token (and don't trigger logout on its responses).
const PUBLIC_API_PATHS = new Set(['/api/health']);

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);

  const isApi = req.url.startsWith(PROTECTED_PREFIX);
  const isPublic = PUBLIC_API_PATHS.has(req.url);
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
