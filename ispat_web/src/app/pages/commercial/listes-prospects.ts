import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, resource, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { db } from '../../core/db';
import { ReseauService } from '../../core/reseau.service';
import { telecharger } from '../../shared/telecharger';

const STATUTS: Record<string, string> = { NOUVEAU: 'Nouveau', CONTACTE: 'Contacté', PREINSCRIT: 'Pré-inscrit', INSCRIT: 'Inscrit', PERDU: 'Perdu' };

/** Listes des prospects regroupées par ville, école, genre, filière souhaitée ou statut (+ export). */
@Component({
  selector: 'app-listes-prospects',
  imports: [MatButtonToggleModule, MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule, MatProgressBarModule, DatePipe],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Listes des prospects</h1>
          <p class="sous-titre">Regroupement au choix ; chaque groupe indique les filles, pré-inscrits et inscrits. Connexion nécessaire.</p>
        </div>
        @if (peutExporter()) {
          <button mat-stroked-button (click)="exporter()" [disabled]="!reseau.enLigne()" data-test="export-prospects"><mat-icon>download</mat-icon> Excel</button>
        }
      </div>
      @if (!reseau.enLigne()) {
        <p class="carte vide">Connexion nécessaire. Hors ligne, la liste simple reste disponible dans Prospection.</p>
      } @else {
        <section class="carte filtres">
          <mat-button-toggle-group [value]="groupe()" (change)="groupe.set($event.value)" data-test="groupe-prospects">
            <mat-button-toggle value="ville">Ville</mat-button-toggle>
            <mat-button-toggle value="ecole">École</mat-button-toggle>
            <mat-button-toggle value="genre">Genre</mat-button-toggle>
            <mat-button-toggle value="filiere">Filière</mat-button-toggle>
            <mat-button-toggle value="statut">Statut</mat-button-toggle>
          </mat-button-toggle-group>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Campagne</mat-label>
            <mat-select [value]="campagne()" (selectionChange)="campagne.set($event.value)">
              <mat-option value="">Toutes (année active)</mat-option>
              @for (c of campagnes.value() ?? []; track c.id) { <mat-option [value]="c.id">{{ c['libelle'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Statut</mat-label>
            <mat-select [value]="statut()" (selectionChange)="statut.set($event.value)">
              <mat-option value="">Tous</mat-option>
              @for (s of statuts; track s[0]) { <mat-option [value]="s[0]">{{ s[1] }}</mat-option> }
            </mat-select>
          </mat-form-field>
        </section>
        @if (chargement()) { <mat-progress-bar mode="indeterminate" /> }
        @if (donnees(); as d) {
          <p class="texte-secondaire">{{ d.total }} prospect(s) · {{ d.groupes.length }} groupe(s)</p>
          @for (g of d.groupes; track g.libelle) {
            <section class="carte groupe" data-test="groupe">
              <h2>{{ g.libelle }} <span class="texte-secondaire">{{ g.effectif }} prospect(s) · {{ g.filles }} fille(s) · {{ g.preinscrits }} pré-inscrit(s) · {{ g.inscrits }} inscrit(s)</span></h2>
              <div class="defilement-horizontal">
                <table class="tableau compact">
                  <thead><tr><th>Nom et prénoms</th><th>Sexe</th><th>Téléphone</th><th>Ville / école</th><th>Filière</th><th>Contact</th><th>Agent</th><th>Statut</th></tr></thead>
                  <tbody>
                    @for (p of g.prospects; track p.id) {
                      <tr>
                        <td><strong>{{ p.nom }}</strong> {{ p.prenoms }}</td><td>{{ p.sexe }}</td><td>{{ p.telephone ?? '—' }}</td>
                        <td>{{ p.ville_libelle ?? '—' }}<div class="texte-secondaire">{{ p.ecole_libelle ?? '' }}</div></td>
                        <td>{{ p.filiere_souhaitee_code ?? '—' }}</td><td>{{ p.date_contact | date: 'dd/MM/yyyy' }}</td><td>{{ p.agent_nom ?? '—' }}</td>
                        <td><span class="pastille" [class.neutre]="p.statut === 'PERDU'">{{ libelle[p.statut] }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          } @empty { <p class="carte vide">Aucun prospect.</p> }
        }
      }
    </div>
  `,
  styleUrl: './commercial.scss',
})
export class ListesProspectsPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);
  readonly statuts = Object.entries(STATUTS);
  readonly libelle = STATUTS;
  readonly peutExporter = computed(() => this.auth.peut('commercial.liste_prospect.exporter'));

  readonly groupe = signal('ville');
  readonly campagne = signal('');
  readonly statut = signal('');
  readonly donnees = signal<any | null>(null);
  readonly chargement = signal(false);

  readonly campagnes = resource({ loader: () => db.table_('campagne_prospection').toArray() });

  constructor() {
    effect(() => {
      const p = { g: this.groupe(), c: this.campagne(), s: this.statut(), enLigne: this.reseau.enLigne() };
      untracked(() => p.enLigne && void this.charger());
    });
  }

  private params() {
    return { groupe: this.groupe(), campagne: this.campagne(), annee: this.campagne() ? '' : 'active', statut: this.statut() };
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      this.donnees.set(await this.api.get('/api/commercial/prospects/liste/', this.params()));
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  async exporter(): Promise<void> {
    try {
      const f = await this.api.fichier('/api/commercial/prospects/liste/', { ...this.params(), export: 'xlsx' });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }
}
