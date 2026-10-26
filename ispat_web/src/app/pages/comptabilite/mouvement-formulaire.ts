import { Component, computed, inject, resource, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { MODES_AVEC_REFERENCE, MODES_PAIEMENT, fcfa } from '../../core/finances';
import { SyncService } from '../../core/sync/sync.service';
import { aujourdhui, nouvelId } from '../../core/texte';

export interface DonneesMouvement {
  sens: 'ENTREE' | 'SORTIE';
  ligne: Ligne | null;
}

/** Saisie ou modification d'une entrée / sortie de caisse (hors ligne possible). */
@Component({
  selector: 'app-mouvement-formulaire',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ d.ligne ? 'Modifier' : 'Nouvelle' }} {{ d.sens === 'ENTREE' ? 'entrée' : 'sortie' }} de caisse</h2>
    <form [formGroup]="f" (ngSubmit)="enregistrer()">
      <mat-dialog-content>
        @if (erreur()) { <p class="erreur-formulaire">{{ erreur() }}</p> }
        <div class="grille-formulaire">
          <mat-form-field appearance="outline">
            <mat-label>Catégorie</mat-label>
            <mat-select formControlName="categorie" data-test="m-categorie">
              @for (c of categories.value() ?? []; track c.id) { <mat-option [value]="c.id">{{ c['libelle'] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Montant (FCFA)</mat-label>
            <input matInput type="number" min="1" formControlName="montant" data-test="m-montant" />
            @if (f.value.montant) { <mat-hint>{{ fcfa(f.value.montant) }}</mat-hint> }
          </mat-form-field>
          <mat-form-field appearance="outline" class="pleine-largeur">
            <mat-label>Libellé</mat-label>
            <input matInput formControlName="libelle" data-test="m-libelle" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>{{ d.sens === 'ENTREE' ? 'Versé par' : 'Payé à' }}</mat-label>
            <input matInput formControlName="tiers" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Date</mat-label>
            <input matInput type="date" formControlName="date_mouvement" [max]="aujourdhui" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Mode de paiement</mat-label>
            <mat-select formControlName="mode_paiement">
              @for (m of modes; track m[0]) { <mat-option [value]="m[0]">{{ m[1] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Référence{{ referenceObligatoire() ? ' (obligatoire)' : '' }}</mat-label>
            <input matInput formControlName="reference" data-test="m-reference" />
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
export class MouvementFormulaire {
  readonly d = inject<DonneesMouvement>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<MouvementFormulaire>);
  private readonly sync = inject(SyncService);
  private readonly auth = inject(AuthService);
  readonly modes = MODES_PAIEMENT;
  readonly fcfa = fcfa;
  readonly aujourdhui = aujourdhui();
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly categories = resource({
    loader: async () => (await db.table_('categorie_mouvement').where('sens').equals(this.d.sens).toArray())
      .filter((c) => c['code'] !== 'VERSEMENT_SCOLARITE')
      .sort((a, b) => String(a['libelle']).localeCompare(String(b['libelle']), 'fr')),
  });

  readonly f = inject(FormBuilder).group({
    categorie: [(this.d.ligne?.['categorie_id'] ?? '') as string, Validators.required],
    montant: [(this.d.ligne ? Number(this.d.ligne['montant']) : null) as number | null, [Validators.required, Validators.min(1)]],
    libelle: [this.d.ligne?.['libelle'] ?? '', Validators.required],
    tiers: [this.d.ligne?.['tiers'] ?? ''],
    date_mouvement: [this.d.ligne?.['date_mouvement'] ?? aujourdhui(), Validators.required],
    mode_paiement: [this.d.ligne?.['mode_paiement'] ?? 'ESPECES', Validators.required],
    reference: [this.d.ligne?.['reference'] ?? ''],
  });
  private readonly mode = toSignal(this.f.controls.mode_paiement.valueChanges, { initialValue: this.f.controls.mode_paiement.value });
  readonly referenceObligatoire = computed(() => MODES_AVEC_REFERENCE.includes(this.mode() ?? ''));

  async enregistrer(): Promise<void> {
    const v = this.f.getRawValue();
    if (this.referenceObligatoire() && !(v.reference ?? '').trim()) {
      this.erreur.set('Référence obligatoire pour ce mode de paiement.');
      return;
    }
    this.envoi.set(true);
    const donnees = {
      categorie: v.categorie, montant: Number(v.montant), libelle: (v.libelle ?? '').trim(), tiers: (v.tiers ?? '').trim() || null,
      date_mouvement: v.date_mouvement, mode_paiement: v.mode_paiement, reference: (v.reference ?? '').trim() || null,
    };
    const { categorie, ...reste } = donnees;
    const sens = this.d.sens === 'ENTREE' ? 'Entrée' : 'Sortie';
    try {
      if (this.d.ligne) {
        await this.sync.enregistrer(
          { table: 'mouvement_caisse', action: 'modifier', id: this.d.ligne.id, version: this.d.ligne.version, donnees,
            libelle: `${sens} modifiée : ${donnees.libelle} (${fcfa(donnees.montant)})` },
          { ...this.d.ligne, ...reste, categorie_id: categorie },
        );
      } else {
        const id = nouvelId();
        await this.sync.enregistrer(
          { table: 'mouvement_caisse', action: 'creer', id, donnees, libelle: `${sens} : ${donnees.libelle} (${fcfa(donnees.montant)})` },
          { id, version: 0, sens: this.d.sens, ...reste, categorie_id: categorie, annule: false, versement_id: null,
            saisi_par_id: this.auth.utilisateur()?.id ?? null, justificatif_chemin: null },
        );
      }
      this.ref.close(true);
    } finally {
      this.envoi.set(false);
    }
  }
}
