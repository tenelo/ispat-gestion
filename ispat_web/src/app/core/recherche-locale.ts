import { Ligne, db } from './db';
import { normaliser } from './texte';

export interface ResultatEtudiant {
  etudiant: Ligne;
  classe: string | null;
  annee: string | null;
  etat: string | null;
}

/**
 * Recherche d'étudiants dans la base locale (fonctionne hors ligne).
 *   * matricule : début du matricule (« 26ATPV », « 26ATPV0012 »), sans tenir compte de la casse ;
 *   * sinon nom / prénoms, sans accents ni casse, mots dans n'importe quel ordre (« kone awa » = « Awa KONÉ »).
 */
export async function rechercherEtudiants(texte: string, limite = 20): Promise<ResultatEtudiant[]> {
  const brut = texte.trim();
  if (brut.length < 2) {
    return [];
  }
  const parMatricule = await db.table_('etudiant').where('matricule').startsWithIgnoreCase(brut.replace(/\s+/g, '')).limit(limite).toArray();
  let trouves = parMatricule;
  if (trouves.length < limite) {
    const mots = normaliser(brut).split(' ').filter(Boolean);
    const dejaVus = new Set(trouves.map((e) => e.id));
    const parNom = await db
      .table_('etudiant')
      .filter((e) => {
        if (dejaVus.has(e.id)) {
          return false;
        }
        const complet = normaliser(`${e.nom ?? ''} ${e.prenoms ?? ''} ${e.telephone ?? ''}`);
        return mots.every((m) => complet.includes(m));
      })
      .limit(limite - trouves.length)
      .toArray();
    trouves = [...trouves, ...parNom];
  }
  return Promise.all(trouves.map(completer));
}

/** Ajoute la dernière inscription connue (classe, année, état). */
async function completer(etudiant: Ligne): Promise<ResultatEtudiant> {
  const inscriptions = await db.table_('inscription').where('etudiant_id').equals(etudiant.id).toArray();
  const annees = new Map((await db.table_('annee_academique').toArray()).map((a) => [a.id, a]));
  inscriptions.sort((a, b) => String(annees.get(b.annee_id)?.date_debut ?? '').localeCompare(String(annees.get(a.annee_id)?.date_debut ?? '')));
  const derniere = inscriptions[0];
  if (!derniere) {
    return { etudiant, classe: null, annee: null, etat: null };
  }
  const classe = await db.table_('classe').get(derniere.classe_id);
  return {
    etudiant,
    classe: classe?.libelle ?? classe?.code ?? null,
    annee: annees.get(derniere.annee_id)?.libelle ?? null,
    etat: derniere.etat ?? null,
  };
}

/** Année académique active (référentiel local). */
export async function anneeActive(): Promise<Ligne | undefined> {
  return (await db.table_('annee_academique').toArray()).find((a) => a.est_active);
}
