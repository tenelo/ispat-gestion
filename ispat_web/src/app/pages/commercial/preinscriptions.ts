import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
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
import { choisir } from '../../shared/choix';
import { telecharger } from '../../shared/telecharger';
import { inscrireDialogue } from './inscrire-dialog';

export const STATUTS_PREINSCRIPTION: [string, string][] = [
  ['EN_ATTENTE', 'En attente'], ['VALIDEE', 'Dossier accepté'], ['REJETEE', 'Rejetée'], ['CONVERTIE', 'Inscrite'],
];
const SOURCES: Record<string, string> = { SITE_WEB: 'Site web', GUICHET: 'Guichet', PROSPECTION: 'Prospection' };

/** Pré-inscriptions (site web, guichet, prospection) : examen du dossier, pièces, inscription. Connexion nécessaire. */
@Component({
  selector: 'app-preinscriptions',
  imports: [MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule, MatProgressBarModule,
    MatTooltipModule, MatDialogModule, DatePipe],
  templateUrl: './preinscriptions.html',
  styleUrl: './commercial.scss',
})
export class PreinscriptionsPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  readonly reseau = inject(ReseauService);
  readonly statuts = STATUTS_PREINSCRIPTION;
  readonly libelleStatut = Object.fromEntries(STATUTS_PREINSCRIPTION);
  readonly sources = SOURCES;

  readonly peutValider = computed(() => this.auth.peut('commercial.preinscription.valider'));
  readonly peutInscrire = computed(() => this.auth.peut(['commercial.inscription_prospect.creer', 'scolarite.inscription.creer']));
  readonly peutExporter = computed(() => this.auth.peut(['commercial.liste_prospect.exporter', 'scolarite.liste_classe.exporter']));

  readonly statut = signal('EN_ATTENTE,VALIDEE');
  readonly source = signal('');
  readonly q = signal('');
  readonly liste = signal<any[]>([]);
  readonly chargement = signal(false);
  readonly detail = signal<any | null>(null);
  readonly pieces = signal<any | null>(null);

  constructor() {
    effect(() => {
      const p = { statut: this.statut(), source: this.source(), q: this.q(), enLigne: this.reseau.enLigne() };
      untracked(() => p.enLigne && void this.charger());
    });
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      this.liste.set(await this.api.lister('/api/commercial/preinscriptions/', { annee: 'active', statut: this.statut(), source: this.source(), q: this.q() }));
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  async ouvrir(p: any, modele: any): Promise<void> {
    this.detail.set(p);
    this.pieces.set(null);
    this.dialog.open(modele, { width: '760px', maxWidth: '96vw' });
    try {
      this.pieces.set(await this.api.get(`/api/commercial/preinscriptions/${p.id}/pieces/`));
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 4000 });
    }
  }

  libelles(liste: { libelle: string }[]): string {
    return liste.map((x) => x.libelle).join(', ');
  }

  async ouvrirPiece(piece: any): Promise<void> {
    try {
      const f = await this.api.fichier(piece.url);
      const url = URL.createObjectURL(f.blob);
      if (!window.open(url, '_blank')) {
        telecharger(f.blob, piece.nom_fichier);
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 4000 });
    }
  }

  async valider(p: any): Promise<void> {
    await this.executer(() => this.api.post(`/api/commercial/preinscriptions/${p.id}/valider/`), 'Dossier accepté.');
  }

  async rejeter(p: any): Promise<void> {
    const motif = await choisir(this.dialog, { titre: `Rejeter la pré-inscription de ${p.nom} ${p.prenoms}`, libelle: 'Motif du rejet', minimum: 3, confirmer: 'Rejeter' });
    if (motif) {
      await this.executer(() => this.api.post(`/api/commercial/preinscriptions/${p.id}/rejeter/`, { motif }), 'Pré-inscription rejetée.');
    }
  }

  async inscrire(p: any): Promise<void> {
    const r = await inscrireDialogue(this.dialog, {
      titre: 'Inscrire', personne: `${p.nom} ${p.prenoms}`, chemin: `/api/commercial/preinscriptions/${p.id}/inscrire/`, filiereSouhaitee: p.filiere_souhaitee,
    });
    if (!r) {
      return;
    }
    this.dialog.closeAll();
    const dossier = this.auth.peut('scolarite.inscription.lire');
    const ref = this.snack.open(r.avertissement ?? 'Inscription créée (en attente de validation par la scolarité).', dossier ? 'Ouvrir le dossier' : 'OK', { duration: 8000 });
    ref.onAction().subscribe(() => dossier && void this.router.navigate(['/scolarite/etudiants', r.etudiant.id]));
    await this.charger();
    this.sync.planifier(300);
  }

  async exporter(): Promise<void> {
    try {
      const f = await this.api.fichier('/api/commercial/preinscriptions/', { annee: 'active', statut: this.statut(), source: this.source(), q: this.q(), export: 'xlsx' });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  private async executer(fn: () => Promise<any>, message: string): Promise<void> {
    try {
      const r = await fn();
      this.snack.open(message, 'OK', { duration: 3000 });
      if (this.detail()?.id === r?.id) {
        this.detail.set(r);
      }
      await this.charger();
      this.sync.planifier(300);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }
}
