import { Ligne, db } from './db';

/** Libellés et données locales communes aux écrans de scolarité. */

export const ETATS_INSCRIPTION: Record<string, string> = {
  EN_ATTENTE: 'En attente',
  VALIDEE: 'Validée',
  ANNULEE: 'Annulée',
  ABANDON: 'Abandon',
};

export const TYPES_INSCRIPTION: [string, string][] = [
  ['NOUVELLE', 'Nouvelle inscription'],
  ['REINSCRIPTION', 'Réinscription'],
  ['REDOUBLEMENT', 'Redoublement'],
  ['TRANSFERT', 'Transfert'],
];

export const LIENS_CONTACT: [string, string][] = [
  ['PERE', 'Père'], ['MERE', 'Mère'], ['TUTEUR', 'Tuteur'], ['CONJOINT', 'Conjoint'], ['AUTRE', 'Autre'],
];

export const SEXES: [string, string][] = [['F', 'Féminin'], ['M', 'Masculin']];

export function classeEtat(etat: string): string {
  return etat === 'VALIDEE' ? '' : etat === 'EN_ATTENTE' ? 'attente' : etat === 'ABANDON' ? 'alerte' : 'neutre';
}

export interface ReferentielsScolarite {
  annees: Ligne[];
  anneeActive: Ligne | undefined;
  classes: Ligne[];
  statuts: Ligne[];
  villes: Ligne[];
  ecoles: Ligne[];
  typesPiece: Ligne[];
  filieres: Ligne[];
  niveaux: Ligne[];
  parId: Map<string, Ligne>;
}

const parLibelle = (cle: string) => (a: Ligne, b: Ligne) => String(a[cle] ?? '').localeCompare(String(b[cle] ?? ''), 'fr');

/** Référentiels copiés sur le poste (disponibles hors ligne). */
export async function referentielsScolarite(): Promise<ReferentielsScolarite> {
  const [annees, classes, statuts, villes, ecoles, typesPiece, filieres, niveaux] = await Promise.all([
    db.table_('annee_academique').toArray(),
    db.table_('classe').toArray(),
    db.table_('statut_etudiant').toArray(),
    db.table_('ville').toArray(),
    db.table_('ecole').toArray(),
    db.table_('type_piece').toArray(),
    db.table_('filiere').toArray(),
    db.table_('niveau').toArray(),
  ]);
  annees.sort((a, b) => String(b['date_debut']).localeCompare(String(a['date_debut'])));
  const ordreNiveau = new Map(niveaux.map((n) => [n.id, n['ordre'] ?? 0]));
  classes.sort((a, b) => (ordreNiveau.get(a['niveau_id']) ?? 0) - (ordreNiveau.get(b['niveau_id']) ?? 0) || parLibelle('libelle')(a, b));
  const parId = new Map<string, Ligne>();
  for (const l of [...annees, ...classes, ...statuts, ...villes, ...ecoles, ...typesPiece, ...filieres, ...niveaux]) {
    parId.set(l.id, l);
  }
  return {
    annees,
    anneeActive: annees.find((a) => a['est_active']),
    classes,
    statuts: statuts.sort(parLibelle('libelle')),
    villes: villes.sort(parLibelle('libelle')),
    ecoles: ecoles.sort(parLibelle('nom')),
    typesPiece: typesPiece.sort((a, b) => Number(b['obligatoire']) - Number(a['obligatoire']) || parLibelle('libelle')(a, b)),
    filieres: filieres.sort(parLibelle('code')),
    niveaux: niveaux.sort((a, b) => (a['ordre'] ?? 0) - (b['ordre'] ?? 0)),
    parId,
  };
}

/** Réduit une image (photo d'identité) : JPEG, 800 px au plus grand côté. */
export async function reduireImage(source: Blob, cote = 800, qualite = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  const echelle = Math.min(1, cote / Math.max(bitmap.width, bitmap.height));
  const toile = document.createElement('canvas');
  toile.width = Math.round(bitmap.width * echelle);
  toile.height = Math.round(bitmap.height * echelle);
  toile.getContext('2d')!.drawImage(bitmap, 0, 0, toile.width, toile.height);
  bitmap.close();
  return new Promise((ok, ko) => toile.toBlob((b) => (b ? ok(b) : ko(new Error('Image illisible.'))), 'image/jpeg', qualite));
}

export const TAILLE_MAX_PIECE = 5 * 1024 * 1024;
export const TYPES_PIECE_ACCEPTES = 'application/pdf,image/jpeg,image/png';
