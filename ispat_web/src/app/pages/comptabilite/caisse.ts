import { DatePipe } from '@angular/common';
import { Component, computed, inject, resource, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute } from '@angular/router';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { MODES_PAIEMENT, fcfa, libelleMode } from '../../core/finances';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { aujourdhui, normaliser } from '../../core/texte';
import { choisir } from '../../shared/choix';
import { telecharger } from '../../shared/telecharger';
import { MouvementFormulaire } from './mouvement-formulaire';

/** Entrées ou sorties de caisse (selon l'URL), journal de caisse et synthèse. */
@Component({
  selector: 'app-caisse',
  imports: [MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatTabsModule,
    MatTooltipModule, MatProgressBarModule, DatePipe],
  templateUrl: './caisse.html',
  styleUrl: './comptabilite.scss',
})
export class CaissePage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);

  readonly sens: 'ENTREE' | 'SORTIE' = inject(ActivatedRoute).snapshot.routeConfig?.path?.endsWith('sorties') ? 'SORTIE' : 'ENTREE';
  readonly code = this.sens === 'ENTREE' ? 'entree' : 'sortie';
  readonly titre = this.sens === 'ENTREE' ? 'Entrées de caisse' : 'Sorties de caisse';
  readonly fcfa = fcfa;
  readonly libelleMode = libelleMode;
  readonly modes = MODES_PAIEMENT;

  readonly peutCreer = computed(() => this.auth.peut(`comptabilite.${this.code}.creer`));
  readonly peutModifier = computed(() => this.auth.peut(`comptabilite.${this.code}.modifier`));
  readonly peutAnnuler = computed(() => this.auth.peut(`comptabilite.${this.code}.supprimer`));
  readonly peutExporter = computed(() => this.auth.peut(`comptabilite.${this.code}.exporter`));
  readonly voitJournal = computed(() => this.auth.peut('comptabilite.entree.lire') && this.auth.peut('comptabilite.sortie.lire'));

  readonly du = signal(this.debutMois());
  readonly au = signal(aujourdhui());
  readonly categorie = signal('');
  readonly texte = signal('');
  readonly inclureVersements = signal(false);

  readonly donnees = resource({
    params: () => ({ du: this.du(), au: this.au(), r: this.sync.revision() }),
    loader: async ({ params }) => {
      const [mouvements, categories] = await Promise.all([
        db.table_('mouvement_caisse').where('sens').equals(this.sens)
          .filter((m) => m['date_mouvement'] >= params.du && m['date_mouvement'] <= params.au).toArray(),
        db.table_('categorie_mouvement').where('sens').equals(this.sens).toArray(),
      ]);
      const cat = new Map(categories.map((c) => [c.id, c]));
      return {
        categories: categories.sort((a, b) => String(a['libelle']).localeCompare(String(b['libelle']), 'fr')),
        lignes: mouvements.map((m) => ({ m, categorie: cat.get(m['categorie_id'])?.['libelle'] ?? '—' }))
          .sort((a, b) => String(b.m['date_mouvement']).localeCompare(String(a.m['date_mouvement']))),
      };
    },
  });

  readonly lignes = computed(() => {
    const mots = normaliser(this.texte()).split(' ').filter(Boolean);
    return (this.donnees.value()?.lignes ?? []).filter((l) =>
      (this.inclureVersements() || !l.m['versement_id'])
      && (!this.categorie() || l.m['categorie_id'] === this.categorie())
      && mots.every((x) => normaliser(`${l.m['libelle']} ${l.m['tiers'] ?? ''} ${l.m['reference'] ?? ''} ${l.categorie}`).includes(x)));
  });

  readonly total = computed(() => this.lignes().filter((l) => !l.m['annule']).reduce((s, l) => s + Number(l.m['montant']), 0));
  readonly parCategorie = computed(() => {
    const t = new Map<string, number>();
    for (const l of this.lignes().filter((x) => !x.m['annule'])) {
      t.set(l.categorie, (t.get(l.categorie) ?? 0) + Number(l.m['montant']));
    }
    return [...t.entries()].sort((a, b) => b[1] - a[1]);
  });

  // -- Journal et synthèse (serveur) -------------------------------------------------------------
  readonly journal = signal<any | null>(null);
  readonly synthese = signal<any | null>(null);
  readonly chargement = signal(false);

  async chargerJournal(): Promise<void> {
    if (!this.reseau.enLigne() || !this.voitJournal()) {
      return;
    }
    this.chargement.set(true);
    try {
      const [j, s] = await Promise.all([
        this.api.get('/api/comptabilite/caisse/journal/', { du: this.du(), au: this.au() }),
        this.api.get('/api/comptabilite/caisse/synthese/', { du: this.du(), au: this.au() }),
      ]);
      this.journal.set(j);
      this.synthese.set(s);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  changerOnglet(index: number): void {
    if (index === 1) {
      void this.chargerJournal();
    }
  }

  // -- Actions ------------------------------------------------------------------------------------
  ouvrir(ligne: Ligne | null): void {
    this.dialog.open(MouvementFormulaire, { data: { sens: this.sens, ligne }, width: '640px', maxWidth: '96vw' })
      .afterClosed().subscribe((ok) => ok && this.snack.open('Écriture enregistrée.', 'OK', { duration: 3000 }));
  }

  async annuler(m: Ligne): Promise<void> {
    const motif = await choisir(this.dialog, {
      titre: 'Annuler l\'écriture', message: `${m['libelle']} — ${fcfa(m['montant'])}`, libelle: 'Motif', minimum: 3, confirmer: 'Annuler l\'écriture',
    });
    if (!motif) {
      return;
    }
    try {
      await this.api.post(`/api/comptabilite/mouvements/${m.id}/annuler/`, { motif });
      this.snack.open('Écriture annulée.', 'OK', { duration: 3000 });
      await this.sync.synchroniser();
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }

  async joindre(m: Ligne, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) {
      return;
    }
    const corps = new FormData();
    corps.append('justificatif', f, f.name);
    try {
      await this.api.post(`/api/comptabilite/mouvements/${m.id}/justificatif/`, corps);
      this.snack.open('Justificatif enregistré.', 'OK', { duration: 3000 });
      await this.sync.synchroniser();
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }

  async voirJustificatif(m: Ligne): Promise<void> {
    try {
      const f = await this.api.fichier(`/api/comptabilite/mouvements/${m.id}/justificatif/`);
      const url = URL.createObjectURL(f.blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  async exporter(journal = false): Promise<void> {
    try {
      const f = journal
        ? await this.api.fichier('/api/comptabilite/caisse/journal/', { du: this.du(), au: this.au(), export: 'xlsx' })
        : await this.api.fichier('/api/comptabilite/mouvements/', { sens: this.sens, du: this.du(), au: this.au(), export: 'xlsx' });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  changerPeriode(du: string, au: string): void {
    this.du.set(du);
    this.au.set(au);
    if (this.journal()) {
      void this.chargerJournal();
    }
  }

  private debutMois(): string {
    const a = aujourdhui();
    return `${a.slice(0, 8)}01`;
  }

  libelleMois(iso: string): string {
    return new Date(iso + 'T00:00:00').toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  }
}
