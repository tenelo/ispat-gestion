import { Ligne, db } from './db';

/** Libellés et calculs financiers locaux (mêmes règles que comptabilite/calculs.py côté serveur). */

export const MODES_PAIEMENT: [string, string][] = [
  ['ESPECES', 'Espèces'], ['MOBILE_MONEY', 'Mobile Money'], ['VIREMENT', 'Virement'], ['CHEQUE', 'Chèque'], ['AUTRE', 'Autre'],
];
export const MODES_AVEC_REFERENCE = ['MOBILE_MONEY', 'VIREMENT', 'CHEQUE'];
export const TYPES_PAYEUR: [string, string][] = [
  ['ETAT', 'État'], ['ENTREPRISE', 'Entreprise'], ['ONG', 'ONG'], ['BOURSE', 'Bourse'], ['PARENT_TIERS', 'Parent / tiers'], ['AUTRE', 'Autre'],
];
export const STATUTS_PEC: [string, string][] = [['ACTIVE', 'Active'], ['SUSPENDUE', 'Suspendue'], ['ANNULEE', 'Annulée']];
export const CATEGORIES_FRAIS: Record<string, string> = { INSCRIPTION: 'Inscription', SCOLARITE: 'Scolarité', ANNEXE: 'Frais annexe' };

const FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
export function fcfa(v: number | string | null | undefined): string {
  return `${FORMAT.format(Number(v ?? 0))} FCFA`;
}

export function libelleMode(code: string): string {
  return MODES_PAIEMENT.find((m) => m[0] === code)?.[1] ?? code;
}

export interface LigneFrais {
  fraisId: string;
  typeFraisId: string;
  libelle: string;
  categorie: string;
  du: number;
  verse: number;
  reste: number;
}

export interface PecLocale {
  id: string;
  organisme: string;
  typeFraisId: string | null;
  montant: number;
  verse: number;
  reste: number;
}

export interface SituationLocale {
  frais: LigneFrais[];
  prises: PecLocale[];
  totalDu: number;
  partPec: number;
  verseEtudiant: number;
  versePec: number;
  resteEtudiant: number;
  restePec: number;
  versements: Ligne[];
}

/** Situation financière d'une inscription à partir des données du poste (versements en attente compris). */
export async function situationLocale(inscriptionId: string): Promise<SituationLocale> {
  const [frais, versements, pecs, typesFrais] = await Promise.all([
    db.table_('frais_inscription').where('inscription_id').equals(inscriptionId).toArray(),
    db.table_('versement').where('inscription_id').equals(inscriptionId).toArray(),
    db.table_('prise_en_charge').where('inscription_id').equals(inscriptionId).toArray(),
    db.table_('type_frais').toArray(),
  ]);
  const types = new Map(typesFrais.map((t) => [t.id, t]));
  const valides = versements.filter((v) => !v['annule']);
  const n = (x: any) => Number(x ?? 0);

  const lignes: LigneFrais[] = frais.map((f) => {
    const du = n(f['montant']) - n(f['remise']);
    const verse = valides.filter((v) => v['type_frais_id'] === f['type_frais_id']).reduce((s, v) => s + n(v['montant']), 0);
    const t = types.get(f['type_frais_id']);
    return { fraisId: f.id, typeFraisId: f['type_frais_id'], libelle: t?.['libelle'] ?? '—', categorie: t?.['categorie'] ?? '',
      du, verse, reste: Math.max(du - verse, 0) };
  }).sort((a, b) => a.categorie.localeCompare(b.categorie) || a.libelle.localeCompare(b.libelle, 'fr'));

  const prises: PecLocale[] = pecs.filter((p) => p['statut'] === 'ACTIVE').map((p) => {
    const verse = valides.filter((v) => v['prise_en_charge_id'] === p.id).reduce((s, v) => s + n(v['montant']), 0);
    return { id: p.id, organisme: p['organisme'], typeFraisId: p['type_frais_id'] ?? null, montant: n(p['montant']), verse,
      reste: Math.max(n(p['montant']) - verse, 0) };
  });

  const totalDu = lignes.reduce((s, l) => s + l.du, 0);
  const partPec = Math.min(prises.reduce((s, p) => s + p.montant, 0), totalDu);
  const verseEtudiant = valides.filter((v) => v['payeur'] !== 'PRISE_EN_CHARGE').reduce((s, v) => s + n(v['montant']), 0);
  const versePec = valides.filter((v) => v['payeur'] === 'PRISE_EN_CHARGE').reduce((s, v) => s + n(v['montant']), 0);
  versements.sort((a, b) => String(b['date_versement']).localeCompare(String(a['date_versement'])));
  return {
    frais: lignes, prises, totalDu, partPec, verseEtudiant, versePec,
    resteEtudiant: Math.max(totalDu - partPec - verseEtudiant, 0),
    restePec: Math.max(partPec - versePec, 0),
    versements,
  };
}
