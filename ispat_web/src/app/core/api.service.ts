import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { ConfigService } from './config.service';
import { texteErreur } from './sync/sync.service';

export type Parametres = Record<string, string | number | boolean | null | undefined>;

/** Erreur d'API lisible : message global + erreurs par champ (formulaires). */
export class ErreurApi extends Error {
  constructor(
    message: string,
    readonly statut: number,
    readonly champs: Record<string, string> = {},
    readonly brut: any = null,
  ) {
    super(message);
  }
}

/**
 * Appels directs à l'API (écrans d'administration et opérations qui exigent le serveur :
 * validations, éditions PDF…). Les saisies utilisables hors ligne passent par SyncService.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);

  /** Liste complète : suit la pagination DRF ({count, next, results}) si l'API pagine. */
  async lister<T = any>(chemin: string, params: Parametres = {}): Promise<T[]> {
    let page = await this.get<any>(chemin, params);
    if (Array.isArray(page)) {
      return page;
    }
    const resultats: T[] = [...(page.results ?? [])];
    while (page.next) {
      page = await this.appel<any>(() => this.http.get(page.next));
      resultats.push(...(page.results ?? []));
    }
    return resultats;
  }

  get<T = any>(chemin: string, params: Parametres = {}): Promise<T> {
    return this.appel(() => this.http.get<T>(this.config.api(chemin), { params: this.params(params) }));
  }

  post<T = any>(chemin: string, corps: any = {}, motif?: string): Promise<T> {
    return this.appel(() => this.http.post<T>(this.config.api(chemin), corps, { headers: this.entetes(motif) }));
  }

  put<T = any>(chemin: string, corps: any, motif?: string): Promise<T> {
    return this.appel(() => this.http.put<T>(this.config.api(chemin), corps, { headers: this.entetes(motif) }));
  }

  patch<T = any>(chemin: string, corps: any, motif?: string): Promise<T> {
    return this.appel(() => this.http.patch<T>(this.config.api(chemin), corps, { headers: this.entetes(motif) }));
  }

  supprimer(chemin: string, motif?: string): Promise<void> {
    return this.appel(() => this.http.delete<void>(this.config.api(chemin), { headers: this.entetes(motif) }));
  }

  /** Fichier (PDF, Excel) : renvoie le contenu et le nom proposé par le serveur. */
  async fichier(chemin: string, params: Parametres = {}): Promise<{ blob: Blob; nom: string }> {
    const r = await this.appel(() =>
      this.http.get(this.config.api(chemin), { params: this.params(params), responseType: 'blob', observe: 'response' }),
    );
    const disposition = r.headers.get('Content-Disposition') ?? '';
    const nom = decodeURIComponent(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1] ?? 'document');
    return { blob: r.body!, nom };
  }

  private params(p: Parametres): HttpParams {
    let hp = new HttpParams();
    for (const [cle, valeur] of Object.entries(p)) {
      if (valeur !== null && valeur !== undefined && valeur !== '') {
        hp = hp.set(cle, String(valeur));
      }
    }
    return hp;
  }

  private entetes(motif?: string): Record<string, string> {
    if (!motif) {
      return {};
    }
    // En-tête HTTP : caractères Latin-1 uniquement (les accents français passent ; ’ et œ sont remplacés).
    const latin1 = motif
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/œ/g, 'oe')
      .replace(/Œ/g, 'OE')
      .replace(/[^\x20-\xFF]/g, ' ');
    return { 'X-Motif': latin1 };
  }

  private async appel<T>(fn: () => import('rxjs').Observable<T>): Promise<T> {
    try {
      return await firstValueFrom(fn());
    } catch (e) {
      throw await versErreurApi(e);
    }
  }
}

export async function versErreurApi(e: unknown): Promise<ErreurApi> {
  if (e instanceof ErreurApi) {
    return e;
  }
  if (e instanceof HttpErrorResponse) {
    let corps = e.error;
    if (corps instanceof Blob) {
      try {
        corps = JSON.parse(await corps.text());
      } catch {
        corps = null;
      }
    }
    if (e.status === 0) {
      return new ErreurApi('Serveur injoignable : cette opération nécessite la connexion.', 0);
    }
    if (e.status === 403) {
      return new ErreurApi(texteErreur(corps) || 'Action non autorisée pour votre rôle.', 403, {}, corps);
    }
    const champs: Record<string, string> = {};
    let global = '';
    if (corps && typeof corps === 'object' && !Array.isArray(corps)) {
      for (const [cle, valeur] of Object.entries(corps)) {
        if (['detail', 'non_field_errors', 'contrainte', 'indice'].includes(cle)) {
          continue;
        }
        champs[cle] = texteErreur(valeur);
      }
      global = [texteErreur(corps['detail']), texteErreur(corps['non_field_errors']), texteErreur(corps['indice'])]
        .filter(Boolean)
        .join(' ');
    } else {
      global = texteErreur(corps);
    }
    if (!global && Object.keys(champs).length === 0) {
      global = `Erreur du serveur (${e.status}).`;
    }
    return new ErreurApi(global || 'Vérifiez les champs signalés.', e.status, champs, corps);
  }
  return new ErreurApi(e instanceof Error ? e.message : String(e), -1);
}
