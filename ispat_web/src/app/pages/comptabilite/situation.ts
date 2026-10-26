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
import { MatTabsModule } from '@angular/material/tabs';
import { Router } from '@angular/router';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { db } from '../../core/db';
import { fcfa, libelleMode } from '../../core/finances';
import { ReseauService } from '../../core/reseau.service';
import { telecharger } from '../../shared/telecharger';

/** Situation financière : par classe (taux de recouvrement) et par étudiant (débiteurs), détail d'une inscription. */
@Component({
  selector: 'app-situation',
  imports: [MatTabsModule, MatFormFieldModule, MatSelectModule, MatInputModule, MatButtonModule, MatIconModule,
    MatProgressBarModule, MatDialogModule, DatePipe],
  templateUrl: './situation.html',
  styleUrl: './comptabilite.scss',
})
export class SituationPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  readonly reseau = inject(ReseauService);
  readonly fcfa = fcfa;
  readonly libelleMode = libelleMode;
  readonly peutExporter = computed(() => this.auth.peut('comptabilite.situation.exporter'));
  readonly peutEncaisser = computed(() => this.auth.peut('comptabilite.versement.creer'));

  readonly classes = signal<any | null>(null);
  readonly etudiants = signal<any | null>(null);
  readonly detail = signal<any | null>(null);
  readonly chargement = signal(false);
  readonly listeClasses = signal<{ id: string; libelle: string }[]>([]);

  readonly classe = signal('');
  readonly solde = signal('debiteur');
  readonly etat = signal('');
  readonly q = signal('');

  constructor() {
    void db.table_('classe').toArray().then(async (cl) => {
      const annee = (await db.table_('annee_academique').toArray()).find((a) => a['est_active']);
      this.listeClasses.set(cl.filter((c) => c['annee_id'] === annee?.id).map((c) => ({ id: c.id, libelle: c['libelle'] }))
        .sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr')));
    });
    effect(() => {
      const enLigne = this.reseau.enLigne();
      const p = { classe: this.classe(), solde: this.solde(), etat: this.etat(), q: this.q() };
      untracked(() => enLigne && void this.charger(p));
    });
  }

  private async charger(p: { classe: string; solde: string; etat: string; q: string }): Promise<void> {
    this.chargement.set(true);
    try {
      const [c, e] = await Promise.all([
        this.api.get('/api/comptabilite/situation/classes/', { annee: 'active' }),
        this.api.get('/api/comptabilite/situation/', { annee: 'active', ...p }),
      ]);
      this.classes.set(c);
      this.etudiants.set(e);
    } catch (err) {
      this.snack.open((err as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  voirClasse(id: string): void {
    this.classe.set(id);
    this.solde.set('');
  }

  async ouvrir(inscriptionId: string, modele: any): Promise<void> {
    try {
      this.detail.set(await this.api.get(`/api/comptabilite/situation/${inscriptionId}/`));
      this.dialog.open(modele, { width: '860px', maxWidth: '96vw' });
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  encaisser(inscriptionId: string): void {
    this.dialog.closeAll();
    void this.router.navigate(['/comptabilite/versements'], { queryParams: { inscription: inscriptionId } });
  }

  async exporter(classes: boolean): Promise<void> {
    try {
      const f = classes
        ? await this.api.fichier('/api/comptabilite/situation/classes/', { annee: 'active', export: 'xlsx' })
        : await this.api.fichier('/api/comptabilite/situation/', { annee: 'active', classe: this.classe(), solde: this.solde(), etat: this.etat(), q: this.q(), export: 'xlsx' });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }
}
