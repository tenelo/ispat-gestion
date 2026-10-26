import { Component, computed, inject, resource, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { Ligne } from '../../core/db';
import { SEXES, referentielsScolarite } from '../../core/scolarite';
import { SyncService } from '../../core/sync/sync.service';

/** Modification de l'identité d'un étudiant (utilisable hors ligne : envoyée à la synchronisation). */
@Component({
  selector: 'app-etudiant-formulaire',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Identité de l'étudiant</h2>
    <form [formGroup]="f" (ngSubmit)="enregistrer()">
      <mat-dialog-content>
        <div class="grille-formulaire">
          <mat-form-field appearance="outline">
            <mat-label>Nom</mat-label>
            <input matInput formControlName="nom" style="text-transform: uppercase" data-test="m-nom" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Prénoms</mat-label>
            <input matInput formControlName="prenoms" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Sexe</mat-label>
            <mat-select formControlName="sexe">
              @for (s of sexes; track s[0]) { <mat-option [value]="s[0]">{{ s[1] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Date de naissance</mat-label>
            <input matInput type="date" formControlName="date_naissance" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Lieu de naissance</mat-label>
            <input matInput formControlName="lieu_naissance" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Nationalité</mat-label>
            <input matInput formControlName="nationalite" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>N° pièce d'identité</mat-label>
            <input matInput formControlName="num_piece_identite" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Téléphone</mat-label>
            <input matInput type="tel" formControlName="telephone" data-test="m-telephone" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>E-mail</mat-label>
            <input matInput type="email" formControlName="email" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Ville</mat-label>
            <mat-select formControlName="ville">
              <mat-option [value]="null">—</mat-option>
              @for (v of ref.value()?.villes ?? []; track v.id) { <mat-option [value]="v.id">{{ v['libelle'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>École d'origine</mat-label>
            <mat-select formControlName="ecole_origine">
              <mat-option [value]="null">—</mat-option>
              @for (e of ecoles(); track e.id) { <mat-option [value]="e.id">{{ e['nom'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Série du bac</mat-label>
            <input matInput formControlName="serie_bac" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Année du bac</mat-label>
            <input matInput type="number" formControlName="annee_bac" />
          </mat-form-field>
          <mat-form-field appearance="outline" class="pleine-largeur">
            <mat-label>Adresse</mat-label>
            <input matInput formControlName="adresse" />
          </mat-form-field>
        </div>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Annuler</button>
        <button mat-flat-button type="submit" [disabled]="f.invalid || envoi()" data-test="m-enregistrer">Enregistrer</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class EtudiantFormulaire {
  private readonly e = inject<Ligne>(MAT_DIALOG_DATA);
  private readonly ref$ = inject(MatDialogRef<EtudiantFormulaire>);
  private readonly sync = inject(SyncService);
  readonly sexes = SEXES;
  readonly envoi = signal(false);
  readonly ref = resource({ loader: () => referentielsScolarite() });

  readonly f = inject(FormBuilder).group({
    nom: [this.e['nom'] ?? '', Validators.required],
    prenoms: [this.e['prenoms'] ?? '', Validators.required],
    sexe: [this.e['sexe'] ?? '', Validators.required],
    date_naissance: [this.e['date_naissance'] ?? ''],
    lieu_naissance: [this.e['lieu_naissance'] ?? ''],
    nationalite: [this.e['nationalite'] ?? ''],
    num_piece_identite: [this.e['num_piece_identite'] ?? ''],
    telephone: [this.e['telephone'] ?? ''],
    email: [this.e['email'] ?? '', Validators.email],
    adresse: [this.e['adresse'] ?? ''],
    ville: [(this.e['ville_id'] ?? null) as string | null],
    ecole_origine: [(this.e['ecole_origine_id'] ?? null) as string | null],
    serie_bac: [this.e['serie_bac'] ?? ''],
    annee_bac: [(this.e['annee_bac'] ?? null) as number | null],
  });

  private readonly ville = toSignal(this.f.controls.ville.valueChanges, { initialValue: this.f.controls.ville.value });
  readonly ecoles = computed(() => (this.ref.value()?.ecoles ?? []).filter((x) => !this.ville() || x['ville_id'] === this.ville()));

  async enregistrer(): Promise<void> {
    this.envoi.set(true);
    const v = this.f.getRawValue();
    const vide = (x: any) => (typeof x === 'string' ? x.trim() || null : x ?? null);
    const donnees: Record<string, any> = {
      nom: v.nom!.trim(), prenoms: v.prenoms!.trim(), sexe: v.sexe, date_naissance: vide(v.date_naissance),
      lieu_naissance: vide(v.lieu_naissance), nationalite: vide(v.nationalite), num_piece_identite: vide(v.num_piece_identite),
      telephone: vide(v.telephone), email: vide(v.email), adresse: vide(v.adresse), ville: v.ville, ecole_origine: v.ecole_origine,
      serie_bac: vide(v.serie_bac), annee_bac: v.annee_bac || null,
    };
    const { ville, ecole_origine, ...reste } = donnees;
    try {
      await this.sync.enregistrer(
        { table: 'etudiant', action: 'modifier', id: this.e.id, version: this.e.version, donnees,
          libelle: `Identité de ${donnees['nom'].toUpperCase()} ${donnees['prenoms']}` },
        { ...this.e, ...reste, nom: donnees['nom'].toUpperCase(), ville_id: ville, ecole_origine_id: ecole_origine },
      );
      this.ref$.close(true);
    } finally {
      this.envoi.set(false);
    }
  }
}
