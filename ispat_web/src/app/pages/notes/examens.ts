import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
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
import { ecrireNote, valeurHistorique } from '../../core/notes';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { confirmer } from '../../shared/confirmation';
import { modifierAvecMotif } from '../../shared/modification-motivee';

/**
 * Notes d'examen (connexion nécessaire) :
 *   validation   — fige les notes d'examen d'une matière (préalable à la validation des moyennes) ;
 *   modification — corrige une note validée avec un motif (historique conservé).
 */
@Component({
  selector: 'app-examens',
  imports: [MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, DatePipe],
  templateUrl: './examens.html',
  styleUrl: './notes.scss',
})
export class ExamensPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);
  readonly ecrireNote = ecrireNote;
  readonly valeurHistorique = valeurHistorique;

  readonly mode: 'validation' | 'modification' = inject(ActivatedRoute).snapshot.routeConfig?.path?.includes('modification') ? 'modification' : 'validation';
  readonly titre = this.mode === 'validation' ? 'Validation des notes d\'examen' : 'Modification des notes d\'examen';
  readonly peutValider = computed(() => this.auth.peut('moyenne.validation_note_examen.valider'));
  readonly peutModifier = computed(() => this.auth.peut('moyenne.modification_note_examen.modifier'));

  readonly examens = signal<any[]>([]);
  readonly classeId = signal('');
  readonly etat = signal(this.mode === 'validation' ? 'a_valider' : 'validees');
  readonly examenId = signal<string | null>(null);
  readonly grille = signal<any | null>(null);
  readonly historique = signal<any[]>([]);
  readonly chargement = signal(false);

  readonly classes = computed(() => {
    const vus = new Map<string, string>();
    for (const e of this.examens()) {
      vus.set(e.classe, e.classe_libelle);
    }
    return [...vus.entries()].sort((a, b) => a[1].localeCompare(b[1], 'fr'));
  });

  readonly liste = computed(() => this.examens().filter((e) => (!this.classeId() || e.classe === this.classeId())
    && (this.etat() === 'tous' || (this.etat() === 'a_valider' ? e.nb_notes > e.nb_validees || e.nb_notes === 0 : e.nb_validees > 0))));

  constructor() {
    effect(() => {
      if (this.reseau.enLigne()) {
        untracked(() => void this.charger());
      }
    });
  }

  async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      const liste = await this.api.lister('/api/notes/evaluations/', { type: 'EXAMEN', annee: 'active' });
      this.examens.set(liste.sort((a, b) => String(a.classe_libelle).localeCompare(String(b.classe_libelle), 'fr')
        || a.semestre_numero - b.semestre_numero || String(a.matiere_code).localeCompare(String(b.matiere_code)) || a.session - b.session));
      if (this.examenId()) {
        await this.ouvrir(this.examenId()!);
      }
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    } finally {
      this.chargement.set(false);
    }
  }

  async ouvrir(id: string): Promise<void> {
    this.examenId.set(id);
    try {
      this.grille.set(await this.api.get(`/api/notes/evaluations/${id}/grille/`));
      if (this.mode === 'modification') {
        const ex = this.examens().find((e) => e.id === id);
        const h = await this.api.get<any[]>('/api/notes/historique/', { table: 'note', classe: ex?.classe });
        const ids = new Set((this.grille()?.etudiants ?? []).map((l: any) => l.note?.id).filter(Boolean));
        this.historique.set(h.filter((x) => ids.has(x.enregistrement_id)));
      }
    } catch (e) {
      this.grille.set(null);
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }

  async valider(forcer = false): Promise<void> {
    const id = this.examenId();
    if (!id) {
      return;
    }
    try {
      const r = await this.api.post(`/api/notes/evaluations/${id}/valider/`, forcer ? { forcer: true } : {});
      this.snack.open(`${r.validees} note(s) validée(s)${r.manquantes ? `, ${r.manquantes} manquante(s)` : ''}.`, 'OK', { duration: 5000 });
      await this.charger();
      this.sync.planifier(300);
    } catch (e) {
      const err = e as ErreurApi;
      const manquants = err.brut?.manquants as { matricule: string; nom: string }[] | undefined;
      if (err.statut === 409 && manquants?.length && !forcer) {
        const ok = await confirmer(this.dialog, {
          titre: 'Notes manquantes',
          message: `${manquants.length} étudiant(s) sans note :\n${manquants.slice(0, 12).map((m) => `• ${m.matricule ?? ''} ${m.nom}`).join('\n')}${manquants.length > 12 ? '\n…' : ''}\n\nValider quand même ? Les notes manquantes ne pourront plus être saisies que par modification motivée.`,
          confirmer: 'Valider quand même',
        });
        if (ok) {
          await this.valider(true);
        }
      } else {
        this.snack.open(err.message, 'OK', { duration: 6000 });
      }
    }
  }

  async modifier(ligne: any): Promise<void> {
    const n = ligne.note;
    if (!n) {
      return;
    }
    const r = await modifierAvecMotif(this.dialog, {
      titre: `Note de ${ligne.nom} ${ligne.prenoms}`,
      message: `Note actuelle : ${n.absent ? 'absent' : ecrireNote(n.valeur)}`,
      type: 'note', valeur: n.valeur, absent: n.absent, absentPossible: true,
    });
    if (!r) {
      return;
    }
    try {
      const rep = await this.api.patch(`/api/notes/notes/${n.id}/`, r.absent ? { absent: true, motif: r.motif } : { valeur: r.valeur, absent: false, motif: r.motif });
      this.snack.open(rep.avertissement ?? 'Note modifiée.', 'OK', { duration: rep.avertissement ? 9000 : 3000 });
      await this.ouvrir(this.examenId()!);
      this.sync.planifier(300);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }
}
