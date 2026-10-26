import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { ConfigService } from '../config.service';
import { db } from '../db';

export interface Utilisateur {
  id: string;
  login: string;
  nom: string;
  prenoms: string;
  email?: string | null;
  telephone?: string | null;
  roles: string[];
  permissions: string[];
}

interface Session {
  access: string;
  refresh: string;
  utilisateur: Utilisateur;
}

export const LIBELLES_ROLES: Record<string, string> = {
  ADMIN: 'Administrateur',
  DIRECTION: 'Direction',
  DIRECTEUR_ETUDES: 'Directeur des études',
  COMPTABLE: 'Comptable',
  SCOLARITE: 'Scolarité',
  ENSEIGNANT: 'Enseignant',
  COMMERCIAL: 'Commercial',
};

/**
 * Session de l'utilisateur.
 *  * Jetons + profil + droits conservés dans la base locale : l'application rouvre sans réseau
 *    avec la dernière session (les droits restent ceux du dernier passage en ligne).
 *  * Jeton d'accès expiré : renouvelé automatiquement (un seul renouvellement à la fois).
 *  * Jeton de renouvellement expiré (7 jours sans connexion) : « reconnexion requise » ; la file
 *    d'envoi est conservée et partira après la reconnexion du même utilisateur.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);
  private readonly router = inject(Router);

  private readonly session = signal<Session | null>(null);
  private renouvellement: Promise<string | null> | null = null;

  readonly utilisateur = computed(() => this.session()?.utilisateur ?? null);
  readonly connecte = computed(() => this.session() !== null);
  readonly reconnexionRequise = signal(false);
  private readonly droits = computed(() => new Set(this.session()?.utilisateur.permissions ?? []));

  get jetonAcces(): string | null {
    return this.session()?.access ?? null;
  }

  /** L'utilisateur a-t-il au moins un de ces droits ? (tableau vide = tout utilisateur connecté) */
  peut(codes: string | string[]): boolean {
    const liste = Array.isArray(codes) ? codes : [codes];
    if (!this.connecte()) {
      return false;
    }
    return liste.length === 0 || liste.some((c) => this.droits().has(c));
  }

  libelleRoles(): string {
    return (this.utilisateur()?.roles ?? []).map((r) => LIBELLES_ROLES[r] ?? r).join(', ');
  }

  async restaurer(): Promise<void> {
    const s = await db.lireMeta<Session | null>('session', null);
    if (s?.access && s.utilisateur) {
      this.session.set(s);
    }
  }

  /** Connexion. Changement d'utilisateur : refusé si l'ancien a des saisies non envoyées. */
  async connecter(login: string, motDePasse: string): Promise<void> {
    const r = await firstValueFrom(
      this.http.post<Session>(this.config.api('/api/auth/connexion/'), { login, password: motDePasse }),
    );
    const precedent = await db.lireMeta<string | null>('utilisateur_id', null);
    if (precedent && precedent !== r.utilisateur.id) {
      const enAttente = (await db.operations.count()) + (await db.fichiers.count());
      if (enAttente > 0) {
        throw new Error(
          `${enAttente} saisie(s) de l'utilisateur précédent ne sont pas encore envoyées. ` +
            'Il doit se reconnecter pour les synchroniser avant tout changement d\'utilisateur.',
        );
      }
      await db.viderDonnees();
    }
    await db.ecrireMeta('utilisateur_id', r.utilisateur.id);
    await this.enregistrer(r);
    this.reconnexionRequise.set(false);
  }

  /** Profil et droits à jour (appelé à chaque retour en ligne). */
  async actualiserProfil(): Promise<void> {
    const s = this.session();
    if (!s) {
      return;
    }
    const u = await firstValueFrom(this.http.get<Utilisateur>(this.config.api('/api/auth/moi/')));
    await this.enregistrer({ ...this.session()!, utilisateur: u });
  }

  /** Renouvelle le jeton d'accès ; null si la session a expiré. */
  renouveler(): Promise<string | null> {
    if (!this.renouvellement) {
      this.renouvellement = this.faireRenouvellement().finally(() => (this.renouvellement = null));
    }
    return this.renouvellement;
  }

  private async faireRenouvellement(): Promise<string | null> {
    const s = this.session();
    if (!s?.refresh) {
      return null;
    }
    try {
      const r = await firstValueFrom(
        this.http.post<{ access: string; refresh?: string }>(this.config.api('/api/auth/rafraichir/'), {
          refresh: s.refresh,
        }),
      );
      await this.enregistrer({ ...s, access: r.access, refresh: r.refresh ?? s.refresh });
      return r.access;
    } catch (e) {
      if (e instanceof HttpErrorResponse && (e.status === 401 || e.status === 400)) {
        this.reconnexionRequise.set(true);
      }
      return null;
    }
  }

  /**
   * Déconnexion. Les données locales sont effacées (poste partagé) sauf s'il reste des saisies à envoyer :
   * dans ce cas, appeler avec forcer = true après confirmation explicite.
   */
  async deconnecter(forcer = false): Promise<number> {
    const enAttente = (await db.operations.count()) + (await db.fichiers.count());
    if (enAttente > 0 && !forcer) {
      return enAttente;
    }
    await db.operations.clear();
    await db.fichiers.clear();
    await db.viderDonnees();
    await db.meta.clear();
    this.session.set(null);
    this.reconnexionRequise.set(false);
    await this.router.navigate(['/connexion']);
    return 0;
  }

  private async enregistrer(s: Session): Promise<void> {
    await db.ecrireMeta('session', s);
    this.session.set(s);
  }
}
