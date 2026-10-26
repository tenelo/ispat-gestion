import { Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';

interface Role {
  id: string;
  code: string;
  libelle: string;
  description: string | null;
  permissions: string[];
  nb_utilisateurs: number;
  modifiable: boolean;
}

interface Permission {
  code: string;
  module: string;
  ressource: string;
  action: string;
  libelle: string;
}

interface LigneMatrice {
  module: string;
  ressource: string;
  libelle: string;
  codes: Record<string, string>;     // action -> code de permission
}

const MODULES: Record<string, string> = {
  administration: 'Administration',
  scolarite: 'Scolarité',
  comptabilite: 'Comptabilité',
  moyenne: 'Notes et moyennes',
  bulletin: 'Bulletins',
  commercial: 'Gestion commerciale',
};
const ACTIONS: [string, string][] = [
  ['lire', 'Consulter'], ['creer', 'Créer'], ['modifier', 'Modifier'], ['supprimer', 'Supprimer'],
  ['valider', 'Valider'], ['exporter', 'Exporter'],
];

/** Matrice des droits d'un rôle (cases à cocher par écran et par action). */
@Component({
  selector: 'app-roles-droits',
  imports: [MatButtonModule, MatCheckboxModule, MatIconModule, MatProgressBarModule],
  template: `
    @if (chargement()) { <mat-progress-bar mode="indeterminate" /> }
    @if (erreur()) { <p class="erreur-formulaire">{{ erreur() }}</p> }
    <div class="roles" data-test="liste-roles">
      @for (r of roles(); track r.id) {
        <button type="button" class="role" [class.actif]="r.id === roleId()" (click)="selectionner(r)" [attr.data-test]="'role-' + r.code">
          <strong>{{ r.libelle }}</strong>
          <span>{{ r.nb_utilisateurs }} utilisateur(s) · {{ r.permissions.length }} droit(s)</span>
        </button>
      }
    </div>

    @if (role(); as r) {
      <div class="entete-role">
        <div>
          <h2>{{ r.libelle }}</h2>
          <p class="texte-secondaire">{{ r.description }}</p>
        </div>
        @if (r.modifiable && peutModifier()) {
          <div class="boutons">
            <button mat-button (click)="annuler()" [disabled]="!modifie()">Annuler</button>
            <button mat-flat-button (click)="enregistrer()" [disabled]="!modifie() || envoi()" data-test="enregistrer-droits">
              <mat-icon>save</mat-icon> Enregistrer les droits
            </button>
          </div>
        }
      </div>
      @if (!r.modifiable) {
        <p class="info"><mat-icon>info</mat-icon> L'administrateur a toujours tous les droits.</p>
      } @else if (modifie()) {
        <p class="info attente"><mat-icon>edit</mat-icon> Modifications non enregistrées. Elles s'appliqueront à {{ r.nb_utilisateurs }} utilisateur(s) dès leur prochaine synchronisation.</p>
      }
      <div class="defilement-horizontal">
        <table class="tableau matrice" data-test="matrice-droits">
          <thead>
            <tr>
              <th>Écran / donnée</th>
              @for (a of actions; track a[0]) { <th class="centre">{{ a[1] }}</th> }
            </tr>
          </thead>
          <tbody>
            @for (m of modules(); track m.module) {
              <tr class="ligne-module"><td [attr.colspan]="actions.length + 1">{{ m.libelle }}</td></tr>
              @for (l of m.lignes; track l.ressource) {
                <tr>
                  <td>{{ l.libelle }}</td>
                  @for (a of actions; track a[0]) {
                    <td class="centre">
                      @if (l.codes[a[0]]; as code) {
                        <mat-checkbox [checked]="selection().has(code)" (change)="basculer(code, $event.checked)"
                                      [disabled]="!r.modifiable || !peutModifier()" [attr.data-test]="'droit-' + code" />
                      }
                    </td>
                  }
                </tr>
              }
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: `
    .roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; margin-bottom: 20px; }
    .role {
      display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 12px 14px; cursor: pointer;
      border: 1px solid #e3e9e6; border-radius: 10px; background: #fff; font: inherit;
    }
    .role span { font-size: 0.8rem; color: #5d6f68; }
    .role.actif { border-color: var(--ispat-vert); background: var(--ispat-vert-clair); box-shadow: inset 3px 0 0 var(--ispat-orange); }
    .entete-role { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
    .entete-role h2 { margin: 0; }
    .entete-role p { margin: 4px 0 0; }
    .boutons { display: flex; gap: 8px; }
    .info { display: flex; gap: 8px; align-items: center; background: var(--ispat-vert-clair); color: var(--ispat-vert); padding: 8px 12px; border-radius: 8px; }
    .info.attente { background: var(--ispat-orange-clair); color: #7a3b04; }
    .info mat-icon { font-size: 18px; width: 18px; height: 18px; }
    .centre { text-align: center !important; }
    .matrice td, .matrice th { padding: 4px 10px; }
    .ligne-module td { background: #f2f6f4; font-weight: 700; color: var(--ispat-vert-fonce); padding: 8px 10px; }
  `,
})
export class RolesDroits {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);

  readonly actions = ACTIONS;
  readonly roles = signal<Role[]>([]);
  readonly permissions = signal<Permission[]>([]);
  readonly roleId = signal<string | null>(null);
  readonly selection = signal<Set<string>>(new Set());
  readonly chargement = signal(false);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly peutModifier = computed(() => this.auth.peut('administration.role.modifier'));

  readonly role = computed(() => this.roles().find((r) => r.id === this.roleId()) ?? null);
  readonly modifie = computed(() => {
    const r = this.role();
    if (!r) {
      return false;
    }
    const s = this.selection();
    return s.size !== r.permissions.length || r.permissions.some((c) => !s.has(c));
  });

  readonly modules = computed(() => {
    const lignes = new Map<string, LigneMatrice>();
    for (const p of this.permissions()) {
      const cle = `${p.module}.${p.ressource}`;
      if (!lignes.has(cle)) {
        lignes.set(cle, { module: p.module, ressource: p.ressource, libelle: p.libelle.split(' : ')[0], codes: {} });
      }
      lignes.get(cle)!.codes[p.action] = p.code;
    }
    return Object.entries(MODULES)
      .map(([module, libelle]) => ({ module, libelle, lignes: [...lignes.values()].filter((l) => l.module === module) }))
      .filter((m) => m.lignes.length);
  });

  constructor() {
    void this.charger();
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      const [roles, permissions] = await Promise.all([
        this.api.get<Role[]>('/api/roles/'),
        this.api.get<Permission[]>('/api/permissions/'),
      ]);
      this.roles.set(roles);
      this.permissions.set(permissions);
      const actuel = roles.find((r) => r.id === this.roleId()) ?? roles.find((r) => r.modifiable) ?? roles[0];
      if (actuel) {
        this.selectionner(actuel);
      }
    } catch (e) {
      this.erreur.set((e as ErreurApi).message);
    } finally {
      this.chargement.set(false);
    }
  }

  selectionner(r: Role): void {
    this.roleId.set(r.id);
    this.selection.set(new Set(r.permissions));
  }

  basculer(code: string, coche: boolean): void {
    const s = new Set(this.selection());
    if (coche) {
      s.add(code);
      // Agir sans consulter n'a pas de sens : « lire » est coché avec toute autre action.
      const lecture = code.replace(/\.[a-z_]+$/, '.lire');
      if (this.permissions().some((p) => p.code === lecture)) {
        s.add(lecture);
      }
    } else {
      s.delete(code);
    }
    this.selection.set(s);
  }

  annuler(): void {
    const r = this.role();
    if (r) {
      this.selectionner(r);
    }
  }

  async enregistrer(): Promise<void> {
    const r = this.role();
    if (!r) {
      return;
    }
    this.envoi.set(true);
    try {
      const maj = await this.api.put<Role>(`/api/roles/${r.id}/permissions/`, { permissions: [...this.selection()].sort() });
      this.roles.update((liste) => liste.map((x) => (x.id === maj.id ? maj : x)));
      this.selectionner(maj);
      this.snack.open(`Droits du rôle ${maj.libelle} enregistrés.`, 'OK', { duration: 3000 });
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    } finally {
      this.envoi.set(false);
    }
  }
}
