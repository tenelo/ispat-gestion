import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';

interface Parametre {
  cle: string;
  valeur: string;
  description: string | null;
}

const LIBELLES: Record<string, string> = {
  nom_etablissement: 'Nom de l\'établissement',
  ville_etablissement: 'Ville',
  devise: 'Devise',
  seuil_validation: 'Moyenne de validation (sur 20)',
  regle_session2: 'Règle de la 2e session',
};

/** Paramètres généraux : identité de l'établissement et règles de calcul des moyennes. */
@Component({
  selector: 'app-parametres',
  imports: [FormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule,
    MatProgressBarModule],
  template: `
    <div class="page">
      <div class="page-entete">
        <div>
          <h1>Paramètres</h1>
          <p class="sous-titre">Identité de l'établissement (bulletins, reçus) et règles de calcul des moyennes.</p>
        </div>
        @if (peutModifier()) {
          <button mat-flat-button (click)="enregistrer()" [disabled]="!modifie() || envoi() || !reseau.enLigne()" data-test="enregistrer-parametres">
            <mat-icon>save</mat-icon> Enregistrer
          </button>
        }
      </div>
      @if (chargement()) { <mat-progress-bar mode="indeterminate" /> }
      @if (erreur()) { <p class="erreur-formulaire" data-test="erreur-parametres">{{ erreur() }}</p> }
      @if (!reseau.enLigne()) { <p class="erreur-formulaire">Connexion nécessaire pour modifier les paramètres.</p> }

      <section class="carte bloc">
        <h2>Établissement</h2>
        <div class="grille-formulaire">
          @for (cle of ['nom_etablissement', 'ville_etablissement', 'devise']; track cle) {
            <mat-form-field appearance="outline" [class.pleine-largeur]="cle === 'nom_etablissement'">
              <mat-label>{{ libelle(cle) }}</mat-label>
              <input matInput [ngModel]="valeurs()[cle]" (ngModelChange)="changer(cle, $event)" [disabled]="!peutModifier()"
                     [attr.data-test]="'param-' + cle" />
              @if (description(cle)) { <mat-hint>{{ description(cle) }}</mat-hint> }
            </mat-form-field>
          }
        </div>
      </section>

      <section class="carte bloc">
        <h2>Calcul des moyennes</h2>
        <div class="grille-formulaire">
          <mat-form-field appearance="outline">
            <mat-label>Poids du contrôle continu</mat-label>
            <input matInput type="number" step="0.05" min="0" max="1" [ngModel]="valeurs()['poids_cc']"
                   (ngModelChange)="changerPoids('poids_cc', $event)" [disabled]="!peutModifier()" data-test="param-poids_cc" />
            <mat-hint>{{ pourcent('poids_cc') }} de la moyenne matière</mat-hint>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Poids de l'examen</mat-label>
            <input matInput type="number" step="0.05" min="0" max="1" [ngModel]="valeurs()['poids_examen']"
                   (ngModelChange)="changerPoids('poids_examen', $event)" [disabled]="!peutModifier()" data-test="param-poids_examen" />
            <mat-hint>{{ pourcent('poids_examen') }} de la moyenne matière</mat-hint>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>{{ libelle('seuil_validation') }}</mat-label>
            <input matInput type="number" step="0.25" min="0" max="20" [ngModel]="valeurs()['seuil_validation']"
                   (ngModelChange)="changer('seuil_validation', $event)" [disabled]="!peutModifier()" data-test="param-seuil_validation" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>{{ libelle('regle_session2') }}</mat-label>
            <mat-select [ngModel]="valeurs()['regle_session2']" (ngModelChange)="changer('regle_session2', $event)" [disabled]="!peutModifier()">
              <mat-option value="REMPLACE">La note de 2e session remplace la 1re</mat-option>
              <mat-option value="MEILLEURE">On garde la meilleure des deux</mat-option>
            </mat-select>
          </mat-form-field>
        </div>
        <p class="texte-secondaire">
          Moyenne matière = contrôle continu × {{ valeurs()['poids_cc'] }} + examen × {{ valeurs()['poids_examen'] }}.
          Les deux poids doivent faire 1. Les moyennes déjà calculées ne changent qu'au prochain calcul.
        </p>
      </section>
    </div>
  `,
  styles: `.bloc { margin-bottom: 20px; }`,
})
export class ParametresPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);
  private readonly sync = inject(SyncService);
  readonly reseau = inject(ReseauService);

  readonly origine = signal<Record<string, Parametre>>({});
  readonly valeurs = signal<Record<string, string>>({});
  readonly chargement = signal(false);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly peutModifier = computed(() => this.auth.peut('administration.parametre.modifier'));
  readonly modifie = computed(() => this.changements().length > 0);

  private readonly changements = computed(() =>
    Object.entries(this.valeurs()).filter(([cle, v]) => String(this.origine()[cle]?.valeur ?? '') !== String(v ?? '')).map(([c]) => c),
  );

  constructor() {
    void this.charger();
  }

  libelle(cle: string): string {
    return LIBELLES[cle] ?? cle;
  }

  description(cle: string): string | null {
    return this.origine()[cle]?.description ?? null;
  }

  pourcent(cle: string): string {
    const v = Number(this.valeurs()[cle]);
    return Number.isFinite(v) ? `${Math.round(v * 100)} %` : '—';
  }

  changer(cle: string, valeur: any): void {
    this.valeurs.update((v) => ({ ...v, [cle]: valeur === null || valeur === undefined ? '' : String(valeur) }));
  }

  /** Les deux poids restent complémentaires (somme = 1). */
  changerPoids(cle: 'poids_cc' | 'poids_examen', valeur: any): void {
    const n = Number(valeur);
    this.changer(cle, valeur);
    if (Number.isFinite(n) && n >= 0 && n <= 1) {
      const autre = cle === 'poids_cc' ? 'poids_examen' : 'poids_cc';
      this.changer(autre, String(Math.round((1 - n) * 100) / 100));
    }
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      const liste = await this.api.lister<Parametre>('/api/referentiels/parametres/');
      this.origine.set(Object.fromEntries(liste.map((p) => [p.cle, p])));
      this.valeurs.set(Object.fromEntries(liste.map((p) => [p.cle, p.valeur])));
      this.erreur.set(null);
    } catch (e) {
      this.erreur.set((e as ErreurApi).message);
    } finally {
      this.chargement.set(false);
    }
  }

  async enregistrer(): Promise<void> {
    const cles = this.changements();
    this.envoi.set(true);
    this.erreur.set(null);
    try {
      if (cles.includes('poids_cc') || cles.includes('poids_examen')) {
        await this.api.post('/api/referentiels/parametres/ponderation/', {
          poids_cc: Number(this.valeurs()['poids_cc']),
          poids_examen: Number(this.valeurs()['poids_examen']),
        });
      }
      for (const cle of cles.filter((c) => c !== 'poids_cc' && c !== 'poids_examen')) {
        await this.api.patch(`/api/referentiels/parametres/${cle}/`, { valeur: this.valeurs()[cle] });
      }
      this.snack.open('Paramètres enregistrés.', 'OK', { duration: 3000 });
      this.sync.planifier(500);
      await this.charger();
    } catch (e) {
      const err = e as ErreurApi;
      this.erreur.set([err.message, ...Object.values(err.champs)].filter((t) => t && t !== 'Vérifiez les champs signalés.').join(' '));
    } finally {
      this.envoi.set(false);
    }
  }
}
