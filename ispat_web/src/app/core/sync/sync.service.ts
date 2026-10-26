import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { AuthService } from '../auth/auth.service';
import { ConfigService } from '../config.service';
import { FichierAttente, Ligne, Operation, SCHEMA_TABLES, db } from '../db';
import { ReseauService } from '../reseau.service';
import { nouvelId } from '../texte';

interface ReponsePull {
  filigrane: number;
  jusqu_a: number;
  complet: boolean;
  reinitialiser: boolean;
  tables: Record<string, Ligne[]>;
}

interface ResultatPush {
  op_id: string;
  statut: 'ok' | 'deja_traite' | 'conflit' | 'refuse' | 'erreur' | 'invalide';
  code: number;
  id?: string;
  ligne?: Ligne | null;
  serveur?: Ligne | null;
  erreurs?: any;
  doublons?: any[];
  reponse?: any;
}

export interface NouvelleOperation {
  table: string;
  action: string;
  id?: string;
  version?: number;
  donnees?: Record<string, any>;
  motif?: string;
  libelle: string;
}

const TAILLE_LOT = 200;
const TAILLE_PAGE = 1000;

/** Message lisible à partir d'une erreur renvoyée par l'API (« champ : message »). */
export function texteErreur(erreurs: any): string {
  if (erreurs == null) {
    return '';
  }
  if (typeof erreurs === 'string') {
    return erreurs;
  }
  if (Array.isArray(erreurs)) {
    return erreurs.map(texteErreur).join(' ');
  }
  if (typeof erreurs === 'object') {
    return Object.entries(erreurs)
      .filter(([cle]) => !['doublons', 'serveur', 'etudiants'].includes(cle))
      .map(([cle, v]) => (cle === 'detail' || cle === 'non_field_errors' ? texteErreur(v) : `${cle} : ${texteErreur(v)}`))
      .join(' · ');
  }
  return String(erreurs);
}

/**
 * Synchronisation avec l'API :
 *   1. ENVOI  : la file d'envoi (saisies faites en ligne ou hors ligne) part dans l'ordre, par lots de 200 ;
 *   2. RÉCEPTION : changements des autres utilisateurs depuis le dernier filigrane, par pages de 1000.
 * Déclenchée au démarrage, au retour du réseau, après chaque saisie (1,5 s) et à intervalle régulier.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(ConfigService);
  private readonly auth = inject(AuthService);
  private readonly reseau = inject(ReseauService);

  readonly enCours = signal(false);
  readonly derniereSynchro = signal<Date | null>(null);
  readonly derniereErreur = signal<string | null>(null);
  readonly enAttente = signal(0);
  readonly conflits = signal(0);
  readonly erreurs = signal(0);
  readonly chargementInitial = signal(false);
  readonly lignesRecues = signal(0);
  /** Incrémenté à chaque changement des données locales : les écrans relisent la base. */
  readonly revision = signal(0);
  readonly fichiersAttente = signal(0);
  readonly fichiersErreur = signal(0);
  /** Saisies + fichiers (photos, pièces) restant à envoyer. */
  readonly aEnvoyer = computed(() => this.enAttente() + this.fichiersAttente());
  readonly aResoudre = computed(() => this.conflits() + this.erreurs() + this.fichiersErreur());

  private planification: ReturnType<typeof setTimeout> | null = null;
  private demarre = false;

  async demarrer(): Promise<void> {
    if (this.demarre) {
      return;
    }
    this.demarre = true;
    const derniere = await db.lireMeta<string | null>('derniere_synchro', null);
    this.derniereSynchro.set(derniere ? new Date(derniere) : null);
    await this.compter();
    this.reseau.quandEnLigne(() => void this.synchroniser());
    setInterval(() => void this.synchroniser(), Math.max(1, this.config.config().intervalleSynchroMinutes) * 60_000);
    void this.synchroniser();
  }

  /**
   * Enregistre une saisie : la ligne locale est mise à jour tout de suite (l'écran l'affiche),
   * l'opération part dans la file d'envoi et sera transmise dès que possible.
   */
  async enregistrer(op: NouvelleOperation, ligneLocale?: Ligne, autres: { table: string; ligne: Ligne }[] = []): Promise<void> {
    const noms = new Set([...(ligneLocale ? [op.table] : []), ...autres.map((a) => a.table)].filter((t) => SCHEMA_TABLES[t]));
    const tables = [db.operations, ...[...noms].map((t) => db.table_(t))];
    await db.transaction('rw', tables, async () => {
      if (ligneLocale && SCHEMA_TABLES[op.table]) {
        await db.table_(op.table).put({ ...ligneLocale, _en_attente: 1 });
      }
      for (const a of autres) {
        if (SCHEMA_TABLES[a.table]) {
          await db.table_(a.table).put({ ...a.ligne, _en_attente: 1 });
        }
      }
      if (!(await this.fusionner(op))) {
        await db.operations.add({ ...op, op_id: nouvelId(), cree_le: new Date().toISOString(), statut: 'attente' });
      }
    });
    await this.compter();
    this.revision.update((v) => v + 1);
    this.planifier();
  }

  /**
   * Modification d'un enregistrement dont une saisie n'est pas encore partie : fusionnée dans cette saisie
   * (sinon la seconde arriverait avec une version périmée et serait refusée comme conflit).
   */
  private async fusionner(op: NouvelleOperation): Promise<boolean> {
    if (op.action !== 'modifier' || !op.id) {
      return false;
    }
    const attente = await db.operations.where('statut').equals('attente').toArray();
    const meme = attente.find((o) => o.table === op.table && o.id === op.id && (o.action === 'modifier' || o.action === 'creer'));
    if (meme) {
      await db.operations.update(meme.seq!, { donnees: { ...meme.donnees, ...op.donnees }, motif: op.motif ?? meme.motif });
      return true;
    }
    if (op.table === 'etudiant') {
      const inscription = attente.find((o) => o.table === 'inscription' && o.action === 'nouvelle' && o.donnees?.['etudiant']?.id === op.id);
      if (inscription) {
        const d = inscription.donnees!;
        await db.operations.update(inscription.seq!, { donnees: { ...d, etudiant: { ...d['etudiant'], ...op.donnees } } });
        return true;
      }
    }
    return false;
  }

  planifier(delai = 1500): void {
    if (this.planification) {
      clearTimeout(this.planification);
    }
    this.planification = setTimeout(() => void this.synchroniser(), delai);
  }

  async synchroniser(): Promise<void> {
    // Verrou posé avant toute attente : deux déclenchements simultanés (retour réseau + minuterie)
    // ne doivent jamais envoyer deux fois la même saisie ou le même fichier.
    if (!this.auth.connecte() || this.auth.reconnexionRequise()) {
      return;
    }
    if (this.verrou) {
      this.aRelancer = true;          // une saisie arrivée pendant l'échange part juste après
      return;
    }
    this.verrou = true;
    this.aRelancer = false;
    try {
      if (!(await this.reseau.verifier())) {
        return;
      }
      await this.cycle();
    } finally {
      this.verrou = false;
      if (this.aRelancer) {
        this.aRelancer = false;
        this.planifier(200);
      }
    }
  }

  private verrou = false;
  private aRelancer = false;

  private async cycle(): Promise<void> {
    this.enCours.set(true);
    try {
      await this.auth.actualiserProfil().catch(() => undefined);
      await this.envoyer();
      await this.envoyerFichiers();
      await this.recevoir();
      const maintenant = new Date();
      this.derniereSynchro.set(maintenant);
      await db.ecrireMeta('derniere_synchro', maintenant.toISOString());
      this.derniereErreur.set(null);
    } catch (e) {
      this.derniereErreur.set(this.message(e));
    } finally {
      this.enCours.set(false);
      this.chargementInitial.set(false);
      await this.compter();
      this.revision.update((v) => v + 1);
    }
  }

  // -- Envoi ---------------------------------------------------------------------------------

  private async envoyer(): Promise<void> {
    for (;;) {
      const lot = await db.operations.where('statut').equals('attente').sortBy('seq');
      if (!lot.length) {
        return;
      }
      const envoi = lot.slice(0, TAILLE_LOT);
      const r = await firstValueFrom(
        this.http.post<{ resultats: ResultatPush[] }>(this.config.api('/api/sync/push/'), {
          operations: envoi.map((o) => ({
            op_id: o.op_id, table: o.table, action: o.action, id: o.id, version: o.version, donnees: o.donnees,
            motif: o.motif,
          })),
        }),
      );
      const parOpId = new Map(envoi.map((o) => [o.op_id, o]));
      for (const res of r.resultats) {
        const op = parOpId.get(res.op_id);
        if (op) {
          await this.appliquerResultat(op, res);
        }
      }
      if (envoi.length < TAILLE_LOT) {
        return;
      }
    }
  }

  private async appliquerResultat(op: Operation, res: ResultatPush): Promise<void> {
    if (res.statut === 'ok' || res.statut === 'deja_traite') {
      await db.transaction('rw', [db.operations, ...(SCHEMA_TABLES[op.table] ? [db.table_(op.table)] : [])], async () => {
        await db.operations.delete(op.seq!);
        if (res.ligne && SCHEMA_TABLES[op.table]) {
          await db.table_(op.table).put(res.ligne);
        }
      });
      return;
    }
    await db.operations.update(op.seq!, {
      statut: res.statut === 'conflit' ? 'conflit' : 'erreur',
      message: texteErreur(res.erreurs) || `Refus du serveur (${res.code}).`,
      serveur: res.serveur ?? null,
      details: res,
    });
  }

  // -- Fichiers (photos, pièces jointes) -------------------------------------------------------

  /** Photo ou pièce prise sur le poste : envoyée dès que l'étudiant existe sur le serveur. */
  async ajouterFichier(f: Omit<FichierAttente, 'seq' | 'cree_le' | 'statut'>): Promise<void> {
    if (f.type === 'photo') {
      // Une seule photo en attente par étudiant : la dernière prise remplace les précédentes.
      await db.fichiers.where('etudiant_id').equals(f.etudiant_id).filter((x) => x.type === 'photo').delete();
    }
    await db.fichiers.add({ ...f, cree_le: new Date().toISOString(), statut: 'attente' });
    await this.compter();
    this.revision.update((v) => v + 1);
    this.planifier();
  }

  /** L'étudiant ou l'inscription du fichier est-il encore dans la file d'envoi (pas encore créé côté serveur) ? */
  private async dependanceEnAttente(f: FichierAttente): Promise<boolean> {
    const ops = await db.operations.toArray();
    return ops.some(
      (o) =>
        (o.table === 'etudiant' && o.action === 'creer' && o.id === f.etudiant_id) ||
        (o.table === 'inscription' && o.action === 'nouvelle' &&
          (o.donnees?.['id'] === f.inscription_id || o.donnees?.['etudiant']?.id === f.etudiant_id)),
    );
  }

  private async envoyerFichiers(): Promise<void> {
    const fichiers = await db.fichiers.where('statut').equals('attente').sortBy('seq');
    for (const f of fichiers) {
      if (await this.dependanceEnAttente(f)) {
        continue;
      }
      const formulaire = new FormData();
      let url: string;
      if (f.type === 'photo') {
        formulaire.append('photo', f.blob, f.nom);
        url = `/api/scolarite/etudiants/${f.etudiant_id}/photo/`;
      } else {
        formulaire.append('fichier', f.blob, f.nom);
        formulaire.append('type_piece', f.type_piece_id ?? '');
        formulaire.append('etudiant', f.etudiant_id);
        if (f.inscription_id) {
          formulaire.append('inscription', f.inscription_id);
        }
        url = '/api/scolarite/pieces/';
      }
      try {
        await firstValueFrom(this.http.post(this.config.api(url), formulaire));
        await db.fichiers.delete(f.seq!);
      } catch (e) {
        if (e instanceof HttpErrorResponse && e.status >= 400 && e.status < 500 && e.status !== 401) {
          await db.fichiers.update(f.seq!, { statut: 'erreur', message: texteErreur(e.error) || `Refus du serveur (${e.status}).` });
          continue;
        }
        throw e;               // réseau coupé, serveur indisponible : nouvel essai plus tard
      }
    }
  }

  async reessayerFichier(f: FichierAttente): Promise<void> {
    await db.fichiers.update(f.seq!, { statut: 'attente', message: undefined });
    await this.apresResolution();
    this.planifier(0);
  }

  async abandonnerFichier(f: FichierAttente): Promise<void> {
    await db.fichiers.delete(f.seq!);
    await this.apresResolution();
  }

  // -- Réception -----------------------------------------------------------------------------

  private async recevoir(): Promise<void> {
    let depuis = await db.lireMeta<number>('filigrane', 0);
    let initial = depuis === 0 || (await db.lireMeta<boolean>('chargement_initial', false));
    this.chargementInitial.set(initial);
    this.lignesRecues.set(0);
    for (;;) {
      const url = `/api/sync/pull/?depuis=${depuis}&limite=${TAILLE_PAGE}${initial ? '&initial=true' : ''}`;
      const page = await firstValueFrom(this.http.get<ReponsePull>(this.config.api(url)));
      if (page.reinitialiser) {
        await db.viderDonnees();
        depuis = 0;
        initial = true;
        this.chargementInitial.set(true);
        continue;
      }
      await this.appliquerPage(page, !page.complet && initial);
      this.lignesRecues.update((n) => n + Object.values(page.tables).reduce((s, l) => s + l.length, 0));
      depuis = page.jusqu_a;
      if (page.complet) {
        return;
      }
    }
  }

  private async appliquerPage(page: ReponsePull, chargementEnCours: boolean): Promise<void> {
    const noms = Object.keys(page.tables).filter((t) => SCHEMA_TABLES[t]);
    await db.transaction('rw', [db.meta, ...noms.map((t) => db.table_(t))], async () => {
      for (const nom of noms) {
        const lignes = page.tables[nom];
        const supprimees = lignes.filter((l) => l.deleted_at).map((l) => l.id);
        const actives = lignes.filter((l) => !l.deleted_at);
        if (supprimees.length) {
          await db.table_(nom).bulkDelete(supprimees);
        }
        if (actives.length) {
          await db.table_(nom).bulkPut(actives);
        }
      }
      await db.ecrireMeta('filigrane', page.jusqu_a);
      await db.ecrireMeta('chargement_initial', chargementEnCours);
    });
  }

  // -- Résolution des conflits et erreurs (écran Synchronisation) ------------------------------

  /** Abandonner ma saisie et garder la version du serveur. */
  async garderServeur(op: Operation): Promise<void> {
    if (op.table === 'inscription' && op.action === 'nouvelle') {
      await this.abandonnerNouvelleInscription(op);
      return;
    }
    await db.transaction('rw', [db.operations, ...(SCHEMA_TABLES[op.table] ? [db.table_(op.table)] : [])], async () => {
      await db.operations.delete(op.seq!);
      if (SCHEMA_TABLES[op.table] && op.id) {
        if (op.serveur) {
          await db.table_(op.table).put(op.serveur);
        } else if (op.action === 'creer') {
          await db.table_(op.table).delete(op.id);
        }
      }
    });
    await this.apresResolution();
  }

  /** Inscription saisie sur le poste et refusée : retire l'inscription, le nouvel étudiant, ses contacts et fichiers. */
  private async abandonnerNouvelleInscription(op: Operation): Promise<void> {
    const d = op.donnees ?? {};
    const etudiantNouveau: string | undefined = d['etudiant']?.id;
    await db.transaction('rw', [db.operations, db.fichiers, db.table_('inscription'), db.table_('etudiant'), db.table_('contact_etudiant')], async () => {
      await db.operations.delete(op.seq!);
      if (d['id']) {
        await db.table_('inscription').delete(d['id']);
      }
      if (etudiantNouveau) {
        await db.table_('etudiant').delete(etudiantNouveau);
        await db.table_('contact_etudiant').where('etudiant_id').equals(etudiantNouveau).delete();
        await db.fichiers.where('etudiant_id').equals(etudiantNouveau).delete();
      } else if (d['id']) {
        await db.fichiers.filter((f) => f.inscription_id === d['id']).delete();
      }
    });
    await this.apresResolution();
  }

  /** Renvoyer ma saisie (sur la version actuelle du serveur ; « forcer » pour un doublon assumé). */
  async renvoyer(op: Operation, forcer = false): Promise<void> {
    await db.operations.update(op.seq!, {
      statut: 'attente',
      version: op.serveur?.version ?? op.version,
      donnees: forcer ? { ...op.donnees, forcer: true } : op.donnees,
      message: undefined,
      details: undefined,
    });
    await this.apresResolution();
    this.planifier(0);
  }

  private async apresResolution(): Promise<void> {
    await this.compter();
    this.revision.update((v) => v + 1);
  }

  async compter(): Promise<void> {
    this.enAttente.set(await db.operations.where('statut').equals('attente').count());
    this.conflits.set(await db.operations.where('statut').equals('conflit').count());
    this.erreurs.set(await db.operations.where('statut').equals('erreur').count());
    this.fichiersAttente.set(await db.fichiers.where('statut').equals('attente').count());
    this.fichiersErreur.set(await db.fichiers.where('statut').equals('erreur').count());
  }

  private message(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      if (e.status === 0) {
        return 'Serveur injoignable.';
      }
      if (e.status === 401) {
        return 'Session expirée : reconnectez-vous.';
      }
      return texteErreur(e.error) || `Erreur ${e.status}.`;
    }
    return e instanceof Error ? e.message : String(e);
  }
}
