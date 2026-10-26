import { Component, inject, signal } from '@angular/core';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';

import { ApiService, ErreurApi } from '../../core/api.service';
import { ChampCrud, Descripteur, valeurDefaut } from './crud';

export interface DonneesFormulaireCrud {
  descripteur: Descripteur;
  ligne: any | null;
  options: Record<string, [any, string][]>;
}

/** Formulaire d'ajout / modification construit à partir du descripteur. */
@Component({
  selector: 'app-formulaire-crud',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule,
    MatCheckboxModule, MatButtonModule, MatProgressSpinnerModule],
  template: `
    <h2 mat-dialog-title>{{ titre }}</h2>
    <form [formGroup]="f" (ngSubmit)="enregistrer()">
      <mat-dialog-content>
        @if (d.descripteur.aide && !d.ligne) {
          <p class="texte-secondaire aide">{{ d.descripteur.aide }}</p>
        }
        @if (erreur()) {
          <p class="erreur-formulaire" data-test="erreur-formulaire">{{ erreur() }}</p>
        }
        <div class="grille-formulaire">
          @for (c of champs; track c.cle) {
            @switch (c.type) {
              @case ('booleen') {
                <div class="case" [class.pleine-largeur]="c.pleineLargeur">
                  <mat-checkbox [formControlName]="c.cle" [attr.data-test]="'champ-' + c.cle">{{ c.libelle }}</mat-checkbox>
                  @if (c.aide) { <div class="texte-secondaire">{{ c.aide }}</div> }
                </div>
              }
              @case ('multichoix') {
                <div class="multichoix pleine-largeur" [attr.data-test]="'champ-' + c.cle">
                  <span class="texte-secondaire">{{ c.libelle }}{{ c.obligatoire ? ' *' : '' }}</span>
                  <div class="cases">
                    @for (o of c.choix ?? []; track o[0]) {
                      <mat-checkbox [checked]="coche(c.cle, o[0])" (change)="basculer(c.cle, o[0], $event.checked)"
                                    [disabled]="f.controls[c.cle].disabled" [attr.data-test]="'option-' + o[0]">{{ o[1] }}</mat-checkbox>
                    }
                  </div>
                  @if (f.controls[c.cle].touched && messageErreur(c)) { <div class="erreur-champ">{{ messageErreur(c) }}</div> }
                </div>
              }
              @case ('zone') {
                <mat-form-field appearance="outline" class="pleine-largeur">
                  <mat-label>{{ c.libelle }}</mat-label>
                  <textarea matInput rows="3" [formControlName]="c.cle" [attr.data-test]="'champ-' + c.cle"></textarea>
                  @if (c.aide) { <mat-hint>{{ c.aide }}</mat-hint> }
                  <mat-error>{{ messageErreur(c) }}</mat-error>
                </mat-form-field>
              }
              @case ('choix') {
                <mat-form-field appearance="outline" [class.pleine-largeur]="c.pleineLargeur">
                  <mat-label>{{ c.libelle }}</mat-label>
                  <mat-select [formControlName]="c.cle" [attr.data-test]="'champ-' + c.cle">
                    @if (!c.obligatoire) { <mat-option [value]="null">—</mat-option> }
                    @for (o of c.choix ?? []; track o[0]) {
                      <mat-option [value]="o[0]">{{ o[1] }}</mat-option>
                    }
                  </mat-select>
                  @if (c.aide) { <mat-hint>{{ c.aide }}</mat-hint> }
                  <mat-error>{{ messageErreur(c) }}</mat-error>
                </mat-form-field>
              }
              @case ('reference') {
                <mat-form-field appearance="outline" [class.pleine-largeur]="c.pleineLargeur">
                  <mat-label>{{ c.libelle }}</mat-label>
                  <mat-select [formControlName]="c.cle" [attr.data-test]="'champ-' + c.cle">
                    @if (!c.obligatoire) { <mat-option [value]="null">—</mat-option> }
                    @for (o of d.options[c.cle] ?? []; track o[0]) {
                      <mat-option [value]="o[0]">{{ o[1] }}</mat-option>
                    }
                  </mat-select>
                  @if (c.aide) { <mat-hint>{{ c.aide }}</mat-hint> }
                  <mat-error>{{ messageErreur(c) }}</mat-error>
                </mat-form-field>
              }
              @default {
                <mat-form-field appearance="outline" [class.pleine-largeur]="c.pleineLargeur">
                  <mat-label>{{ c.libelle }}</mat-label>
                  <input matInput [formControlName]="c.cle" [attr.data-test]="'champ-' + c.cle"
                         [type]="c.type === 'nombre' ? 'number' : c.type === 'date' ? 'date' : c.type === 'motdepasse' ? 'password' : 'text'"
                         [attr.autocomplete]="c.type === 'motdepasse' ? 'new-password' : 'off'"
                         [attr.min]="c.min ?? null" [attr.max]="c.max ?? null"
                         [style.text-transform]="c.majuscules ? 'uppercase' : null" />
                  @if (c.aide) { <mat-hint>{{ c.aide }}</mat-hint> }
                  <mat-error>{{ messageErreur(c) }}</mat-error>
                </mat-form-field>
              }
            }
          }
        </div>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Annuler</button>
        <button mat-flat-button type="submit" [disabled]="envoi()" data-test="crud-enregistrer">
          @if (envoi()) { <mat-progress-spinner mode="indeterminate" diameter="18" /> } @else { Enregistrer }
        </button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .aide { margin-top: 0; }
    .multichoix { margin-bottom: 16px; }
    .cases { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0 12px; margin-top: 4px; }
    .erreur-champ { color: var(--ispat-rouge); font-size: 0.75rem; }
    .case { display: flex; flex-direction: column; justify-content: center; min-height: 56px; margin-bottom: 20px; }
  `,
})
export class FormulaireCrud {
  readonly d = inject<DonneesFormulaireCrud>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<FormulaireCrud>);
  private readonly api = inject(ApiService);

  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly champs: ChampCrud[] = this.d.descripteur.champs.filter((c) => !(c.lectureSeule && !this.d.ligne));
  readonly f = new FormGroup<Record<string, FormControl>>({});
  readonly titre = this.d.ligne
    ? `Modifier ${this.d.descripteur.singulier}`
    : `${this.d.descripteur.feminin ? 'Nouvelle' : 'Nouveau'} ${this.d.descripteur.singulier.replace(/^(une |un |l')/, '')}`;

  constructor() {
    for (const c of this.champs) {
      let valeur = this.d.ligne ? this.d.ligne[c.cle] ?? null : valeurDefaut(c);
      if (c.type === 'multichoix') {
        valeur = Array.isArray(valeur) ? [...valeur] : [];
      }
      const validateurs = [];
      if (c.obligatoire && c.type === 'multichoix') {
        validateurs.push((ctrl: AbstractControl) => (Array.isArray(ctrl.value) && ctrl.value.length ? null : { required: true }));
      } else if (c.obligatoire && c.type !== 'booleen') {
        validateurs.push(Validators.required);
      }
      if (c.min !== undefined) {
        validateurs.push(Validators.min(c.min));
      }
      if (c.max !== undefined) {
        validateurs.push(Validators.max(c.max));
      }
      const ctrl = new FormControl(valeur, validateurs);
      if (c.lectureSeule || (c.creationSeulement && this.d.ligne)) {
        ctrl.disable();
      }
      this.f.addControl(c.cle, ctrl);
    }
  }

  coche(cle: string, valeur: any): boolean {
    return (this.f.controls[cle].value ?? []).includes(valeur);
  }

  basculer(cle: string, valeur: any, coche: boolean): void {
    const ctrl = this.f.controls[cle];
    const actuel: any[] = ctrl.value ?? [];
    ctrl.setValue(coche ? [...actuel.filter((v) => v !== valeur), valeur] : actuel.filter((v) => v !== valeur));
    ctrl.markAsTouched();
  }

  messageErreur(c: ChampCrud): string {
    const e = this.f.controls[c.cle]?.errors;
    if (!e) {
      return '';
    }
    if (e['serveur']) {
      return e['serveur'];
    }
    if (e['required']) {
      return 'Obligatoire.';
    }
    if (e['min']) {
      return `Minimum ${c.min}.`;
    }
    if (e['max']) {
      return `Maximum ${c.max}.`;
    }
    return 'Valeur invalide.';
  }

  async enregistrer(): Promise<void> {
    this.f.markAllAsTouched();
    if (this.f.invalid) {
      return;
    }
    this.envoi.set(true);
    this.erreur.set(null);
    let donnees: Record<string, any> = {};
    for (const c of this.champs) {
      const ctrl = this.f.controls[c.cle];
      if (ctrl.disabled) {
        continue;
      }
      let v = ctrl.value;
      if (typeof v === 'string' && c.type !== 'motdepasse') {
        v = v.trim();
        if (c.majuscules) {
          v = v.toUpperCase();
        }
        if (v === '' && c.type !== 'texte') {
          v = null;
        }
        if (v === '' && !c.obligatoire) {
          v = null;
        }
      }
      if (c.type === 'nombre' && v !== null && v !== '') {
        v = Number(v);
      }
      // Création : les champs vides sont omis (valeurs par défaut du serveur) ; modification : null efface.
      if (!this.d.ligne && (v === null || v === undefined || v === '')) {
        continue;
      }
      donnees[c.cle] = v;
    }
    if (this.d.descripteur.preparer) {
      donnees = this.d.descripteur.preparer(donnees, this.d.ligne);
    }
    try {
      const resultat = this.d.ligne
        ? await this.api.patch(`${this.d.descripteur.chemin}${this.d.ligne.id}/`, donnees)
        : await this.api.post(this.d.descripteur.chemin, donnees);
      this.ref.close(resultat ?? true);
    } catch (e) {
      const err = e as ErreurApi;
      const nonAffectees: string[] = [];
      for (const [cle, message] of Object.entries(err.champs ?? {})) {
        const ctrl = this.f.controls[cle];
        if (ctrl && ctrl.enabled) {
          ctrl.setErrors({ serveur: message });
          ctrl.markAsTouched();
        } else {
          const libelle = this.d.descripteur.champs.find((c) => c.cle === cle)?.libelle ?? cle;
          nonAffectees.push(`${libelle} : ${message}`);
        }
      }
      const global = err.message === 'Vérifiez les champs signalés.' ? '' : err.message;
      this.erreur.set([global, ...nonAffectees].filter(Boolean).join(' ') || null);
    } finally {
      this.envoi.set(false);
    }
  }
}
