import { Ligne, db } from './db';

/** Notes et moyennes : libellés, format des notes, cours accessibles (mêmes règles que notes/portee.py). */

export const TYPES_EVALUATION: [string, string][] = [
  ['DEVOIR', 'Devoir'], ['INTERROGATION', 'Interrogation'], ['TP', 'Travaux pratiques'], ['EXPOSE', 'Exposé'], ['EXAMEN', 'Examen'],
];
export const LIBELLES_TYPE: Record<string, string> = Object.fromEntries(TYPES_EVALUATION);
export const DECISIONS: [string, string][] = [['ADMIS', 'Admis'], ['SESSION2', 'Session 2'], ['AJOURNE', 'Ajourné']];
export const LIBELLES_DECISION: Record<string, string> = Object.fromEntries(DECISIONS);

const ROLES_PORTEE_COMPLETE = ['ADMIN', 'DIRECTION', 'DIRECTEUR_ETUDES', 'SCOLARITE'];

/** « 12,5 » → 12.5 ; vide → null ; hors de 0..20 ou illisible → NaN. */
export function lireNote(texte: string | null | undefined): number | null {
  const t = String(texte ?? '').trim().replace(',', '.');
  if (!t) {
    return null;
  }
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= 20 && /^\d{1,2}(\.\d{1,2})?$/.test(t) ? n : NaN;
}

export function ecrireNote(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') {
    return '';
  }
  return Number(v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

export function libelleEvaluation(e: Ligne): string {
  const session = e['type_eval'] === 'EXAMEN' && Number(e['session']) === 2 ? ' (2e session)' : '';
  return `${e['libelle']}${session}`;
}

export interface Cours {
  cle: string;
  classe: Ligne;
  semestre: Ligne;
  matiere: Ligne;
}

/**
 * Cours accessibles sur ce poste : un enseignant (sans rôle de portée complète) voit ses attributions ;
 * les autres voient toutes les matières des classes de l'année active.
 */
export async function coursAccessibles(roles: string[], utilisateurId: string | undefined): Promise<Cours[]> {
  const [annees, classes, semestres, matieres, enseignements, enseignants] = await Promise.all([
    db.table_('annee_academique').toArray(),
    db.table_('classe').toArray(),
    db.table_('semestre').toArray(),
    db.table_('matiere').toArray(),
    db.table_('enseignement').toArray(),
    db.table_('enseignant').toArray(),
  ]);
  const active = annees.find((a) => a['est_active']);
  if (!active) {
    return [];
  }
  const parId = new Map([...classes, ...semestres, ...matieres].map((x) => [x.id, x]));
  const semestresAnnee = semestres.filter((s) => s['annee_id'] === active.id);
  let cours: Cours[];
  if (roles.some((r) => ROLES_PORTEE_COMPLETE.includes(r))) {
    cours = [];
    for (const c of classes.filter((x) => x['annee_id'] === active.id)) {
      for (const s of semestresAnnee) {
        for (const m of matieres.filter((x) => x['filiere_id'] === c['filiere_id'] && x['niveau_id'] === c['niveau_id']
          && Number(x['semestre_numero']) === Number(s['numero']))) {
          cours.push({ cle: `${c.id}|${s.id}|${m.id}`, classe: c, semestre: s, matiere: m });
        }
      }
    }
  } else {
    const moi = new Set(enseignants.filter((e) => e['utilisateur_id'] === utilisateurId).map((e) => e.id));
    cours = enseignements
      .filter((e) => moi.has(e['enseignant_id']) && parId.get(e['classe_id'])?.['annee_id'] === active.id)
      .map((e) => ({ cle: `${e['classe_id']}|${e['semestre_id']}|${e['matiere_id']}`, classe: parId.get(e['classe_id'])!,
        semestre: parId.get(e['semestre_id'])!, matiere: parId.get(e['matiere_id'])! }))
      .filter((c) => c.classe && c.semestre && c.matiere);
  }
  return cours.sort((a, b) => String(a.classe['libelle']).localeCompare(String(b.classe['libelle']), 'fr')
    || Number(a.semestre['numero']) - Number(b.semestre['numero']) || String(a.matiere['code']).localeCompare(String(b.matiere['code'])));
}

/** Seuil de validation (paramètre local, 10 par défaut). */
export async function seuilValidation(): Promise<number> {
  const p = (await db.table_('parametre').toArray()).find((x) => x['cle'] === 'seuil_validation');
  return p ? Number(p['valeur']) : 10;
}

const CHAMPS_HISTORIQUE: Record<string, string> = {
  valeur: 'Note', absent: 'Absent', moyenne_finale: 'Moyenne', moyenne: 'Moyenne du semestre', decision: 'Décision',
  appreciation: 'Appréciation', statut: 'Statut', credits_acquis: 'Crédits',
};

/** Historique : nom de champ et valeur lisibles (« 9.4 » → « 9,4 », « ADMIS » → « Admis »). */
export function libelleChamp(champ: string): string {
  return CHAMPS_HISTORIQUE[champ] ?? champ;
}

export function valeurHistorique(v: string | null | undefined): string {
  if (v === null || v === undefined || v === '') {
    return '—';
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    return ecrireNote(v);
  }
  return LIBELLES_DECISION[v] ?? (v === 'true' ? 'Oui' : v === 'false' ? 'Non' : v);
}
