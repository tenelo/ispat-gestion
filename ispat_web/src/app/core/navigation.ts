/**
 * Menu de l'application, par compartiment. Chaque entrée n'apparaît que si l'utilisateur a au moins
 * un des droits listés (codes « module.ressource.action » de la base ISPAT). Liste vide = tout utilisateur.
 * Les routes sont construites à partir de ce menu (app.routes.ts) : un écran = une entrée.
 */
export interface EntreeMenu {
  chemin: string;              // URL sans « / » initial
  libelle: string;
  icone: string;               // nom Material Symbols
  droits: string[];
  pret?: boolean;              // écran disponible (sinon page « en construction », étape 12)
}

export interface GroupeMenu {
  libelle: string;
  icone: string;
  entrees: EntreeMenu[];
}

export const MENU: GroupeMenu[] = [
  {
    libelle: 'Scolarité',
    icone: 'school',
    entrees: [
      { chemin: 'scolarite/inscriptions', libelle: 'Inscriptions', icone: 'how_to_reg', droits: ['scolarite.inscription.lire'], pret: true },
      { chemin: 'scolarite/liste-classe', libelle: 'Liste de classe', icone: 'groups', droits: ['scolarite.liste_classe.lire'], pret: true },
      { chemin: 'scolarite/liste-notation', libelle: 'Liste de notation', icone: 'checklist', droits: ['scolarite.liste_notation.lire'], pret: true },
      { chemin: 'scolarite/liste-sexe', libelle: 'Liste par sexe', icone: 'wc', droits: ['scolarite.liste_sexe.lire'], pret: true },
      { chemin: 'scolarite/liste-statut', libelle: 'Liste par statut', icone: 'badge', droits: ['scolarite.liste_statut.lire'], pret: true },
    ],
  },
  {
    libelle: 'Comptabilité',
    icone: 'account_balance_wallet',
    entrees: [
      { chemin: 'comptabilite/versements', libelle: 'Versements', icone: 'payments', droits: ['comptabilite.versement.lire'], pret: true },
      { chemin: 'comptabilite/entrees', libelle: 'Entrées', icone: 'south_west', droits: ['comptabilite.entree.lire'], pret: true },
      { chemin: 'comptabilite/sorties', libelle: 'Sorties', icone: 'north_east', droits: ['comptabilite.sortie.lire'], pret: true },
      { chemin: 'comptabilite/frais-annexes', libelle: 'Frais annexes', icone: 'receipt_long', droits: ['comptabilite.frais_annexe.lire'], pret: true },
      { chemin: 'comptabilite/prises-en-charge', libelle: 'Prises en charge', icone: 'volunteer_activism', droits: ['comptabilite.prise_en_charge.lire'], pret: true },
      { chemin: 'comptabilite/situation', libelle: 'Situation financière', icone: 'account_balance', droits: ['comptabilite.situation.lire'], pret: true },
    ],
  },
  {
    libelle: 'Notes et moyennes',
    icone: 'grading',
    entrees: [
      { chemin: 'notes/saisie', libelle: 'Saisie des notes', icone: 'edit_note', droits: ['moyenne.note.lire'], pret: true },
      { chemin: 'notes/validation-examen', libelle: 'Validation des notes d\'examen', icone: 'task_alt', droits: ['moyenne.validation_note_examen.lire'], pret: true },
      { chemin: 'notes/validation-moyenne', libelle: 'Validation des moyennes', icone: 'verified', droits: ['moyenne.validation_moyenne.lire'], pret: true },
      { chemin: 'notes/modification-examen', libelle: 'Modification des notes d\'examen', icone: 'edit', droits: ['moyenne.modification_note_examen.lire'], pret: true },
      { chemin: 'notes/modification-moyenne', libelle: 'Modification des moyennes', icone: 'tune', droits: ['moyenne.modification_moyenne.lire'], pret: true },
    ],
  },
  {
    libelle: 'Bulletins',
    icone: 'description',
    entrees: [
      { chemin: 'bulletins/semestre-1', libelle: 'Bulletin semestre 1', icone: 'looks_one', droits: ['bulletin.semestre1.lire'], pret: true },
      { chemin: 'bulletins/semestre-2', libelle: 'Bulletin semestre 2', icone: 'looks_two', droits: ['bulletin.semestre2.lire'], pret: true },
      { chemin: 'bulletins/examen-session-1', libelle: 'Notes d\'examen session 1', icone: 'article', droits: ['bulletin.examen_session1.lire'], pret: true },
      { chemin: 'bulletins/examen-session-2', libelle: 'Notes d\'examen session 2', icone: 'article', droits: ['bulletin.examen_session2.lire'], pret: true },
    ],
  },
  {
    libelle: 'Gestion commerciale',
    icone: 'campaign',
    entrees: [
      { chemin: 'commercial/prospection', libelle: 'Prospection', icone: 'person_search', droits: ['commercial.prospection.lire'], pret: true },
      { chemin: 'commercial/preinscriptions', libelle: 'Pré-inscriptions', icone: 'assignment_ind', droits: ['commercial.preinscription.lire'], pret: true },
      { chemin: 'commercial/prospects', libelle: 'Listes des prospects', icone: 'filter_list', droits: ['commercial.liste_prospect.lire'], pret: true },
      { chemin: 'commercial/inscription-prospects', libelle: 'Inscription des prospects', icone: 'person_add', droits: ['commercial.inscription_prospect.lire'], pret: true },
      { chemin: 'commercial/analyse', libelle: 'Analyse', icone: 'monitoring', droits: ['commercial.analyse.lire'], pret: true },
    ],
  },
  {
    libelle: 'Administration',
    icone: 'admin_panel_settings',
    entrees: [
      { chemin: 'administration/utilisateurs', libelle: 'Utilisateurs et rôles', icone: 'manage_accounts', droits: ['administration.utilisateur.lire'], pret: true },
      { chemin: 'administration/referentiels', libelle: 'Référentiels', icone: 'category', droits: ['administration.referentiel.creer', 'administration.referentiel.modifier'], pret: true },
      { chemin: 'administration/parametres', libelle: 'Paramètres', icone: 'settings', droits: ['administration.parametre.lire'], pret: true },
    ],
  },
];

export const TOUTES_ENTREES: EntreeMenu[] = MENU.flatMap((g) => g.entrees);
