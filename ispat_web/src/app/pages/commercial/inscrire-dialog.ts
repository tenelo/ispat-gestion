import { Component, inject, resource, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { firstValueFrom } from 'rxjs';

import { ApiService, ErreurApi } from '../../core/api.service';
import { referentielsScolarite } from '../../core/scolarite';
import { nouvelId } from '../../core/texte';

export interface DonneesInscrire {
  titre: string;
  personne: string;                 // « KONÉ Awa »
  chemin: string;                   // /api/commercial/prospects/{id}/inscrire/ ou /preinscriptions/{id}/inscrire/
  filiereSouhaitee?: string | null; // id : classes de cette filière proposées en premier
}

/**
 * Conversion d'un prospect ou d'une pré-inscription en inscription (EN_ATTENTE, validée ensuite par la scolarité).
 * Si un étudiant semblable existe déjà : réinscrire cet étudiant ou créer un nouvel étudiant.
 */
@Component({
  selector: 'app-inscrire-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>{{ d.titre }}</h2>
    <mat-dialog-content>
      <p><strong>{{ d.personne }}</strong> — l'inscription sera créée « en attente » ; la scolarité la valide (matricule, frais).</p>
      @if (erreur()) { <p class="erreur-formulaire" data-test="erreur-inscrire">{{ erreur() }}</p> }
      @if (semblables().length) {
        <div class="semblables" data-test="semblables">
          <strong>Étudiant(s) déjà connu(s) avec ce nom :</strong>
          @for (e of semblables(); track e.id) {
            <div class="semblable">
              <span><span class="matricule">{{ e.matricule ?? 'sans matricule' }}</span> {{ e.nom }} {{ e.prenoms }}</span>
              <button mat-stroked-button (click)="envoyer({ etudiant_id: e.id })" [disabled]="envoi()" data-test="reprendre-etudiant">C'est lui : réinscrire</button>
            </div>
          }
          <button mat-button (click)="envoyer({ forcer: true })" [disabled]="envoi()" data-test="nouvel-etudiant">Personne différente : créer un nouvel étudiant</button>
        </div>
      }
      <div class="grille-formulaire">
        <mat-form-field appearance="outline" class="pleine-largeur">
          <mat-label>Classe ({{ ref.value()?.anneeActive?.['libelle'] }})</mat-label>
          <mat-select [(ngModel)]="classe" data-test="ins-classe">
            @for (c of classes(); track c.id) { <mat-option [value]="c.id">{{ c['libelle'] }}{{ c['filiere_id'] === d.filiereSouhaitee ? ' — filière souhaitée' : '' }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Statut</mat-label>
          <mat-select [(ngModel)]="statut" data-test="ins-statut">
            @for (s of ref.value()?.statuts ?? []; track s.id) { <mat-option [value]="s.id">{{ s['libelle'] }}</mat-option> }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Observations</mat-label>
          <input matInput [(ngModel)]="observations" />
        </mat-form-field>
      </div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Annuler</button>
      @if (!semblables().length) {
        <button mat-flat-button (click)="envoyer({})" [disabled]="!classe || !statut || envoi()" data-test="ins-valider">
          <mat-icon>how_to_reg</mat-icon> Inscrire
        </button>
      }
    </mat-dialog-actions>
  `,
  styles: `
    .semblables { background: var(--ispat-orange-clair); color: #7a3b04; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; }
    .semblable { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin: 6px 0; }
  `,
})
export class InscrireDialog {
  readonly d = inject<DonneesInscrire>(MAT_DIALOG_DATA);
  private readonly ref$ = inject(MatDialogRef<InscrireDialog>);
  private readonly api = inject(ApiService);
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly semblables = signal<any[]>([]);
  classe = '';
  statut = '';
  observations = '';
  private readonly id = nouvelId();

  readonly ref = resource({
    loader: async () => {
      const r = await referentielsScolarite();
      const souhaitees = r.classes.filter((c) => c['annee_id'] === r.anneeActive?.id && c['filiere_id'] === this.d.filiereSouhaitee);
      if (souhaitees.length === 1) {
        this.classe = souhaitees[0].id;
      }
      return r;
    },
  });

  classes() {
    const r = this.ref.value();
    return (r?.classes ?? []).filter((c) => c['annee_id'] === r?.anneeActive?.id)
      .sort((a, b) => Number(b['filiere_id'] === this.d.filiereSouhaitee) - Number(a['filiere_id'] === this.d.filiereSouhaitee));
  }

  async envoyer(options: { etudiant_id?: string; forcer?: boolean }): Promise<void> {
    this.envoi.set(true);
    this.erreur.set(null);
    try {
      const r = await this.api.post(this.d.chemin, {
        id: this.id, classe: this.classe, statut_etudiant: this.statut, observations: this.observations.trim() || null, ...options,
      });
      this.ref$.close(r);
    } catch (e) {
      const err = e as ErreurApi;
      if (err.statut === 409 && Array.isArray(err.brut?.etudiants)) {
        this.semblables.set(err.brut.etudiants);
      } else {
        this.erreur.set([err.message, ...Object.values(err.champs)].filter((t) => t && t !== 'Vérifiez les champs signalés.').join(' '));
      }
    } finally {
      this.envoi.set(false);
    }
  }
}

export async function inscrireDialogue(dialog: MatDialog, d: DonneesInscrire): Promise<any | null> {
  const ref = dialog.open(InscrireDialog, { data: d, width: '640px', maxWidth: '96vw' });
  return (await firstValueFrom(ref.afterClosed())) ?? null;
}
