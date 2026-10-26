import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';

import { Ligne } from '../../core/db';
import { Cours, LIBELLES_TYPE, TYPES_EVALUATION } from '../../core/notes';
import { SyncService } from '../../core/sync/sync.service';
import { aujourdhui, nouvelId } from '../../core/texte';

export interface DonneesEvaluation {
  cours: Cours;
  evaluation: Ligne | null;
  existantes: Ligne[];
}

/** Création / modification d'une évaluation (hors ligne possible). */
@Component({
  selector: 'app-evaluation-formulaire',
  imports: [ReactiveFormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ d.evaluation ? 'Modifier l\\'évaluation' : 'Nouvelle évaluation' }}</h2>
    <form [formGroup]="f" (ngSubmit)="enregistrer()">
      <mat-dialog-content>
        <p class="texte-secondaire">{{ d.cours.matiere['code'] }} — {{ d.cours.matiere['libelle'] }} · {{ d.cours.classe['libelle'] }} · semestre {{ d.cours.semestre['numero'] }}</p>
        @if (erreur()) { <p class="erreur-formulaire">{{ erreur() }}</p> }
        <div class="grille-formulaire">
          <mat-form-field appearance="outline">
            <mat-label>Type</mat-label>
            <mat-select formControlName="type_eval" (selectionChange)="proposerLibelle()" data-test="ev-type">
              @for (t of types; track t[0]) { <mat-option [value]="t[0]">{{ t[1] }}</mat-option> }
            </mat-select>
          </mat-form-field>
          @if (type() === 'EXAMEN') {
            <mat-form-field appearance="outline">
              <mat-label>Session</mat-label>
              <mat-select formControlName="session" (selectionChange)="proposerLibelle()" data-test="ev-session">
                <mat-option [value]="1">1re session</mat-option>
                <mat-option [value]="2">2e session (rattrapage)</mat-option>
              </mat-select>
            </mat-form-field>
          }
          <mat-form-field appearance="outline">
            <mat-label>Libellé</mat-label>
            <input matInput formControlName="libelle" data-test="ev-libelle" />
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Date</mat-label>
            <input matInput type="date" formControlName="date_eval" />
          </mat-form-field>
          @if (type() !== 'EXAMEN') {
            <mat-form-field appearance="outline">
              <mat-label>Poids dans le contrôle continu</mat-label>
              <input matInput type="number" step="0.5" min="0.5" formControlName="poids" />
            </mat-form-field>
          }
        </div>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" mat-dialog-close>Annuler</button>
        <button mat-flat-button type="submit" [disabled]="f.invalid || envoi()" data-test="ev-enregistrer">Enregistrer</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class EvaluationFormulaire {
  readonly d = inject<DonneesEvaluation>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<EvaluationFormulaire>);
  private readonly sync = inject(SyncService);
  readonly types = TYPES_EVALUATION;
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);

  readonly f = inject(FormBuilder).group({
    type_eval: [(this.d.evaluation?.['type_eval'] ?? 'DEVOIR') as string, Validators.required],
    session: [Number(this.d.evaluation?.['session'] ?? 1)],
    libelle: [(this.d.evaluation?.['libelle'] ?? '') as string, Validators.required],
    date_eval: [(this.d.evaluation?.['date_eval'] ?? aujourdhui()) as string],
    poids: [Number(this.d.evaluation?.['poids'] ?? 1), [Validators.min(0.01)]],
  });
  readonly type = toSignal(this.f.controls.type_eval.valueChanges, { initialValue: this.f.controls.type_eval.value });

  constructor() {
    if (!this.d.evaluation) {
      this.proposerLibelle();
    }
  }

  /** « Devoir 2 », « Examen », « Examen de rattrapage »… */
  proposerLibelle(): void {
    if (this.d.evaluation) {
      return;
    }
    const type = this.f.controls.type_eval.value!;
    if (type === 'EXAMEN') {
      this.f.controls.libelle.setValue(Number(this.f.controls.session.value) === 2 ? 'Examen de rattrapage' : 'Examen');
      return;
    }
    const n = this.d.existantes.filter((e) => e['type_eval'] === type).length + 1;
    this.f.controls.libelle.setValue(`${LIBELLES_TYPE[type]} ${n}`);
  }

  async enregistrer(): Promise<void> {
    const v = this.f.getRawValue();
    const examen = v.type_eval === 'EXAMEN';
    const session = examen ? Number(v.session) : 1;
    if (examen && this.d.existantes.some((e) => e.id !== this.d.evaluation?.id && e['type_eval'] === 'EXAMEN' && Number(e['session']) === session)) {
      this.erreur.set(`L'examen de session ${session} existe déjà pour cette matière.`);
      return;
    }
    if (examen && session === 2 && !this.d.existantes.some((e) => e['type_eval'] === 'EXAMEN' && Number(e['session']) === 1)) {
      this.erreur.set('Créer d\'abord l\'examen de 1re session.');
      return;
    }
    this.envoi.set(true);
    const c = this.d.cours;
    const donnees = {
      classe: c.classe.id, matiere: c.matiere.id, semestre: c.semestre.id, type_eval: v.type_eval, session,
      libelle: (v.libelle ?? '').trim(), date_eval: v.date_eval || null, poids: examen ? 1 : Number(v.poids || 1),
    };
    const local = { classe_id: c.classe.id, matiere_id: c.matiere.id, semestre_id: c.semestre.id, type_eval: v.type_eval, session,
      libelle: donnees.libelle, date_eval: donnees.date_eval, poids: donnees.poids };
    try {
      if (this.d.evaluation) {
        const { classe, matiere, semestre, ...modifs } = donnees;
        await this.sync.enregistrer(
          { table: 'evaluation', action: 'modifier', id: this.d.evaluation.id, version: this.d.evaluation.version, donnees: modifs,
            libelle: `Évaluation modifiée : ${donnees.libelle} (${c.matiere['code']}, ${c.classe['libelle']})` },
          { ...this.d.evaluation, ...local },
        );
      } else {
        const id = nouvelId();
        await this.sync.enregistrer(
          { table: 'evaluation', action: 'creer', id, donnees, libelle: `Évaluation : ${donnees.libelle} (${c.matiere['code']}, ${c.classe['libelle']})` },
          { id, version: 0, ...local },
        );
        this.ref.close(id);
        return;
      }
      this.ref.close(this.d.evaluation.id);
    } finally {
      this.envoi.set(false);
    }
  }
}
