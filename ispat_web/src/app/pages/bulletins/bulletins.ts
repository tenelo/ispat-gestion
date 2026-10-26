import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, resource, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute } from '@angular/router';

import { ApiService, ErreurApi, Parametres } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { db } from '../../core/db';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { confirmer } from '../../shared/confirmation';
import { telecharger } from '../../shared/telecharger';

type Mode = 'semestre-1' | 'semestre-2' | 'examen-session-1' | 'examen-session-2';

/**
 * Bulletins de semestre et relevés de notes d'examen (PDF, connexion nécessaire).
 *   Provisoire : filigrane, non numéroté, possible avant validation (contrôle).
 *   Officiel   : numéroté, archivé, exige les moyennes / notes d'examen validées.
 */
@Component({
  selector: 'app-bulletins',
  imports: [MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, DatePipe],
  templateUrl: './bulletins.html',
  styleUrl: './bulletins.scss',
})
export class BulletinsPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);

  readonly mode = (inject(ActivatedRoute).snapshot.routeConfig?.path?.replace('bulletins/', '') ?? 'semestre-1') as Mode;
  readonly releve = this.mode.startsWith('examen');
  readonly session = this.mode === 'examen-session-2' ? 2 : this.mode === 'examen-session-1' ? 1 : null;
  readonly titre = this.releve ? `Relevés de notes d'examen — session ${this.session}` : `Bulletins du semestre ${this.mode.slice(-1)}`;
  private readonly ressource = this.releve ? `examen_session${this.session}` : `semestre${this.mode.slice(-1)}`;
  readonly peutOfficiel = computed(() => this.auth.peut(`bulletin.${this.ressource}.creer`));
  readonly peutProvisoire = computed(() => this.auth.peut(`bulletin.${this.ressource}.lire`));

  readonly classeId = signal('');
  readonly semestreNumero = signal(this.releve ? 1 : Number(this.mode.slice(-1)));
  readonly enCours = signal<string | null>(null);
  readonly editions = signal<any[]>([]);

  readonly ref = resource({
    params: () => ({ r: this.sync.revision() }),
    loader: async () => {
      const annee = (await db.table_('annee_academique').toArray()).find((a) => a['est_active']);
      const classes = (await db.table_('classe').toArray()).filter((c) => c['annee_id'] === annee?.id)
        .sort((a, b) => String(a['libelle']).localeCompare(String(b['libelle']), 'fr'));
      const semestres = (await db.table_('semestre').toArray()).filter((s) => s['annee_id'] === annee?.id);
      if (!this.classeId() && classes.length) {
        this.classeId.set(classes[0].id);
      }
      return { annee, classes, semestres };
    },
  });

  readonly semestre = computed(() => this.ref.value()?.semestres.find((s) => Number(s['numero']) === this.semestreNumero()));

  readonly etudiants = resource({
    params: () => ({ c: this.classeId(), r: this.sync.revision() }),
    loader: async ({ params }) => {
      const inscriptions = await db.table_('inscription').where('classe_id').equals(params.c).filter((i) => ['VALIDEE', 'ABANDON'].includes(i['etat'])).toArray();
      const etudiants = await db.table_('etudiant').bulkGet(inscriptions.map((i) => i['etudiant_id']));
      return inscriptions.map((i, k) => ({ inscription: i, etudiant: etudiants[k] }))
        .filter((x) => !!x.etudiant)
        .sort((a, b) => `${a.etudiant!['nom']} ${a.etudiant!['prenoms']}`.localeCompare(`${b.etudiant!['nom']} ${b.etudiant!['prenoms']}`, 'fr'));
    },
  });

  readonly derniereEdition = computed(() => {
    const m = new Map<string, any>();
    for (const e of this.editions()) {
      if (!m.has(e.inscription_id)) {
        m.set(e.inscription_id, e);
      }
    }
    return m;
  });

  constructor() {
    effect(() => {
      const p = { c: this.classeId(), s: this.semestre()?.id, enLigne: this.reseau.enLigne() };
      untracked(() => p.enLigne && p.c && p.s && void this.chargerEditions());
    });
  }

  async chargerEditions(): Promise<void> {
    try {
      const liste = await this.api.get<any[]>('/api/bulletins/editions/', {
        classe: this.classeId(), semestre: this.semestre()?.id, type: this.releve ? 'RELEVE_EXAMEN' : 'SEMESTRE', session: this.session ?? '',
      });
      this.editions.set(liste.sort((a, b) => String(b.date_edition).localeCompare(String(a.date_edition))));
    } catch {
      this.editions.set([]);
    }
  }

  /** Édition (une classe entière ou un étudiant). */
  async editer(officiel: boolean, inscriptionId?: string): Promise<void> {
    const semestre = this.semestre();
    if (!semestre) {
      return;
    }
    if (officiel && !inscriptionId) {
      const ok = await confirmer(this.dialog, {
        titre: 'Édition officielle',
        message: 'Chaque document reçoit un numéro et une copie est archivée. Une nouvelle édition remplace l\'archive et garde le même numéro.',
        confirmer: 'Éditer',
      });
      if (!ok) {
        return;
      }
    }
    const params: Parametres = { semestre: semestre.id, provisoire: officiel ? '' : 'true', session: this.session ?? '' };
    if (inscriptionId) {
      params['inscription'] = inscriptionId;
    } else {
      params['classe'] = this.classeId();
    }
    this.enCours.set(inscriptionId ?? 'classe');
    try {
      const f = await this.api.fichier(this.releve ? '/api/bulletins/releve/' : '/api/bulletins/semestre/', params);
      this.ouvrirPdf(f.blob, f.nom);
      if (officiel) {
        this.snack.open('Édition officielle numérotée et archivée.', 'OK', { duration: 4000 });
        await this.chargerEditions();
      }
    } catch (e) {
      const err = e as ErreurApi;
      const blocages = err.brut?.blocages as { matricule?: string; nom?: string; raison: string }[] | undefined;
      if (err.statut === 409 && blocages?.length) {
        const ok = await confirmer(this.dialog, {
          titre: 'Édition officielle impossible',
          message: `${blocages.slice(0, 10).map((b) => `• ${b.matricule ? b.matricule + ' ' + b.nom + ' : ' : ''}${b.raison}`).join('\n')}${blocages.length > 10 ? '\n…' : ''}\n\nÉditer une version provisoire (filigrane, non numérotée) pour contrôle ?`,
          confirmer: 'Version provisoire',
        });
        if (ok) {
          this.enCours.set(null);
          await this.editer(false, inscriptionId);
        }
      } else {
        this.snack.open(err.message, 'OK', { duration: 6000 });
      }
    } finally {
      this.enCours.set(null);
    }
  }

  async archive(e: any): Promise<void> {
    try {
      const f = await this.api.fichier(e.fichier_url);
      this.ouvrirPdf(f.blob, `${e.numero}.pdf`);
    } catch (err) {
      this.snack.open((err as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  private ouvrirPdf(blob: Blob, nom: string): void {
    const url = URL.createObjectURL(blob);
    if (!window.open(url, '_blank')) {
      telecharger(blob, nom);
    }
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  }
}
