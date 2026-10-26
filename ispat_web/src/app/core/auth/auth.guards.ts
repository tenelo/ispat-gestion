import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';

import { AuthService } from './auth.service';

/** Session ouverte (même hors ligne), sinon page de connexion. */
export const connecteGuard: CanActivateFn = (_route, etat) => {
  const auth = inject(AuthService);
  return auth.connecte() ? true : inject(Router).createUrlTree(['/connexion'], { queryParams: { retour: etat.url } });
};

/** Droits exigés par la route : data.droits = ['module.ressource.action', ...] (l'un suffit). */
export const droitsGuard: CanActivateFn = (route) => {
  const auth = inject(AuthService);
  const droits: string[] = route.data['droits'] ?? [];
  return auth.peut(droits) ? true : inject(Router).createUrlTree(['/acces-refuse']);
};

/** Page de connexion inutile si une session est déjà ouverte. */
export const anonymeGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  return auth.connecte() && !auth.reconnexionRequise() ? inject(Router).createUrlTree(['/']) : true;
};
