import { Component, computed, effect, inject, resource, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
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

const AXES: [string, string][] = [
  ['par_ville', 'Par ville'], ['par_ecole', 'Par école'], ['par_genre', 'Par genre'], ['par_filiere', 'Par filière souhaitée'],
  ['par_source', 'Par source'], ['par_agent', 'Par agent'],
];

/** Analyse de la prospection : taux de pré-inscription, d'inscription, de conversion ; par ville, école, genre… */
@Component({
  selector: 'app-analyse',
  imports: [MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule, MatProgressBarModule],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Analyse de la prospection</h1>
          <p class="sous-titre">{{ donnees()?.perimetre ?? '' }} — taux calculés sur les prospects (connexion nécessaire).</p>
        </div>
        @if (peutExporter()) {
          <button mat-stroked-button (click)="exporter()" [disabled]="!reseau.enLigne()"><mat-icon>download</mat-icon> Excel</button>
        }
      </div>
      @if (!reseau.enLigne()) {
        <p class="carte vide">Connexion nécessaire pour l'analyse.</p>
      } @else {
        <section class="carte filtres">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Campagne</mat-label>
            <mat-select [value]="campagne()" (selectionChange)="campagne.set($event.value)" data-test="an-campagne">
              <mat-option value="">Année active</mat-option>
              @for (c of campagnes.value() ?? []; track c.id) { <mat-option [value]="c.id">{{ c['libelle'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Contacts du</mat-label>
            <input matInput type="date" [value]="du()" (change)="du.set($any($event.target).value)" />
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>au</mat-label>
            <input matInput type="date" [value]="au()" (change)="au.set($any($event.target).value)" />
          </mat-form-field>
        </section>
        @if (chargement()) { <mat-progress-bar mode="indeterminate" /> }
        @if (donnees(); as d) {
          <section class="indicateurs" data-test="indicateurs-analyse">
            <div class="carte"><span>Prospects</span><strong data-test="an-prospects">{{ d.global.prospects }}</strong></div>
            <div class="carte"><span>Contactés</span><strong>{{ d.global.contactes }}</strong></div>
            <div class="carte"><span>Pré-inscrits</span><strong>{{ d.global.preinscrits }}</strong></div>
            <div class="carte"><span>Inscrits</span><strong data-test="an-inscrits">{{ d.global.inscrits }}</strong></div>
            <div class="carte accent"><span>Taux de pré-inscription</span><strong data-test="an-taux-pre">{{ pct(d.global.taux_preinscription) }}</strong></div>
            <div class="carte accent"><span>Taux de prospects inscrits</span><strong data-test="an-taux-ins">{{ pct(d.global.taux_inscription) }}</strong></div>
            <div class="carte"><span>Conversion pré-inscrits → inscrits</span><strong>{{ pct(d.global.taux_conversion) }}</strong></div>
            @if (d.campagne?.objectif) {
              <div class="carte"><span>Objectif ({{ d.campagne.objectif }} inscrits)</span><strong>{{ pct(d.campagne.taux_objectif) }}</strong></div>
            }
          </section>
          @if (d.preinscriptions; as p) {
            <section class="carte groupe">
              <h2>Pré-inscriptions {{ p.annee }} <span class="texte-secondaire">site web, guichet, prospection</span></h2>
              <div class="indicateurs">
                <div class="carte"><span>Reçues</span><strong>{{ p.total }}</strong></div>
                <div class="carte"><span>En attente</span><strong>{{ p.en_attente }}</strong></div>
                <div class="carte"><span>Dossiers acceptés</span><strong>{{ p.dossiers_acceptes }}</strong></div>
                <div class="carte"><span>Inscrites</span><strong>{{ p.inscrites }}</strong></div>
                <div class="carte"><span>Rejetées</span><strong>{{ p.rejetees }}</strong></div>
                <div class="carte accent"><span>Transformation</span><strong>{{ pct(p.taux_transformation) }}</strong></div>
              </div>
            </section>
          }
          <div class="axes">
            @for (a of axes; track a[0]) {
              <section class="carte" [attr.data-test]="a[0]">
                <h2>{{ a[1] }}</h2>
                <div class="defilement-horizontal">
                <table class="tableau compact">
                  <thead><tr><th></th><th class="nb">Prosp.</th><th class="nb">Pré-ins.</th><th class="nb">Inscrits</th><th class="nb">Taux pré-ins.</th><th class="nb">Taux ins.</th></tr></thead>
                  <tbody>
                    @for (l of d[a[0]]; track l.modalite) {
                      <tr>
                        <td>{{ l.modalite ?? '—' }}</td><td class="nb">{{ l.prospects }}</td><td class="nb">{{ l.preinscrits }}</td><td class="nb">{{ l.inscrits }}</td>
                        <td><div class="taux"><div class="barre orange"><div [style.width.%]="l.taux_preinscription ?? 0"></div></div>{{ pct(l.taux_preinscription) }}</div></td>
                        <td><div class="taux"><div class="barre"><div [style.width.%]="l.taux_inscription ?? 0"></div></div>{{ pct(l.taux_inscription) }}</div></td>
                      </tr>
                    } @empty { <tr><td colspan="6" class="vide">Aucune donnée.</td></tr> }
                  </tbody>
                </table>
                </div>
              </section>
            }
          </div>
        }
      }
    </div>
  `,
  styleUrl: './commercial.scss',
})
export class AnalysePage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);
  readonly axes = AXES;
  readonly peutExporter = computed(() => this.auth.peut('commercial.analyse.exporter'));

  readonly campagne = signal('');
  readonly du = signal('');
  readonly au = signal('');
  readonly donnees = signal<any | null>(null);
  readonly chargement = signal(false);
  readonly campagnes = resource({ loader: () => db.table_('campagne_prospection').toArray() });

  constructor() {
    effect(() => {
      const p = { c: this.campagne(), du: this.du(), au: this.au(), enLigne: this.reseau.enLigne() };
      untracked(() => p.enLigne && void this.charger());
    });
  }

  pct(v: number | null | undefined): string {
    return v === null || v === undefined ? '—' : `${String(v).replace('.', ',')} %`;
  }

  private params() {
    return { campagne: this.campagne(), annee: this.campagne() ? '' : 'active', du: this.du(), au: this.au() };
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      this.donnees.set(await this.api.get('/api/commercial/analyse/', this.params()));
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  async exporter(): Promise<void> {
    try {
      const f = await this.api.fichier('/api/commercial/analyse/', { ...this.params(), export: 'xlsx' });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }
}
