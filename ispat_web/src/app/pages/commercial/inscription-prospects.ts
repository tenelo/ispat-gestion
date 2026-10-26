import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { confirmer } from '../../shared/confirmation';
import { inscrireDialogue } from './inscrire-dialog';

const STATUTS: Record<string, string> = { NOUVEAU: 'Nouveau', CONTACTE: 'Contacté', PREINSCRIT: 'Pré-inscrit', INSCRIT: 'Inscrit', PERDU: 'Perdu' };

/** Conversion des prospects : pré-inscription ou inscription directe (en attente de validation). Connexion nécessaire. */
@Component({
  selector: 'app-inscription-prospects',
  imports: [MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, DatePipe],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Inscription des prospects</h1>
          <p class="sous-titre">Le prospect devient étudiant : inscription « en attente », validée ensuite par la scolarité (matricule, frais).</p>
        </div>
      </div>
      @if (!reseau.enLigne()) {
        <p class="carte vide">Connexion nécessaire pour inscrire un prospect.</p>
      } @else {
        <section class="carte filtres">
          <mat-form-field appearance="outline" subscriptSizing="dynamic">
            <mat-label>Statut</mat-label>
            <mat-select [value]="statut()" (selectionChange)="statut.set($event.value)">
              <mat-option value="PREINSCRIT,CONTACTE,NOUVEAU">À convertir</mat-option>
              <mat-option value="PREINSCRIT">Pré-inscrits</mat-option>
              <mat-option value="INSCRIT">Inscrits</mat-option>
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" class="large-champ">
            <mat-icon matPrefix>search</mat-icon>
            <mat-label>Nom, prénoms ou téléphone</mat-label>
            <input matInput [value]="q()" (change)="q.set($any($event.target).value)" data-test="ip-recherche" />
          </mat-form-field>
        </section>
        @if (chargement()) { <mat-progress-bar mode="indeterminate" /> }
        <section class="carte">
          <div class="defilement-horizontal">
            <table class="tableau" data-test="liste-a-convertir">
              <thead><tr><th>Nom et prénoms</th><th>Téléphone</th><th>Ville / école</th><th>Filière souhaitée</th><th>Contact</th><th>Statut</th><th></th></tr></thead>
              <tbody>
                @for (p of liste(); track p.id) {
                  <tr>
                    <td><strong>{{ p.nom }}</strong> {{ p.prenoms }}</td><td>{{ p.telephone ?? '—' }}</td>
                    <td>{{ p.ville_libelle ?? '—' }}<div class="texte-secondaire">{{ p.ecole_libelle ?? '' }}</div></td>
                    <td>{{ p.filiere_souhaitee_code ?? '—' }}</td><td>{{ p.date_contact | date: 'dd/MM/yyyy' }}</td>
                    <td>
                      @if (p.etudiant && p.statut !== 'INSCRIT') {
                        <span class="pastille neutre" data-test="ip-en-attente">Inscription en attente de validation</span>
                      } @else {
                        <span class="pastille" [class.attente]="p.statut === 'PREINSCRIT'">{{ libelle[p.statut] }}</span>
                      }
                      @if (p.etudiant_matricule) { <span class="matricule">{{ p.etudiant_matricule }}</span> }</td>
                    <td class="boutons">
                      @if (p.statut !== 'INSCRIT' && !p.etudiant) {
                        @if (p.statut !== 'PREINSCRIT' && peutPreinscrire()) {
                          <button mat-button (click)="preinscrire(p)" data-test="ip-preinscrire">Pré-inscrire</button>
                        }
                        @if (peutInscrire()) {
                          <button mat-flat-button (click)="inscrire(p)" data-test="ip-inscrire"><mat-icon>how_to_reg</mat-icon> Inscrire</button>
                        }
                      }
                    </td>
                  </tr>
                } @empty { <tr><td colspan="7" class="vide">Aucun prospect.</td></tr> }
              </tbody>
            </table>
          </div>
        </section>
      }
    </div>
  `,
  styleUrl: './commercial.scss',
})
export class InscriptionProspectsPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  readonly reseau = inject(ReseauService);
  readonly libelle = STATUTS;
  readonly peutInscrire = computed(() => this.auth.peut('commercial.inscription_prospect.creer'));
  readonly peutPreinscrire = computed(() => this.auth.peut('commercial.preinscription.creer'));

  readonly statut = signal('PREINSCRIT,CONTACTE,NOUVEAU');
  readonly q = signal('');
  readonly liste = signal<any[]>([]);
  readonly chargement = signal(false);

  constructor() {
    effect(() => {
      const p = { s: this.statut(), q: this.q(), enLigne: this.reseau.enLigne() };
      untracked(() => p.enLigne && void this.charger());
    });
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      const l = await this.api.lister('/api/commercial/prospects/', { annee: 'active', statut: this.statut(), q: this.q() });
      const ordre: Record<string, number> = { PREINSCRIT: 0, CONTACTE: 1, NOUVEAU: 2, INSCRIT: 3 };
      const rang = (p: any) => (p.etudiant && p.statut !== 'INSCRIT' ? 2.5 : (ordre[p.statut] ?? 9));
      this.liste.set(l.sort((a, b) => rang(a) - rang(b) || String(a.nom).localeCompare(String(b.nom), 'fr')));
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  async preinscrire(p: any): Promise<void> {
    const ok = await confirmer(this.dialog, { titre: 'Pré-inscrire', message: `Créer la pré-inscription de ${p.nom} ${p.prenoms} (dossier à compléter) ?`, confirmer: 'Pré-inscrire' });
    if (!ok) {
      return;
    }
    try {
      await this.api.post(`/api/commercial/prospects/${p.id}/preinscrire/`);
      this.snack.open('Pré-inscription créée.', 'OK', { duration: 3000 });
      await this.charger();
      this.sync.planifier(300);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }

  async inscrire(p: any): Promise<void> {
    const r = await inscrireDialogue(this.dialog, {
      titre: 'Inscrire le prospect', personne: `${p.nom} ${p.prenoms}`, chemin: `/api/commercial/prospects/${p.id}/inscrire/`, filiereSouhaitee: p.filiere_souhaitee,
    });
    if (!r) {
      return;
    }
    const ref = this.snack.open('Inscription créée (en attente de validation par la scolarité).', this.auth.peut('scolarite.inscription.lire') ? 'Ouvrir le dossier' : 'OK', { duration: 8000 });
    ref.onAction().subscribe(() => this.auth.peut('scolarite.inscription.lire') && void this.router.navigate(['/scolarite/etudiants', r.etudiant.id]));
    await this.charger();
    this.sync.planifier(300);
  }
}
