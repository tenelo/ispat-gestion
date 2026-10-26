import { Injectable, signal } from '@angular/core';

/**
 * Configuration lue au démarrage dans /config.json (modifiable après déploiement, sans recompiler).
 *   apiUrl : adresse de l'API ; vide = même domaine que l'application (Nginx renvoie /api vers Django).
 */
export interface Configuration {
  apiUrl: string;
  intervalleSynchroMinutes: number;
}

const PAR_DEFAUT: Configuration = { apiUrl: '', intervalleSynchroMinutes: 5 };

@Injectable({ providedIn: 'root' })
export class ConfigService {
  readonly config = signal<Configuration>(PAR_DEFAUT);

  async charger(): Promise<void> {
    try {
      const reponse = await fetch('config.json', { cache: 'no-cache' });
      if (reponse.ok) {
        this.config.set({ ...PAR_DEFAUT, ...(await reponse.json()) });
      }
    } catch {
      // Hors ligne au premier démarrage : la copie mise en cache par le service worker est utilisée,
      // sinon les valeurs par défaut.
    }
  }

  /** URL complète d'un chemin d'API (« /api/... »). */
  api(chemin: string): string {
    return this.config().apiUrl.replace(/\/$/, '') + chemin;
  }
}
