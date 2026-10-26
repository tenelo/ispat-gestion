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

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { db } from '../../core/db';
import { DECISIONS, LIBELLES_DECISION, ecrireNote, libelleChamp, valeurHistorique } from '../../core/notes';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { choisir } from '../../shared/choix';
import { confirmer } from '../../shared/confirmation';
import { modifierAvecMotif } from '../../shared/modification-motivee';
import { telecharger } from '../../shared/telecharger';

/**
 * Tableau des moyennes d'une classe pour un semestre (délibération). Connexion nécessaire.
 *   validation   — calcul, validation (exige les notes d'examen validées), export ;
 *   modification — moyenne d'une matière ou décision modifiée avec motif, réouverture.
 */
@Component({
  selector: 'app-moyennes',
  imports: [MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, DatePipe],
  templateUrl: './moyennes.html',
  styleUrl: './notes.scss',
})
export class MoyennesPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);
  readonly ecrireNote = ecrireNote;
  readonly valeurHistorique = valeurHistorique;
  readonly libelleChamp = libelleChamp;
  readonly decisions = LIBELLES_DECISION;

  readonly mode: 'validation' | 'modification' = inject(ActivatedRoute).snapshot.routeConfig?.path?.includes('modification') ? 'modification' : 'validation';
  readonly titre = this.mode === 'validation' ? 'Validation des moyennes' : 'Modification des moyennes';
  readonly peutCalculer = computed(() => this.auth.peut('moyenne.calcul.creer'));
  readonly peutValider = computed(() => this.auth.peut('moyenne.validation_moyenne.valider'));
  readonly peutModifier = computed(() => this.auth.peut('moyenne.modification_moyenne.modifier'));

  readonly ref = resource({
    loader: async () => {
      const annee = (await db.table_('annee_academique').toArray()).find((a) => a['est_active']);
      const classes = (await db.table_('classe').toArray()).filter((c) => c['annee_id'] === annee?.id)
        .sort((a, b) => String(a['libelle']).localeCompare(String(b['libelle']), 'fr'));
      const semestres = (await db.table_('semestre').toArray()).filter((s) => s['annee_id'] === annee?.id).sort((a, b) => a['numero'] - b['numero']);
      if (!this.classeId() && classes.length) {
        this.classeId.set(classes[0].id);
      }
      if (!this.semestreId() && semestres.length) {
        this.semestreId.set(semestres[0].id);
      }
      return { classes, semestres };
    },
  });

  readonly classeId = signal('');
  readonly semestreId = signal('');
  readonly tableau = signal<any | null>(null);
  readonly historique = signal<any[]>([]);
  readonly chargement = signal(false);
  readonly action = signal(false);

  readonly tousValides = computed(() => {
    const t = this.tableau();
    return !!t && t.etudiants.length > 0 && t.etudiants.every((e: any) => e.statut === 'VALIDEE');
  });
  readonly aucunCalcul = computed(() => !!this.tableau() && this.tableau().statistiques.classes_calculees === 0);

  constructor() {
    effect(() => {
      const p = { c: this.classeId(), s: this.semestreId(), enLigne: this.reseau.enLigne() };
      untracked(() => p.enLigne && p.c && p.s && void this.charger());
    });
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      this.tableau.set(await this.api.get('/api/notes/moyennes/tableau/', { classe: this.classeId(), semestre: this.semestreId() }));
      if (this.mode === 'modification') {
        const h = await this.api.get<any[]>('/api/notes/historique/', { classe: this.classeId(), semestre: this.semestreId() });
        this.historique.set(h.filter((x) => x.table_nom !== 'note'));
      }
    } catch (e) {
      this.tableau.set(null);
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    } finally {
      this.chargement.set(false);
    }
  }

  cellule(e: any, matiereId: string): any {
    return e.moyennes?.[matiereId] ?? null;
  }

  // -- Validation -------------------------------------------------------------------------------
  async calculer(): Promise<void> {
    await this.executer(async () => {
      const r = await this.api.post('/api/notes/moyennes/calculer/', { classe: this.classeId(), semestre: this.semestreId() });
      return `Moyennes calculées : ${r.admis} admis, ${r.session2} en session 2, ${r.ajournes} ajourné(s).`;
    });
  }

  async valider(): Promise<void> {
    const t = this.tableau();
    const ok = await confirmer(this.dialog, {
      titre: 'Valider les moyennes',
      message: `${t?.classe.libelle} — semestre ${t?.semestre.numero}\n\nLes moyennes sont recalculées puis figées. Ensuite, toute correction passe par « Modification des moyennes » avec un motif.`,
      confirmer: 'Valider',
    });
    if (!ok) {
      return;
    }
    await this.executer(async () => {
      const r = await this.api.post('/api/notes/moyennes/valider/', { classe: this.classeId(), semestre: this.semestreId() });
      return `${r.moyennes_matiere_validees} moyenne(s) de matière et ${r.moyennes_semestre_validees} moyenne(s) de semestre validées.`;
    }, (err) => {
      const m = err.brut?.matieres as { matiere: string; raison: string }[] | undefined;
      return m?.length ? `${err.message}\n${m.map((x) => `${x.matiere} : ${x.raison}`).join(' · ')}` : err.message;
    });
  }

  async exporter(): Promise<void> {
    try {
      const f = await this.api.fichier('/api/notes/moyennes/tableau/', { classe: this.classeId(), semestre: this.semestreId(), export: 'xlsx' });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  // -- Modification -----------------------------------------------------------------------------
  peutModifierCellule(c: any): boolean {
    return this.mode === 'modification' && this.peutModifier() && c?.statut === 'VALIDEE';
  }

  async modifierMoyenne(e: any, m: any): Promise<void> {
    const c = this.cellule(e, m.id);
    if (!this.peutModifierCellule(c)) {
      return;
    }
    const r = await modifierAvecMotif(this.dialog, {
      titre: `${m.code} — ${e.nom} ${e.prenoms}`,
      message: `Moyenne actuelle : ${ecrireNote(c.moyenne_finale)}. La moyenne du semestre et les rangs sont recalculés.`,
      type: 'note', libelle: 'Nouvelle moyenne /20', valeur: c.moyenne_finale,
    });
    if (r) {
      await this.executer(async () => {
        await this.api.post(`/api/notes/moyennes/matieres/${c.id}/modifier/`, { moyenne: r.valeur, motif: r.motif });
        return 'Moyenne modifiée.';
      });
    }
  }

  async modifierDecision(e: any): Promise<void> {
    if (this.mode !== 'modification' || !this.peutModifier() || !e.moyenne_semestre_id) {
      return;
    }
    const r = await modifierAvecMotif(this.dialog, {
      titre: `Décision — ${e.nom} ${e.prenoms}`,
      message: `Moyenne du semestre : ${ecrireNote(e.moyenne)} · décision actuelle : ${LIBELLES_DECISION[e.decision] ?? '—'}`,
      type: 'choix', libelle: 'Nouvelle décision', options: DECISIONS, valeur: e.decision,
    });
    if (r) {
      await this.executer(async () => {
        await this.api.post(`/api/notes/moyennes/semestre/${e.moyenne_semestre_id}/modifier/`, { decision: r.valeur, motif: r.motif });
        return 'Décision modifiée.';
      });
    }
  }

  async appreciation(e: any): Promise<void> {
    if (!this.peutModifier() || !e.moyenne_semestre_id) {
      return;
    }
    const texte = await choisir(this.dialog, { titre: `Appréciation — ${e.nom} ${e.prenoms}`, libelle: 'Appréciation (bulletin)', confirmer: 'Enregistrer', minimum: 2 });
    if (texte) {
      await this.executer(async () => {
        await this.api.post(`/api/notes/moyennes/semestre/${e.moyenne_semestre_id}/modifier/`, { appreciation: texte });
        return 'Appréciation enregistrée.';
      });
    }
  }

  async rouvrir(): Promise<void> {
    const r = await modifierAvecMotif(this.dialog, {
      titre: 'Rouvrir les moyennes',
      message: 'Les moyennes validées de la classe repassent à l\'état « calculée » : corriger les notes puis recalculer et valider à nouveau.',
      type: 'aucun', confirmer: 'Rouvrir',
    });
    if (r) {
      await this.executer(async () => {
        const rep = await this.api.post('/api/notes/moyennes/rouvrir/', { classe: this.classeId(), semestre: this.semestreId(), motif: r.motif });
        return `${rep.moyennes_matiere_rouvertes} moyenne(s) de matière rouverte(s).`;
      });
    }
  }

  private async executer(fn: () => Promise<string>, message?: (e: ErreurApi) => string): Promise<void> {
    this.action.set(true);
    try {
      this.snack.open(await fn(), 'OK', { duration: 5000 });
      await this.charger();
      this.sync.planifier(300);
    } catch (e) {
      const err = e as ErreurApi;
      this.snack.open(message ? message(err) : err.message, 'OK', { duration: 9000 });
    } finally {
      this.action.set(false);
    }
  }
}
