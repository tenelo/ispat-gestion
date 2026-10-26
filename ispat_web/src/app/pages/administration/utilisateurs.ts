import { Component, computed, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';

import { ApiService } from '../../core/api.service';
import { AuthService, LIBELLES_ROLES } from '../../core/auth/auth.service';
import { choisir } from '../../shared/choix';
import { confirmer } from '../../shared/confirmation';
import { Descripteur } from '../../shared/crud/crud';
import { TableCrud } from '../../shared/crud/table-crud';
import { RolesDroits } from './roles-droits';

const ROLES: [string, string][] = Object.entries(LIBELLES_ROLES);
const DROITS_UTILISATEURS = {
  creer: ['administration.utilisateur.creer'],
  modifier: ['administration.utilisateur.modifier'],
  supprimer: ['administration.utilisateur.supprimer'],
};

/** Comptes des utilisateurs et droits de chaque rôle. */
@Component({
  selector: 'app-utilisateurs',
  imports: [MatTabsModule, TableCrud, RolesDroits],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Utilisateurs et rôles</h1>
          <p class="sous-titre">Chaque utilisateur reçoit un ou plusieurs rôles ; chaque rôle ouvre des compartiments de l'application.</p>
        </div>
      </div>
      <mat-tab-group class="carte onglets" animationDuration="0ms" mat-stretch-tabs="false">
        <mat-tab label="Utilisateurs">
          <div class="onglet"><app-table-crud [descripteur]="descripteur" /></div>
        </mat-tab>
        @if (peutVoirRoles()) {
          <mat-tab label="Droits des rôles">
            <div class="onglet"><app-roles-droits /></div>
          </mat-tab>
        }
      </mat-tab-group>
    </div>
  `,
  styles: `
    .large { max-width: 1400px; }
    .onglets { padding: 0; }
    .onglet { padding: 20px; }
  `,
})
export class UtilisateursPage {
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly auth = inject(AuthService);

  readonly peutVoirRoles = computed(() => this.auth.peut(['administration.role.lire']));

  readonly descripteur: Descripteur = {
    code: 'utilisateurs', titre: 'Comptes', singulier: 'un utilisateur', chemin: '/api/utilisateurs/',
    droits: DROITS_UTILISATEURS,
    aide: 'Identifiant sans espace. Mot de passe : 8 caractères minimum, pas uniquement des chiffres. '
      + 'Un compte désactivé ne peut plus se connecter (ses saisies restent dans l\'historique).',
    filtres: [
      { cle: 'role', libelle: 'Rôle', choix: ROLES },
      { cle: 'actif', libelle: 'État', choix: [['true', 'Actifs'], ['false', 'Désactivés']] },
    ],
    colonnes: [
      { libelle: 'Identifiant', cle: 'login', type: 'code' },
      { libelle: 'Nom et prénoms', valeur: (u) => `${u.nom} ${u.prenoms}` },
      { libelle: 'Rôles', valeur: (u) => (u.roles as string[]).map((r) => LIBELLES_ROLES[r] ?? r).join(', ') },
      { libelle: 'Téléphone', cle: 'telephone' },
      { libelle: 'Dernière connexion', cle: 'derniere_connexion', type: 'date' },
      { libelle: 'État', type: 'pastille', pastille: (u) => (u.actif ? { texte: 'Actif' } : { texte: 'Désactivé', classe: 'alerte' }) },
    ],
    champs: [
      { cle: 'login', libelle: 'Identifiant', type: 'texte', obligatoire: true, creationSeulement: true },
      { cle: 'mot_de_passe', libelle: 'Mot de passe initial', type: 'motdepasse', obligatoire: true, lectureSeule: false, creationSeulement: true,
        aide: 'À communiquer à l\'utilisateur ; il pourra le changer.' },
      { cle: 'nom', libelle: 'Nom', type: 'texte', obligatoire: true, majuscules: true },
      { cle: 'prenoms', libelle: 'Prénoms', type: 'texte', obligatoire: true },
      { cle: 'email', libelle: 'E-mail', type: 'texte' },
      { cle: 'telephone', libelle: 'Téléphone', type: 'texte' },
      { cle: 'roles', libelle: 'Rôles', type: 'multichoix', choix: ROLES, obligatoire: true },
    ],
    preparer: (d, ligne) => {
      if (ligne) {
        delete d['mot_de_passe'];
        delete d['login'];
      }
      return d;
    },
    tri: (a, b) => Number(b.actif) - Number(a.actif) || `${a.nom} ${a.prenoms}`.localeCompare(`${b.nom} ${b.prenoms}`, 'fr'),
    actions: [
      {
        libelle: 'Réinitialiser le mot de passe', icone: 'key', droits: DROITS_UTILISATEURS.modifier,
        executer: async (u) => {
          const mdp = await choisir(this.dialog, {
            titre: `Mot de passe de ${u.prenoms} ${u.nom}`,
            message: 'Saisir le nouveau mot de passe et le communiquer à l\'utilisateur.',
            libelle: 'Nouveau mot de passe', type: 'password', minimum: 8, confirmer: 'Réinitialiser',
          });
          if (!mdp) {
            return false;
          }
          await this.api.post(`/api/utilisateurs/${u.id}/mot-de-passe/`, { mot_de_passe: mdp });
          this.snack.open('Mot de passe réinitialisé.', 'OK', { duration: 3000 });
          return false;
        },
      },
      {
        libelle: 'Désactiver le compte', icone: 'block', droits: DROITS_UTILISATEURS.modifier,
        visible: (u) => u.actif && u.id !== this.auth.utilisateur()?.id,
        executer: async (u) => {
          const ok = await confirmer(this.dialog, {
            titre: 'Désactiver le compte',
            message: `${u.prenoms} ${u.nom} ne pourra plus se connecter. Le compte pourra être réactivé.`,
            confirmer: 'Désactiver', danger: true,
          });
          if (!ok) {
            return false;
          }
          await this.api.patch(`/api/utilisateurs/${u.id}/`, { actif: false });
          return true;
        },
      },
      {
        libelle: 'Réactiver le compte', icone: 'check_circle', droits: DROITS_UTILISATEURS.modifier,
        visible: (u) => !u.actif,
        executer: async (u) => {
          await this.api.patch(`/api/utilisateurs/${u.id}/`, { actif: true });
          return true;
        },
      },
    ],
  };
}
