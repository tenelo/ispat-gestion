import { Injectable, computed, inject, signal } from '@angular/core';

import { ConfigService } from './config.service';

export type EtatReseau = 'en_ligne' | 'serveur_injoignable' | 'hors_ligne';

/**
 * État de la connexion :
 *   hors_ligne          : pas de réseau (navigateur) ;
 *   serveur_injoignable : réseau présent mais l'API ne répond pas (serveur arrêté, Wi-Fi sans Internet…) ;
 *   en_ligne            : l'API répond.
 */
@Injectable({ providedIn: 'root' })
export class ReseauService {
  private readonly config = inject(ConfigService);
  readonly etat = signal<EtatReseau>(typeof navigator !== 'undefined' && navigator.onLine ? 'en_ligne' : 'hors_ligne');
  readonly enLigne = computed(() => this.etat() === 'en_ligne');
  private readonly ecouteurs: Array<() => void> = [];

  demarrer(): void {
    window.addEventListener('online', () => void this.verifier());
    window.addEventListener('offline', () => this.changer('hors_ligne'));
    void this.verifier();
    setInterval(() => void this.verifier(), 30_000);
  }

  /** Appelée au retour en ligne (synchronisation, rechargement d'un écran). Renvoie la fonction de désabonnement. */
  quandEnLigne(rappel: () => void): () => void {
    this.ecouteurs.push(rappel);
    return () => {
      const i = this.ecouteurs.indexOf(rappel);
      if (i >= 0) {
        this.ecouteurs.splice(i, 1);
      }
    };
  }

  async verifier(): Promise<boolean> {
    if (!navigator.onLine) {
      this.changer('hors_ligne');
      return false;
    }
    try {
      const controle = new AbortController();
      const minuterie = setTimeout(() => controle.abort(), 5000);
      const r = await fetch(this.config.api('/api/sante/'), { cache: 'no-store', signal: controle.signal });
      clearTimeout(minuterie);
      this.changer(r.ok ? 'en_ligne' : 'serveur_injoignable');
    } catch {
      this.changer(navigator.onLine ? 'serveur_injoignable' : 'hors_ligne');
    }
    return this.enLigne();
  }

  private changer(nouvel: EtatReseau): void {
    const ancien = this.etat();
    this.etat.set(nouvel);
    if (nouvel === 'en_ligne' && ancien !== 'en_ligne') {
      this.ecouteurs.forEach((r) => r());
    }
  }
}
