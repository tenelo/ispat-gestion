import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import localeFr from '@angular/common/locales/fr';
import {
  ApplicationConfig, LOCALE_ID, inject, isDevMode, provideAppInitializer, provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { MAT_DATE_LOCALE } from '@angular/material/core';
import { MatIconRegistry } from '@angular/material/icon';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { AuthService } from './core/auth/auth.service';
import { ConfigService } from './core/config.service';
import { InstallationService } from './core/installation.service';
import { ReseauService } from './core/reseau.service';
import { SyncService } from './core/sync/sync.service';

registerLocaleData(localeFr, 'fr');

/** Démarrage : configuration, session enregistrée sur le poste, surveillance du réseau, synchronisation. */
async function demarrer(): Promise<void> {
  inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-outlined');
  const config = inject(ConfigService);
  const auth = inject(AuthService);
  const reseau = inject(ReseauService);
  const sync = inject(SyncService);
  inject(InstallationService).ecouter();
  await config.charger();
  await auth.restaurer();
  reseau.demarrer();
  void sync.demarrer();
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch(), withInterceptors([authInterceptor])),
    provideAppInitializer(demarrer),
    { provide: LOCALE_ID, useValue: 'fr' },
    { provide: MAT_DATE_LOCALE, useValue: 'fr-FR' },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
