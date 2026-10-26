import { Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';

export interface DonneesConfirmation {
  titre: string;
  message: string;
  confirmer?: string;
  annuler?: string;
  danger?: boolean;
  information?: boolean;          // simple message : un seul bouton « OK »
}

@Component({
  selector: 'app-confirmation',
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ d.titre }}</h2>
    <mat-dialog-content>
      <p style="white-space: pre-line; margin: 0">{{ d.message }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (!d.information) {
        <button mat-button [mat-dialog-close]="false">{{ d.annuler ?? 'Annuler' }}</button>
      }
      <button mat-flat-button [mat-dialog-close]="true" [class.bouton-danger]="d.danger">
        {{ d.confirmer ?? (d.information ? 'OK' : 'Confirmer') }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    .bouton-danger {
      --mat-button-filled-container-color: var(--ispat-rouge);
    }
  `,
})
export class Confirmation {
  readonly d = inject<DonneesConfirmation>(MAT_DIALOG_DATA);
}

/** Boîte de confirmation ; renvoie true si l'utilisateur confirme. */
export async function confirmer(dialog: MatDialog, donnees: DonneesConfirmation): Promise<boolean> {
  const ref = dialog.open(Confirmation, { data: donnees, width: '440px', maxWidth: '92vw' });
  return (await firstValueFrom(ref.afterClosed())) === true;
}
