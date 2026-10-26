import Dexie, { Table } from 'dexie';

/**
 * Base locale (IndexedDB) : copie des tables autorisées pour l'utilisateur + file d'envoi.
 * Les noms de tables et de colonnes sont ceux de l'API de synchronisation (/api/sync/pull/),
 * par exemple « inscription.classe_id ».
 */

export type Ligne = Record<string, any> & { id: string; version?: number; sync_seq?: number; deleted_at?: string | null };

export type StatutOperation = 'attente' | 'conflit' | 'erreur';

export interface Operation {
  seq?: number;
  op_id: string;
  table: string;
  action: string;
  id?: string;
  version?: number;
  donnees?: Record<string, any>;
  motif?: string;
  libelle: string;               // texte lisible dans l'écran Synchronisation
  cree_le: string;
  statut: StatutOperation;
  message?: string;
  serveur?: Ligne | null;        // ligne du serveur en cas de conflit de version
  details?: any;                 // erreurs renvoyées par le serveur (champ par champ, doublons…)
}

/** Photo ou pièce jointe saisie sur le poste, envoyée au serveur après l'étudiant / l'inscription. */
export interface FichierAttente {
  seq?: number;
  type: 'photo' | 'piece';
  etudiant_id: string;
  inscription_id?: string | null;
  type_piece_id?: string | null;
  blob: Blob;
  nom: string;
  mime: string;
  libelle: string;
  cree_le: string;
  statut: 'attente' | 'erreur';
  message?: string;
}

export interface Meta {
  cle: string;
  valeur: any;
}

/** Index par table (le premier champ est la clé primaire). */
export const SCHEMA_TABLES: Record<string, string> = {
  annee_academique: 'id, est_active',
  semestre: 'id, annee_id',
  filiere: 'id, code',
  niveau: 'id, code',
  classe: 'id, annee_id, filiere_id, niveau_id',
  matiere: 'id, filiere_id, niveau_id',
  enseignant: 'id, utilisateur_id',
  enseignement: 'id, classe_id, enseignant_id, matiere_id',
  statut_etudiant: 'id, code',
  type_piece: 'id, code',
  ville: 'id',
  ecole: 'id, ville_id',
  type_frais: 'id, code',
  categorie_mouvement: 'id, code, sens',
  parametre: 'id, cle',
  tarif: 'id, annee_id',
  etudiant: 'id, matricule, nom',
  contact_etudiant: 'id, etudiant_id',
  inscription: 'id, etudiant_id, classe_id, annee_id, etat',
  piece_jointe: 'id, etudiant_id, inscription_id',
  frais_inscription: 'id, inscription_id',
  prise_en_charge: 'id, inscription_id',
  versement: 'id, inscription_id, date_versement',
  mouvement_caisse: 'id, date_mouvement, sens',
  evaluation: 'id, classe_id, matiere_id, semestre_id',
  note: 'id, evaluation_id, inscription_id',
  moyenne_matiere: 'id, inscription_id, semestre_id',
  moyenne_semestre: 'id, inscription_id, semestre_id',
  campagne_prospection: 'id, annee_id',
  prospect: 'id, campagne_id, statut, agent_id, date_contact',
  suivi_prospect: 'id, prospect_id',
  preinscription: 'id, statut, prospect_id',
};

export class BaseIspat extends Dexie {
  meta!: Table<Meta, string>;
  operations!: Table<Operation, number>;
  fichiers!: Table<FichierAttente, number>;

  constructor() {
    super('ispat-gestion');
    this.version(1).stores({
      ...SCHEMA_TABLES,
      meta: 'cle',
      operations: '++seq, &op_id, statut, table',
    });
    // v2 : photos et pièces jointes saisies hors ligne.
    this.version(2).stores({ fichiers: '++seq, statut, etudiant_id' });
  }

  table_(nom: string): Table<Ligne, string> {
    return this.table(nom) as Table<Ligne, string>;
  }

  async lireMeta<T>(cle: string, defaut: T): Promise<T> {
    const m = await this.meta.get(cle);
    return m === undefined ? defaut : (m.valeur as T);
  }

  ecrireMeta(cle: string, valeur: any): Promise<string> {
    return this.meta.put({ cle, valeur });
  }

  /** Efface les données synchronisées (changement d'utilisateur). La file d'envoi est conservée à part. */
  async viderDonnees(): Promise<void> {
    await this.transaction('rw', Object.keys(SCHEMA_TABLES).map((t) => this.table(t)), async () => {
      for (const t of Object.keys(SCHEMA_TABLES)) {
        await this.table(t).clear();
      }
    });
    await this.meta.delete('filigrane');
  }
}

export const db = new BaseIspat();
