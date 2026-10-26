import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ApiService } from '../../core/api.service';
import { Descripteur, ReferenceChamp } from '../../shared/crud/crud';
import { choisir } from '../../shared/choix';

const R = '/api/referentiels/';
const REF = {
  creer: ['administration.referentiel.creer'],
  modifier: ['administration.referentiel.modifier'],
  supprimer: ['administration.referentiel.supprimer'],
};

const annees: ReferenceChamp = { chemin: `${R}annees/`, libelle: (a) => a.libelle + (a.est_active ? ' (active)' : '') };
const anneesFiltre: ReferenceChamp = { ...annees, valeur: (a) => (a.est_active ? 'active' : a.id) };
const filieres: ReferenceChamp = { chemin: `${R}filieres/`, params: { active: true }, libelle: (f) => `${f.code} — ${f.libelle}` };
const niveaux: ReferenceChamp = { chemin: `${R}niveaux/`, libelle: (n) => `${n.code} — ${n.libelle}` };
const classesActives: ReferenceChamp = { chemin: `${R}classes/`, params: { annee: 'active' }, libelle: (c) => c.libelle };
const enseignants: ReferenceChamp = { chemin: `${R}enseignants/`, libelle: (e) => `${e.nom} ${e.prenoms}` };
const villes: ReferenceChamp = { chemin: `${R}villes/`, libelle: (v) => v.libelle };
const statuts: ReferenceChamp = { chemin: `${R}statuts-etudiant/`, libelle: (s) => s.libelle };
const typesFrais: ReferenceChamp = { chemin: `${R}types-frais/`, libelle: (t) => t.libelle };

const SEXE: [string, string][] = [['F', 'Féminin'], ['M', 'Masculin']];
const SEMESTRES: [number, string][] = [[1, 'Semestre 1'], [2, 'Semestre 2']];
const parCode = (a: any, b: any) => String(a.code).localeCompare(String(b.code), 'fr');
const parLibelle = (a: any, b: any) => String(a.libelle).localeCompare(String(b.libelle), 'fr');

export interface GroupeReferentiels {
  libelle: string;
  descripteurs: Descripteur[];
}

/** Référentiels de l'établissement, regroupés comme dans le menu de l'écran. */
export function descripteursReferentiels(api: ApiService, dialog: MatDialog, snack: MatSnackBar): GroupeReferentiels[] {
  return [
    {
      libelle: 'Calendrier',
      descripteurs: [
        {
          code: 'annees', titre: 'Années académiques', singulier: 'une année académique', feminin: true,
          chemin: `${R}annees/`, droits: REF,
          aide: 'Les semestres 1 et 2 sont créés automatiquement avec l\'année. Une seule année est active à la fois.',
          colonnes: [
            { libelle: 'Année', cle: 'libelle', type: 'code' },
            { libelle: 'Début', cle: 'date_debut', type: 'date' },
            { libelle: 'Fin', cle: 'date_fin', type: 'date' },
            { libelle: 'État', type: 'pastille', pastille: (a) => (a.est_active ? { texte: 'Active' } : { texte: 'Inactive', classe: 'neutre' }) },
          ],
          champs: [
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true, aide: 'Ex. 2026-2027' },
            { cle: 'date_debut', libelle: 'Date de début', type: 'date', obligatoire: true },
            { cle: 'date_fin', libelle: 'Date de fin', type: 'date', obligatoire: true },
            { cle: 'est_active', libelle: 'Rendre active dès la création', type: 'booleen', creationSeulement: true },
          ],
          tri: (a, b) => String(b.date_debut).localeCompare(String(a.date_debut)),
          actions: [
            {
              libelle: 'Rendre active', icone: 'task_alt', droits: REF.modifier, visible: (a) => !a.est_active,
              executer: async (a) => {
                await api.post(`${R}annees/${a.id}/activer/`);
                snack.open(`Année ${a.libelle} active.`, 'OK', { duration: 3000 });
                return true;
              },
            },
            {
              libelle: 'Recopier les classes et tarifs d\'une autre année', icone: 'content_copy', droits: REF.creer,
              executer: async (a) => {
                const autres = (await api.lister(`${R}annees/`)).filter((x) => x.id !== a.id);
                const source = await choisir(dialog, {
                  titre: `Préparer ${a.libelle}`,
                  message: 'Les classes et le barème des frais de l\'année choisie sont recopiés (sans doublon).',
                  libelle: 'Année source', options: autres.map((x) => [x.id, x.libelle]), confirmer: 'Recopier',
                });
                if (!source) {
                  return false;
                }
                const r = await api.post(`${R}annees/${a.id}/copier-structure/`, { source });
                snack.open(`${r.classes_copiees} classe(s) et ${r.tarifs_copies} tarif(s) recopiés.`, 'OK', { duration: 5000 });
                return true;
              },
            },
          ],
        },
        {
          code: 'semestres', titre: 'Semestres', singulier: 'un semestre', chemin: `${R}semestres/`, droits: REF,
          creation: false, suppression: false,
          aide: 'Un semestre clôturé n\'accepte plus de modification de notes.',
          filtres: [{ cle: 'annee', libelle: 'Année', reference: anneesFiltre, defaut: 'active' }],
          colonnes: [
            { libelle: 'Année', cle: 'annee_libelle' },
            { libelle: 'Semestre', valeur: (s) => `Semestre ${s.numero}` },
            { libelle: 'Début', cle: 'date_debut', type: 'date' },
            { libelle: 'Fin', cle: 'date_fin', type: 'date' },
            { libelle: 'Clôturé', cle: 'cloture', type: 'booleen' },
          ],
          champs: [
            { cle: 'date_debut', libelle: 'Date de début', type: 'date' },
            { cle: 'date_fin', libelle: 'Date de fin', type: 'date' },
            { cle: 'cloture', libelle: 'Semestre clôturé', type: 'booleen' },
          ],
          tri: (a, b) => String(b.annee_libelle).localeCompare(String(a.annee_libelle)) || a.numero - b.numero,
        },
      ],
    },
    {
      libelle: 'Offre de formation',
      descripteurs: [
        {
          code: 'filieres', titre: 'Filières', singulier: 'une filière', feminin: true, chemin: `${R}filieres/`, droits: REF,
          aide: 'Le code entre dans le matricule des étudiants (ex. 26ATPV0001) : ne plus le changer une fois des étudiants inscrits.',
          colonnes: [
            { libelle: 'Code', cle: 'code', type: 'code' },
            { libelle: 'Libellé', cle: 'libelle' },
            { libelle: 'Active', cle: 'active', type: 'booleen' },
          ],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true, aide: '2 à 5 lettres ou chiffres' },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
            { cle: 'description', libelle: 'Description', type: 'zone' },
            { cle: 'active', libelle: 'Filière ouverte', type: 'booleen', defaut: true },
          ],
          tri: parCode,
        },
        {
          code: 'niveaux', titre: 'Niveaux', singulier: 'un niveau', chemin: `${R}niveaux/`, droits: REF,
          colonnes: [
            { libelle: 'Code', cle: 'code', type: 'code' },
            { libelle: 'Libellé', cle: 'libelle' },
            { libelle: 'Ordre', cle: 'ordre', type: 'nombre' },
          ],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
            { cle: 'ordre', libelle: 'Ordre d\'affichage', type: 'nombre', obligatoire: true, min: 1 },
          ],
          tri: (a, b) => a.ordre - b.ordre,
        },
        {
          code: 'classes', titre: 'Classes', singulier: 'une classe', feminin: true, chemin: `${R}classes/`, droits: REF,
          filtres: [
            { cle: 'annee', libelle: 'Année', reference: anneesFiltre, defaut: 'active' },
            { cle: 'filiere', libelle: 'Filière', reference: filieres },
            { cle: 'niveau', libelle: 'Niveau', reference: niveaux },
          ],
          colonnes: [
            { libelle: 'Classe', cle: 'libelle' },
            { libelle: 'Filière', cle: 'filiere_code', type: 'code' },
            { libelle: 'Niveau', cle: 'niveau_code' },
            { libelle: 'Groupe', cle: 'groupe' },
            { libelle: 'Capacité', cle: 'capacite', type: 'nombre' },
            { libelle: 'Année', cle: 'annee_libelle' },
          ],
          champs: [
            { cle: 'annee', libelle: 'Année académique', type: 'reference', reference: annees, obligatoire: true },
            { cle: 'filiere', libelle: 'Filière', type: 'reference', reference: filieres, obligatoire: true },
            { cle: 'niveau', libelle: 'Niveau', type: 'reference', reference: niveaux, obligatoire: true },
            { cle: 'groupe', libelle: 'Groupe', type: 'texte', majuscules: true, aide: 'Facultatif : A, B… si plusieurs classes' },
            { cle: 'capacite', libelle: 'Capacité', type: 'nombre', min: 1 },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', aide: 'Vide = automatique (ex. BTS1 Agriculture …)' },
          ],
          preparer: (d) => {
            if (!d['libelle']) {
              delete d['libelle'];          // libellé calculé par le serveur
            }
            return d;
          },
          tri: parLibelle,
        },
        {
          code: 'matieres', titre: 'Matières', singulier: 'une matière', feminin: true, chemin: `${R}matieres/`, droits: REF,
          filtres: [
            { cle: 'filiere', libelle: 'Filière', reference: filieres },
            { cle: 'niveau', libelle: 'Niveau', reference: niveaux },
            { cle: 'semestre', libelle: 'Semestre', choix: [['1', 'Semestre 1'], ['2', 'Semestre 2']] },
          ],
          colonnes: [
            { libelle: 'Code', cle: 'code', type: 'code' },
            { libelle: 'Matière', cle: 'libelle' },
            { libelle: 'Filière', cle: 'filiere_libelle' },
            { libelle: 'Niveau', cle: 'niveau_code' },
            { libelle: 'Sem.', cle: 'semestre_numero' },
            { libelle: 'Coef.', cle: 'coefficient', type: 'nombre' },
            { libelle: 'Crédits', cle: 'credits', type: 'nombre' },
          ],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
            { cle: 'filiere', libelle: 'Filière', type: 'reference', reference: filieres, obligatoire: true },
            { cle: 'niveau', libelle: 'Niveau', type: 'reference', reference: niveaux, obligatoire: true },
            { cle: 'semestre_numero', libelle: 'Semestre', type: 'choix', choix: SEMESTRES, obligatoire: true },
            { cle: 'coefficient', libelle: 'Coefficient', type: 'nombre', defaut: 1, min: 0.01 },
            { cle: 'credits', libelle: 'Crédits', type: 'nombre', min: 0, max: 60 },
            { cle: 'volume_horaire', libelle: 'Volume horaire (h)', type: 'nombre', min: 0 },
          ],
          tri: parCode,
        },
      ],
    },
    {
      libelle: 'Enseignants',
      descripteurs: [
        {
          code: 'enseignants', titre: 'Enseignants', singulier: 'un enseignant', chemin: `${R}enseignants/`, droits: REF,
          aide: 'Pour qu\'un enseignant saisisse ses notes, créer son compte (rôle Enseignant) dans Utilisateurs, puis le lier ici.',
          filtres: [{ cle: 'type_contrat', libelle: 'Contrat', choix: [['PERMANENT', 'Permanent'], ['VACATAIRE', 'Vacataire']] }],
          colonnes: [
            { libelle: 'Nom', valeur: (e) => `${e.nom} ${e.prenoms}` },
            { libelle: 'Spécialité', cle: 'specialite' },
            { libelle: 'Téléphone', cle: 'telephone' },
            { libelle: 'Contrat', valeur: (e) => ({ PERMANENT: 'Permanent', VACATAIRE: 'Vacataire' } as any)[e.type_contrat] ?? '' },
            { libelle: 'Compte', cle: 'utilisateur_login', type: 'code' },
          ],
          champs: [
            { cle: 'nom', libelle: 'Nom', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'prenoms', libelle: 'Prénoms', type: 'texte', obligatoire: true },
            { cle: 'sexe', libelle: 'Sexe', type: 'choix', choix: SEXE },
            { cle: 'telephone', libelle: 'Téléphone', type: 'texte' },
            { cle: 'email', libelle: 'E-mail', type: 'texte' },
            { cle: 'specialite', libelle: 'Spécialité', type: 'texte' },
            { cle: 'type_contrat', libelle: 'Contrat', type: 'choix', choix: [['PERMANENT', 'Permanent'], ['VACATAIRE', 'Vacataire']] },
            {
              cle: 'utilisateur', libelle: 'Compte utilisateur (saisie des notes)', type: 'reference',
              reference: { chemin: '/api/utilisateurs/', params: { role: 'ENSEIGNANT', actif: true }, libelle: (u) => `${u.nom} ${u.prenoms} (${u.login})` },
            },
          ],
          tri: (a, b) => `${a.nom} ${a.prenoms}`.localeCompare(`${b.nom} ${b.prenoms}`, 'fr'),
        },
        {
          code: 'enseignements', titre: 'Attribution des cours', singulier: 'une attribution', feminin: true,
          chemin: `${R}enseignements/`, droits: REF,
          aide: 'Qui enseigne quelle matière, dans quelle classe, quel semestre. L\'enseignant ne voit que ces classes.',
          filtres: [
            { cle: 'annee', libelle: 'Année', reference: anneesFiltre, defaut: 'active' },
            { cle: 'classe', libelle: 'Classe', reference: classesActives },
            { cle: 'enseignant', libelle: 'Enseignant', reference: enseignants },
          ],
          colonnes: [
            { libelle: 'Classe', cle: 'classe_libelle' },
            { libelle: 'Matière', cle: 'matiere_libelle' },
            { libelle: 'Sem.', cle: 'semestre_numero' },
            { libelle: 'Enseignant', cle: 'enseignant_nom' },
          ],
          champs: [
            { cle: 'classe', libelle: 'Classe (année active)', type: 'reference', reference: classesActives, obligatoire: true },
            {
              cle: 'matiere', libelle: 'Matière', type: 'reference', obligatoire: true,
              reference: { chemin: `${R}matieres/`, libelle: (m) => `${m.code} — ${m.libelle} (${m.niveau_code} ${m.filiere_libelle}, S${m.semestre_numero})` },
            },
            {
              cle: 'semestre', libelle: 'Semestre', type: 'reference', obligatoire: true,
              reference: { chemin: `${R}semestres/`, params: { annee: 'active' }, libelle: (s) => `Semestre ${s.numero} — ${s.annee_libelle}` },
            },
            { cle: 'enseignant', libelle: 'Enseignant', type: 'reference', reference: enseignants, obligatoire: true },
          ],
          tri: (a, b) => String(a.classe_libelle).localeCompare(String(b.classe_libelle), 'fr') || a.semestre_numero - b.semestre_numero,
        },
      ],
    },
    {
      libelle: 'Listes de valeurs',
      descripteurs: [
        {
          code: 'statuts', titre: 'Statuts des étudiants', singulier: 'un statut', chemin: `${R}statuts-etudiant/`, droits: REF,
          colonnes: [{ libelle: 'Code', cle: 'code', type: 'code' }, { libelle: 'Libellé', cle: 'libelle' }],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
          ],
          tri: parCode,
        },
        {
          code: 'pieces', titre: 'Pièces du dossier', singulier: 'un type de pièce', chemin: `${R}types-piece/`, droits: REF,
          aide: 'Pièces obligatoires : leur absence est signalée à la validation de l\'inscription.',
          colonnes: [
            { libelle: 'Code', cle: 'code', type: 'code' },
            { libelle: 'Libellé', cle: 'libelle' },
            { libelle: 'Obligatoire', cle: 'obligatoire', type: 'booleen' },
          ],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
            { cle: 'obligatoire', libelle: 'Pièce obligatoire', type: 'booleen' },
          ],
          tri: parCode,
        },
        {
          code: 'villes', titre: 'Villes', singulier: 'une ville', feminin: true, chemin: `${R}villes/`, droits: REF,
          colonnes: [{ libelle: 'Ville', cle: 'libelle' }, { libelle: 'Région', cle: 'region' }],
          champs: [
            { cle: 'libelle', libelle: 'Ville', type: 'texte', obligatoire: true },
            { cle: 'region', libelle: 'Région', type: 'texte' },
          ],
          tri: parLibelle,
        },
        {
          code: 'ecoles', titre: 'Écoles d\'origine', singulier: 'une école', feminin: true, chemin: `${R}ecoles/`, droits: REF,
          aide: 'Lycées et collèges d\'origine (prospection, inscriptions). Les écoles saisies par les commerciaux s\'ajoutent ici.',
          filtres: [{ cle: 'ville', libelle: 'Ville', reference: villes }],
          colonnes: [
            { libelle: 'École', cle: 'nom' },
            { libelle: 'Ville', cle: 'ville_libelle' },
            { libelle: 'Type', valeur: (e) => ({ LYCEE: 'Lycée', COLLEGE: 'Collège', UNIVERSITE: 'Université', AUTRE: 'Autre' } as any)[e.type_ecole] ?? '' },
          ],
          champs: [
            { cle: 'nom', libelle: 'Nom', type: 'texte', obligatoire: true, pleineLargeur: true },
            { cle: 'ville', libelle: 'Ville', type: 'reference', reference: villes },
            { cle: 'type_ecole', libelle: 'Type', type: 'choix', choix: [['LYCEE', 'Lycée'], ['COLLEGE', 'Collège'], ['UNIVERSITE', 'Université'], ['AUTRE', 'Autre']] },
          ],
          tri: (a, b) => String(a.nom).localeCompare(String(b.nom), 'fr'),
        },
      ],
    },
    {
      libelle: 'Finances',
      descripteurs: [
        {
          code: 'types_frais', titre: 'Types de frais', singulier: 'un type de frais', chemin: `${R}types-frais/`,
          droits: { creer: ['comptabilite.frais_annexe.creer'], modifier: ['comptabilite.frais_annexe.modifier'], supprimer: ['comptabilite.frais_annexe.supprimer'] },
          colonnes: [
            { libelle: 'Code', cle: 'code', type: 'code' },
            { libelle: 'Libellé', cle: 'libelle' },
            { libelle: 'Catégorie', valeur: (t) => ({ INSCRIPTION: 'Inscription', SCOLARITE: 'Scolarité', ANNEXE: 'Frais annexe' } as any)[t.categorie] },
            { libelle: 'Obligatoire', cle: 'obligatoire', type: 'booleen' },
          ],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
            { cle: 'categorie', libelle: 'Catégorie', type: 'choix', obligatoire: true, choix: [['INSCRIPTION', 'Inscription'], ['SCOLARITE', 'Scolarité'], ['ANNEXE', 'Frais annexe']] },
            { cle: 'obligatoire', libelle: 'Facturé à tous les inscrits', type: 'booleen' },
          ],
          tri: parCode,
        },
        {
          code: 'tarifs', titre: 'Barème des frais', singulier: 'un tarif', chemin: `${R}tarifs/`,
          droits: { creer: ['comptabilite.tarif.creer'], modifier: ['comptabilite.tarif.modifier'], supprimer: ['comptabilite.tarif.supprimer'] },
          aide: 'Filière, niveau ou statut vides = tarif valable pour tous. Le tarif le plus précis s\'applique à la validation de l\'inscription.',
          filtres: [
            { cle: 'annee', libelle: 'Année', reference: anneesFiltre, defaut: 'active' },
            { cle: 'type_frais', libelle: 'Frais', reference: typesFrais },
          ],
          colonnes: [
            { libelle: 'Frais', cle: 'type_frais_libelle' },
            { libelle: 'Filière', valeur: (t) => t.filiere_libelle ?? 'Toutes' },
            { libelle: 'Niveau', valeur: (t) => t.niveau_code ?? 'Tous' },
            { libelle: 'Statut', valeur: (t) => t.statut_etudiant_libelle ?? 'Tous' },
            { libelle: 'Montant (FCFA)', cle: 'montant', type: 'nombre' },
            { libelle: 'Tranches', cle: 'nb_tranches', type: 'nombre' },
          ],
          champs: [
            { cle: 'annee', libelle: 'Année académique', type: 'reference', reference: annees, obligatoire: true },
            { cle: 'type_frais', libelle: 'Type de frais', type: 'reference', reference: typesFrais, obligatoire: true },
            { cle: 'filiere', libelle: 'Filière', type: 'reference', reference: filieres },
            { cle: 'niveau', libelle: 'Niveau', type: 'reference', reference: niveaux },
            { cle: 'statut_etudiant', libelle: 'Statut de l\'étudiant', type: 'reference', reference: statuts },
            { cle: 'montant', libelle: 'Montant (FCFA)', type: 'nombre', obligatoire: true, min: 0 },
            { cle: 'nb_tranches', libelle: 'Nombre de tranches', type: 'nombre', defaut: 1, min: 1, max: 12 },
          ],
          tri: (a, b) => String(a.type_frais_libelle).localeCompare(String(b.type_frais_libelle), 'fr'),
        },
        {
          code: 'categories', titre: 'Catégories de caisse', singulier: 'une catégorie', feminin: true, chemin: `${R}categories-mouvement/`,
          droits: {
            creer: ['administration.referentiel.creer', 'comptabilite.entree.creer'],
            modifier: ['administration.referentiel.modifier', 'comptabilite.entree.modifier'],
            supprimer: ['administration.referentiel.supprimer', 'comptabilite.entree.supprimer'],
          },
          filtres: [{ cle: 'sens', libelle: 'Sens', choix: [['ENTREE', 'Entrées'], ['SORTIE', 'Sorties']] }],
          colonnes: [
            { libelle: 'Code', cle: 'code', type: 'code' },
            { libelle: 'Libellé', cle: 'libelle' },
            { libelle: 'Sens', type: 'pastille', pastille: (c) => (c.sens === 'ENTREE' ? { texte: 'Entrée' } : { texte: 'Sortie', classe: 'attente' }) },
          ],
          champs: [
            { cle: 'code', libelle: 'Code', type: 'texte', obligatoire: true, majuscules: true },
            { cle: 'libelle', libelle: 'Libellé', type: 'texte', obligatoire: true },
            { cle: 'sens', libelle: 'Sens', type: 'choix', obligatoire: true, choix: [['ENTREE', 'Entrée'], ['SORTIE', 'Sortie']] },
          ],
          tri: (a, b) => a.sens.localeCompare(b.sens) || parCode(a, b),
        },
      ],
    },
  ];
}
