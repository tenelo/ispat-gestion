import { HttpErrorResponse, HttpInterceptorFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';

import { AuthService } from './auth.service';

const SANS_JETON = ['/api/auth/connexion/', '/api/auth/rafraichir/', '/api/sante/'];

function avecJeton(req: HttpRequest<unknown>, jeton: string | null): HttpRequest<unknown> {
  return jeton ? req.clone({ setHeaders: { Authorization: `Bearer ${jeton}` } }) : req;
}

/** Ajoute le jeton aux appels d'API ; sur 401, renouvelle le jeton une fois puis rejoue la requête. */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  if (!req.url.includes('/api/') || SANS_JETON.some((c) => req.url.includes(c))) {
    return next(req);
  }
  return next(avecJeton(req, auth.jetonAcces)).pipe(
    catchError((erreur: unknown) => {
      if (!(erreur instanceof HttpErrorResponse) || erreur.status !== 401) {
        return throwError(() => erreur);
      }
      return from(auth.renouveler()).pipe(
        switchMap((jeton) => (jeton ? next(avecJeton(req, jeton)) : throwError(() => erreur))),
      );
    }),
  );
};
