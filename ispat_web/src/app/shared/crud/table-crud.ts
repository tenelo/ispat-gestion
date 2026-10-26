import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { normaliser } from '../../core/texte';
import { confirmer } from '../confirmation';
import { ColonneCrud, Descripteur, ReferenceChamp } from './crud';
import { FormulaireCrud } from './formulaire-crud';

/** Liste administrable : recherche, filtres, ajout, modification, suppression, actions. Nécessite la connexion. */
@Component({
  selector: 'app-table-crud',
  imports: [MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatProgressBarModule, MatTooltipModule, DatePipe, DecimalPipe],
  template: `
    <div class="entete">
      <div>
        <h2>{{ d().titre }}</h2>
        <span class="texte-secondaire">{{ filtrees().length }} élément(s)</span>
      </div>
      @if (peutCreer()) {
        <button mat-flat-button (click)="ouvrir(null)" [disabled]="!reseau.enLigne()" data-test="crud-ajouter">
          <mat-icon>add</mat-icon> Ajouter
        </button>
      }
    </div>
    @if (d().aide) {
      <p class="texte-secondaire aide">{{ d().aide }}</p>
    }
    @if (!reseau.enLigne()) {
      <p class="hors-ligne"><mat-icon>wifi_off</mat-icon> Connexion nécessaire pour consulter et modifier ce référentiel.</p>
    }

    <div class="filtres">
      <mat-form-field appearance="outline" subscriptSizing="dynamic" class="recherche">
        <mat-icon matPrefix>search</mat-icon>
        <mat-label>Rechercher</mat-label>
        <input matInput [value]="texte()" (input)="texte.set($any($event.target).value)" data-test="crud-recherche" />
      </mat-form-field>
      @for (fl of d().filtres ?? []; track fl.cle) {
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>{{ fl.libelle }}</mat-label>
          <mat-select [value]="valeursFiltres()[fl.cle] ?? ''" (selectionChange)="changerFiltre(fl.cle, $event.value)"
                      [attr.data-test]="'filtre-' + fl.cle">
            <mat-option value="">Tous</mat-option>
            @for (o of fl.choix ?? optionsFiltres()[fl.cle] ?? []; track o[0]) {
              <mat-option [value]="o[0]">{{ o[1] }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }
    </div>

    @if (chargement()) { <mat-progress-bar mode="indeterminate" /> }
    @if (erreur()) { <p class="erreur-formulaire">{{ erreur() }}</p> }

    <div class="defilement-horizontal">
      <table class="tableau" [attr.data-test]="'crud-' + d().code">
        <thead>
          <tr>
            @for (c of d().colonnes; track c.libelle) { <th>{{ c.libelle }}</th> }
            <th class="actions-col"></th>
          </tr>
        </thead>
        <tbody>
          @for (l of filtrees(); track l.id) {
            <tr>
              @for (c of d().colonnes; track c.libelle) {
                <td [class.code]="c.type === 'code'" [class.nombre]="c.type === 'nombre'">
                  @switch (c.type) {
                    @case ('booleen') {
                      @if (valeur(c, l)) { <mat-icon class="oui">check_circle</mat-icon> } @else { <span class="texte-secondaire">—</span> }
                    }
                    @case ('date') { {{ $any(valeur(c, l)) | date: 'dd/MM/yyyy' }} }
                    @case ('nombre') { {{ $any(valeur(c, l)) | number: '1.0-2' : 'fr' }} }
                    @case ('pastille') {
                      @if (c.pastille?.(l); as p) { <span class="pastille" [class]="p.classe ?? ''">{{ p.texte }}</span> }
                    }
                    @default { {{ valeur(c, l) ?? '—' }} }
                  }
                </td>
              }
              <td class="actions-col">
                @for (a of actionsVisibles(l); track a.libelle) {
                  <button mat-icon-button [matTooltip]="a.libelle" (click)="executer(a, l)" [disabled]="!reseau.enLigne()"
                          [attr.data-test]="'action-' + a.icone">
                    <mat-icon>{{ a.icone }}</mat-icon>
                  </button>
                }
                @if (peutModifier()) {
                  <button mat-icon-button matTooltip="Modifier" (click)="ouvrir(l)" [disabled]="!reseau.enLigne()" data-test="crud-modifier">
                    <mat-icon>edit</mat-icon>
                  </button>
                }
                @if (peutSupprimer()) {
                  <button mat-icon-button matTooltip="Supprimer" (click)="supprimer(l)" [disabled]="!reseau.enLigne()" data-test="crud-supprimer">
                    <mat-icon>delete</mat-icon>
                  </button>
                }
              </td>
            </tr>
          } @empty {
            @if (!chargement()) {
              <tr><td [attr.colspan]="d().colonnes.length + 1" class="vide">Aucun élément.</td></tr>
            }
          }
        </tbody>
      </table>
    </div>
  `,
  styles: `
    :host { display: block; }
    .entete { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
    .entete h2 { margin: 0; }
    .aide { margin: 8px 0 0; }
    .filtres { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0 12px; }
    .recherche { flex: 2 1 220px; }
    .filtres mat-form-field { flex: 1 1 170px; }
    .actions-col { text-align: right; white-space: nowrap; width: 1%; }
    .code { font-family: ui-monospace, Consolas, monospace; font-weight: 600; color: var(--ispat-vert); }
    .nombre { text-align: right; font-variant-numeric: tabular-nums; }
    .oui { color: var(--ispat-vert); font-size: 20px; width: 20px; height: 20px; }
    .hors-ligne { display: flex; gap: 8px; align-items: center; background: var(--ispat-orange-clair); color: #7a3b04; padding: 8px 12px; border-radius: 8px; }
  `,
})
export class TableCrud {
  readonly d = input.required<Descripteur>({ alias: 'descripteur' });

  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly sync = inject(SyncService);
  readonly reseau = inject(ReseauService);

  readonly lignes = signal<any[]>([]);
  readonly chargement = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly texte = signal('');
  readonly valeursFiltres = signal<Record<string, string>>({});
  readonly optionsFiltres = signal<Record<string, [any, string][]>>({});
  private optionsChamps: Record<string, [any, string][]> = {};

  readonly peutCreer = computed(() => this.d().creation !== false && this.auth.peut(this.d().droits.creer));
  readonly peutModifier = computed(() => this.d().champs.length > 0 && this.auth.peut(this.d().droits.modifier));
  readonly peutSupprimer = computed(() => this.d().suppression !== false && this.auth.peut(this.d().droits.supprimer));

  readonly filtrees = computed(() => {
    const mots = normaliser(this.texte()).split(' ').filter(Boolean);
    const liste = this.lignes().filter((l) => {
      if (!mots.length) {
        return true;
      }
      const t = normaliser(this.d().colonnes.map((c) => String(this.valeur(c, l) ?? '')).join(' '));
      return mots.every((m) => t.includes(m));
    });
    return this.d().tri ? [...liste].sort(this.d().tri) : liste;
  });

  constructor() {
    // Changement de descripteur (autre référentiel) : filtres par défaut, options, liste.
    effect(() => {
      const d = this.d();
      untracked(() => {
        const defauts: Record<string, string> = {};
        for (const fl of d.filtres ?? []) {
          if (fl.defaut) {
            defauts[fl.cle] = fl.defaut;
          }
        }
        this.texte.set('');
        this.valeursFiltres.set(defauts);
        this.lignes.set([]);
        this.optionsChamps = {};
        void this.chargerOptionsFiltres(d);
        void this.charger();
      });
    });
    inject(DestroyRef).onDestroy(this.reseau.quandEnLigne(() => void this.charger()));
  }

  valeur(c: ColonneCrud, l: any): any {
    return c.valeur ? c.valeur(l) : c.cle ? l[c.cle] : null;
  }

  actionsVisibles(l: any) {
    return (this.d().actions ?? []).filter((a) => this.auth.peut(a.droits) && (!a.visible || a.visible(l)));
  }

  changerFiltre(cle: string, valeur: string): void {
    this.valeursFiltres.update((v) => ({ ...v, [cle]: valeur }));
    void this.charger();
  }

  async charger(): Promise<void> {
    if (!this.reseau.enLigne()) {
      return;
    }
    const d = this.d();
    this.chargement.set(true);
    this.erreur.set(null);
    try {
      const lignes = await this.api.lister(d.chemin, this.valeursFiltres());
      if (d === this.d()) {
        this.lignes.set(lignes);
      }
    } catch (e) {
      this.erreur.set((e as ErreurApi).message);
    } finally {
      this.chargement.set(false);
    }
  }

  private async options(ref: ReferenceChamp): Promise<[any, string][]> {
    const lignes = await this.api.lister(ref.chemin, ref.params ?? {});
    return lignes.map((l) => [ref.valeur ? ref.valeur(l) : l.id, ref.libelle(l)] as [any, string]);
  }

  private async chargerOptionsFiltres(d: Descripteur): Promise<void> {
    const res: Record<string, [any, string][]> = {};
    for (const fl of d.filtres ?? []) {
      if (fl.reference && this.reseau.enLigne()) {
        res[fl.cle] = await this.options(fl.reference).catch(() => []);
      }
    }
    this.optionsFiltres.set(res);
  }

  private async chargerOptionsChamps(): Promise<void> {
    for (const c of this.d().champs) {
      if (c.reference && !this.optionsChamps[c.cle]) {
        this.optionsChamps[c.cle] = await this.options(c.reference);
      }
    }
  }

  async ouvrir(ligne: any | null): Promise<void> {
    try {
      await this.chargerOptionsChamps();
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
      return;
    }
    const ref = this.dialog.open(FormulaireCrud, {
      data: { descripteur: this.d(), ligne, options: this.optionsChamps },
      width: '720px',
      maxWidth: '96vw',
    });
    ref.afterClosed().subscribe((r) => {
      if (r) {
        this.snack.open(ligne ? 'Modification enregistrée.' : 'Ajout enregistré.', 'OK', { duration: 3000 });
        this.apresChangement();
      }
    });
  }

  async supprimer(l: any): Promise<void> {
    const libelle = this.d().colonnes.slice(0, 2).map((c) => this.valeur(c, l)).filter(Boolean).join(' — ');
    const ok = await confirmer(this.dialog, {
      titre: `Supprimer ${this.d().singulier}`,
      message: `« ${libelle} » sera supprimé. Une suppression est refusée si l'élément est encore utilisé.`,
      confirmer: 'Supprimer',
      danger: true,
    });
    if (!ok) {
      return;
    }
    try {
      await this.api.supprimer(`${this.d().chemin}${l.id}/`);
      this.snack.open('Suppression effectuée.', 'OK', { duration: 3000 });
      this.apresChangement();
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 7000 });
    }
  }

  async executer(a: { executer: (l: any) => Promise<boolean | void> }, l: any): Promise<void> {
    try {
      if (await a.executer(l)) {
        this.apresChangement();
      }
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 7000 });
    }
  }

  private apresChangement(): void {
    this.optionsChamps = {};
    void this.charger();
    this.sync.planifier(500);      // copie hors ligne des référentiels mise à jour
  }
}
