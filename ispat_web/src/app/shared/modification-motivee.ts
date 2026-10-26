import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';

import { ecrireNote, lireNote } from '../core/notes';

export interface DonneesModification {
  titre: string;
  message?: string;
  type: 'note' | 'choix' | 'aucun';
  libelle?: string;
  valeur?: any;
  options?: [string, string][];
  absentPossible?: boolean;
  absent?: boolean;
  confirmer?: string;
}

export interface ResultatModification {
  valeur: any;
  absent: boolean;
  motif: string;
}

/** Modification d'une note ou d'une moyenne validée : nouvelle valeur + motif obligatoire (tracé dans l'historique). */
@Component({
  selector: 'app-modification-motivee',
  imports: [FormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ d.titre }}</h2>
    <mat-dialog-content>
      @if (d.message) { <p style="white-space: pre-line; margin-top: 0">{{ d.message }}</p> }
      @if (d.type === 'note') {
        <div class="ligne">
          <mat-form-field appearance="outline">
            <mat-label>{{ d.libelle ?? 'Nouvelle note /20' }}</mat-label>
            <input matInput [(ngModel)]="texte" [disabled]="absent" inputmode="decimal" data-test="mm-valeur" />
            @if (texte && invalide()) { <mat-hint class="erreur">Note entre 0 et 20</mat-hint> }
          </mat-form-field>
          @if (d.absentPossible) { <mat-checkbox [(ngModel)]="absent" data-test="mm-absent">Absent</mat-checkbox> }
        </div>
      } @else if (d.type === 'choix') {
        <mat-form-field appearance="outline" class="plein">
          <mat-label>{{ d.libelle }}</mat-label>
          <mat-select [(ngModel)]="choix" data-test="mm-choix">
            @for (o of d.options ?? []; track o[0]) { <mat-option [value]="o[0]">{{ o[1] }}</mat-option> }
          </mat-select>
        </mat-form-field>
      }
      <mat-form-field appearance="outline" class="plein">
        <mat-label>Motif (obligatoire)</mat-label>
        <textarea matInput rows="2" [(ngModel)]="motif" data-test="mm-motif"></textarea>
        <mat-hint>Conservé dans l'historique des modifications (5 caractères minimum)</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button [mat-dialog-close]="null">Annuler</button>
      <button mat-flat-button [disabled]="!valide()" (click)="fermer()" data-test="mm-valider">{{ d.confirmer ?? 'Enregistrer' }}</button>
    </mat-dialog-actions>
  `,
  styles: `
    .plein { width: 100%; }
    .ligne { display: flex; gap: 16px; align-items: center; }
    .erreur { color: var(--ispat-rouge); }
  `,
})
export class ModificationMotivee {
  readonly d = inject<DonneesModification>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ModificationMotivee, ResultatModification>);
  texte = this.d.type === 'note' ? ecrireNote(this.d.valeur) : '';
  absent = !!this.d.absent;
  choix = this.d.valeur ?? null;
  motif = '';

  invalide(): boolean {
    const n = lireNote(this.texte);
    return n === null || Number.isNaN(n);
  }

  valide(): boolean {
    if (this.motif.trim().length < 5) {
      return false;
    }
    if (this.d.type === 'note') {
      return this.absent || !this.invalide();
    }
    if (this.d.type === 'choix') {
      return this.choix !== null && this.choix !== undefined;
    }
    return true;
  }

  fermer(): void {
    this.ref.close({
      valeur: this.d.type === 'note' ? (this.absent ? null : lireNote(this.texte)) : this.choix,
      absent: this.absent,
      motif: this.motif.trim(),
    });
  }
}

export async function modifierAvecMotif(dialog: MatDialog, donnees: DonneesModification): Promise<ResultatModification | null> {
  const ref = dialog.open(ModificationMotivee, { data: donnees, width: '480px', maxWidth: '94vw' });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}
