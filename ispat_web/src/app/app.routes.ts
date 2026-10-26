import { Routes } from '@angular/router';

import { anonymeGuard, connecteGuard, droitsGuard } from './core/auth/auth.guards';
import { TOUTES_ENTREES } from './core/navigation';
import { Shell } from './layout/shell';
import { AccesRefusePage, EnConstructionPage, IntrouvablePage } from './pages/pages-simples';

/** Écrans disponibles ; les autres entrées du menu affichent « en construction » (étape 12). */
const ECRANS: Record<string, Routes[number]['loadComponent']> = {
  'commercial/prospection': () => import('./pages/prospection/prospection').then((m) => m.ProspectionPage),
  'administration/utilisateurs': () => import('./pages/administration/utilisateurs').then((m) => m.UtilisateursPage),
  'administration/referentiels': () => import('./pages/administration/referentiels').then((m) => m.ReferentielsPage),
  'administration/parametres': () => import('./pages/administration/parametres').then((m) => m.ParametresPage),
  'scolarite/inscriptions': () => import('./pages/scolarite/inscriptions').then((m) => m.InscriptionsPage),
  'scolarite/liste-classe': () => import('./pages/scolarite/listes').then((m) => m.ListesScolaritePage),
  'scolarite/liste-notation': () => import('./pages/scolarite/listes').then((m) => m.ListesScolaritePage),
  'scolarite/liste-sexe': () => import('./pages/scolarite/listes').then((m) => m.ListesScolaritePage),
  'scolarite/liste-statut': () => import('./pages/scolarite/listes').then((m) => m.ListesScolaritePage),
  'comptabilite/versements': () => import('./pages/comptabilite/versements').then((m) => m.VersementsPage),
  'comptabilite/entrees': () => import('./pages/comptabilite/caisse').then((m) => m.CaissePage),
  'comptabilite/sorties': () => import('./pages/comptabilite/caisse').then((m) => m.CaissePage),
  'comptabilite/frais-annexes': () => import('./pages/comptabilite/frais-annexes').then((m) => m.FraisAnnexesPage),
  'comptabilite/prises-en-charge': () => import('./pages/comptabilite/prises-en-charge').then((m) => m.PrisesEnChargePage),
  'comptabilite/situation': () => import('./pages/comptabilite/situation').then((m) => m.SituationPage),
  'notes/saisie': () => import('./pages/notes/saisie-notes').then((m) => m.SaisieNotesPage),
  'notes/validation-examen': () => import('./pages/notes/examens').then((m) => m.ExamensPage),
  'notes/modification-examen': () => import('./pages/notes/examens').then((m) => m.ExamensPage),
  'notes/validation-moyenne': () => import('./pages/notes/moyennes').then((m) => m.MoyennesPage),
  'notes/modification-moyenne': () => import('./pages/notes/moyennes').then((m) => m.MoyennesPage),
  'bulletins/semestre-1': () => import('./pages/bulletins/bulletins').then((m) => m.BulletinsPage),
  'bulletins/semestre-2': () => import('./pages/bulletins/bulletins').then((m) => m.BulletinsPage),
  'bulletins/examen-session-1': () => import('./pages/bulletins/bulletins').then((m) => m.BulletinsPage),
  'bulletins/examen-session-2': () => import('./pages/bulletins/bulletins').then((m) => m.BulletinsPage),
  'commercial/preinscriptions': () => import('./pages/commercial/preinscriptions').then((m) => m.PreinscriptionsPage),
  'commercial/prospects': () => import('./pages/commercial/listes-prospects').then((m) => m.ListesProspectsPage),
  'commercial/inscription-prospects': () => import('./pages/commercial/inscription-prospects').then((m) => m.InscriptionProspectsPage),
  'commercial/analyse': () => import('./pages/commercial/analyse').then((m) => m.AnalysePage),
};

export const routes: Routes = [
  {
    path: 'connexion',
    canActivate: [anonymeGuard],
    title: 'Connexion — ISPAT Gestion',
    loadComponent: () => import('./pages/connexion').then((m) => m.ConnexionPage),
  },
  {
    path: '',
    component: Shell,
    canActivate: [connecteGuard],
    canActivateChild: [droitsGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'tableau-de-bord' },
      {
        path: 'tableau-de-bord',
        title: 'Tableau de bord — ISPAT Gestion',
        loadComponent: () => import('./pages/tableau-de-bord').then((m) => m.TableauDeBordPage),
      },
      {
        path: 'synchronisation',
        title: 'Synchronisation — ISPAT Gestion',
        loadComponent: () => import('./pages/synchronisation').then((m) => m.SynchronisationPage),
      },
      {
        path: 'scolarite/inscriptions/nouvelle',
        title: 'Nouvelle inscription — ISPAT Gestion',
        data: { droits: ['scolarite.inscription.creer'] },
        loadComponent: () => import('./pages/scolarite/nouvelle-inscription').then((m) => m.NouvelleInscriptionPage),
      },
      {
        path: 'scolarite/etudiants/:id',
        title: 'Dossier étudiant — ISPAT Gestion',
        data: { droits: ['scolarite.inscription.lire'] },
        loadComponent: () => import('./pages/scolarite/dossier-etudiant').then((m) => m.DossierEtudiantPage),
      },
      ...TOUTES_ENTREES.map((e) =>
        ECRANS[e.chemin]
          ? { path: e.chemin, title: `${e.libelle} — ISPAT Gestion`, data: { droits: e.droits }, loadComponent: ECRANS[e.chemin] }
          : { path: e.chemin, title: `${e.libelle} — ISPAT Gestion`, data: { droits: e.droits, titre: e.libelle }, component: EnConstructionPage },
      ),
      { path: 'acces-refuse', title: 'Accès refusé — ISPAT Gestion', component: AccesRefusePage },
      { path: '**', title: 'Page introuvable — ISPAT Gestion', component: IntrouvablePage },
    ],
  },
];
