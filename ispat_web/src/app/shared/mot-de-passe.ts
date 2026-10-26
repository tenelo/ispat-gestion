import { Component, inject, signal } from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

import { ApiService, ErreurApi } from '../core/api.service';

function identiques(groupe: AbstractControl): ValidationErrors | null {
  return groupe.get('nouveau')?.value === groupe.get('confirmation')?.value ? null : { differents: true };
}

/** Changement de son propre mot de passe (menu utilisateur). Nécessite la connexion. */
@Component({
  selector: 'app-mot-de-passe',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Changer mon mot de passe</h2>
    <form [formGroup]="f" (ngSubmit)="valider()">
      <mat-dialog-content>
        @if (erreur()) { <p class="erreur-formulaire" data-test="erreur-mdp">{{ erreur() }}</p> }
        <mat-form-field appearance="outline" class="plein">
          <mat-label>Mot de passe actuel</mat-label>
          <input matInput type="password" formControlName="actuel" autocomplete="current-password" data-test="mdp-actuel" />
        </mat-form-field>
        <mat-form-field appearance="outline" class="plein">
          <mat-label>Nouveau mot de passe</mat-label>
          <input matInput type="password" formControlName="nouveau" autocomplete="new-password" data-test="mdp-nouveau" />
          <mat-hint>8 caractères minimum, pas uniquement des chiffres</mat-hint>
        </mat-form-field>
        <mat-form-field appearance="outline" class="plein">
          <mat-label>Confirmer le nouveau mot de passe</mat-label>
          <input matInput type="password" formControlName="confirmation" autocomplete="new-password" data-test="mdp-confirmation" />
        </mat-form-field>
        @if (f.hasError('differents') && f.controls.confirmation.touched) {
          <p class="texte-erreur">Les deux saisies sont différentes.</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Annuler</button>
        <button mat-flat-button type="submit" [disabled]="f.invalid || envoi()" data-test="mdp-valider">Changer</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: `
    .plein { width: 100%; }
    .texte-erreur { color: var(--ispat-rouge); font-size: 0.85rem; margin: 0; }
  `,
})
export class MotDePasse {
  private readonly api = inject(ApiService);
  private readonly ref = inject(MatDialogRef<MotDePasse>);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly f = inject(FormBuilder).nonNullable.group(
    {
      actuel: ['', Validators.required],
      nouveau: ['', [Validators.required, Validators.minLength(8)]],
      confirmation: ['', Validators.required],
    },
    { validators: identiques },
  );

  async valider(): Promise<void> {
    if (this.f.invalid) {
      return;
    }
    this.envoi.set(true);
    this.erreur.set(null);
    const { actuel, nouveau } = this.f.getRawValue();
    try {
      await this.api.post('/api/auth/mot-de-passe/', { actuel, nouveau });
      this.ref.close(true);
    } catch (e) {
      const err = e as ErreurApi;
      this.erreur.set([...Object.values(err.champs), err.message].filter((t) => t && t !== 'Vérifiez les champs signalés.').join(' '));
    } finally {
      this.envoi.set(false);
    }
  }
}
