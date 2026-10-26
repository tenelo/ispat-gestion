import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';

export interface DonneesChoix {
  titre: string;
  message?: string;
  libelle: string;
  options?: [any, string][];       // liste déroulante ; sans options : saisie libre
  type?: 'text' | 'password';
  confirmer?: string;
  minimum?: number;                 // longueur minimale (saisie libre)
}

/** Petite boîte : choisir une valeur dans une liste ou saisir un texte (motif, mot de passe…). */
@Component({
  selector: 'app-choix',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatSelectModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>{{ d.titre }}</h2>
    <mat-dialog-content>
      @if (d.message) { <p style="white-space: pre-line; margin-top: 0">{{ d.message }}</p> }
      <mat-form-field appearance="outline" style="width: 100%">
        <mat-label>{{ d.libelle }}</mat-label>
        @if (d.options) {
          <mat-select [(ngModel)]="valeur" data-test="choix-valeur">
            @for (o of d.options; track o[0]) { <mat-option [value]="o[0]">{{ o[1] }}</mat-option> }
          </mat-select>
        } @else {
          <input matInput [type]="d.type ?? 'text'" [(ngModel)]="valeur" data-test="choix-valeur" autocomplete="new-password" />
        }
        @if (d.minimum) { <mat-hint>{{ d.minimum }} caractères minimum</mat-hint> }
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="null">Annuler</button>
      <button mat-flat-button [mat-dialog-close]="valeur" [disabled]="!valide()" data-test="choix-confirmer">
        {{ d.confirmer ?? 'Valider' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class Choix {
  readonly d = inject<DonneesChoix>(MAT_DIALOG_DATA);
  valeur: any = null;

  valide(): boolean {
    if (this.valeur === null || this.valeur === undefined || this.valeur === '') {
      return false;
    }
    return typeof this.valeur !== 'string' || this.valeur.trim().length >= (this.d.minimum ?? 1);
  }
}

export async function choisir(dialog: MatDialog, donnees: DonneesChoix): Promise<any | null> {
  const ref = dialog.open(Choix, { data: donnees, width: '460px', maxWidth: '94vw' });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}
