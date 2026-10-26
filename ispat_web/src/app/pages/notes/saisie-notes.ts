import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, resource, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { Cours, LIBELLES_TYPE, coursAccessibles, ecrireNote, libelleEvaluation, lireNote, seuilValidation } from '../../core/notes';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { confirmer } from '../../shared/confirmation';
import { EvaluationFormulaire } from './evaluation-formulaire';

interface LigneGrille {
  inscriptionId: string;
  matricule: string | null;
  nom: string;
  prenoms: string;
  texte: string;          // saisie en cours
  absent: boolean;
  initialTexte: string;
  initialAbsent: boolean;
  verrouillee: boolean;
  enAttente: boolean;
}

const ORDRE_TYPES: Record<string, number> = { DEVOIR: 1, INTERROGATION: 2, TP: 3, EXPOSE: 4, EXAMEN: 5 };

/**
 * Saisie des notes par évaluation, hors ligne possible : les notes partent à la synchronisation
 * (une note validée ou une moyenne validée ne se modifie plus ici).
 */
@Component({
  selector: 'app-saisie-notes',
  imports: [MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule, MatTooltipModule, DatePipe],
  templateUrl: './saisie-notes.html',
  styleUrl: './notes.scss',
})
export class SaisieNotesPage {
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);
  readonly libelleType = LIBELLES_TYPE;
  readonly libelleEvaluation = libelleEvaluation;

  readonly peutCreer = computed(() => this.auth.peut('moyenne.note.creer'));
  readonly peutModifier = computed(() => this.auth.peut('moyenne.note.modifier'));

  readonly cours = resource({
    params: () => ({ r: this.sync.revision(), u: this.auth.utilisateur()?.id }),
    loader: () => coursAccessibles(this.auth.utilisateur()?.roles ?? [], this.auth.utilisateur()?.id),
  });

  readonly classeId = signal('');
  readonly semestreId = signal('');
  readonly matiereId = signal('');
  readonly evaluationId = signal<string | null>(null);

  readonly classes = computed(() => {
    const vus = new Map<string, Ligne>();
    for (const c of this.cours.value() ?? []) {
      vus.set(c.classe.id, c.classe);
    }
    return [...vus.values()];
  });
  readonly semestres = computed(() => {
    const vus = new Map<string, Ligne>();
    for (const c of (this.cours.value() ?? []).filter((x) => x.classe.id === this.classeId())) {
      vus.set(c.semestre.id, c.semestre);
    }
    return [...vus.values()].sort((a, b) => a['numero'] - b['numero']);
  });
  readonly matieres = computed(() => (this.cours.value() ?? []).filter((x) => x.classe.id === this.classeId() && x.semestre.id === this.semestreId()));
  readonly coursChoisi = computed<Cours | undefined>(() => this.matieres().find((c) => c.matiere.id === this.matiereId()));

  readonly evaluations = resource({
    params: () => ({ c: this.coursChoisi()?.cle, r: this.sync.revision() }),
    loader: async ({ params }) => {
      const c = this.coursChoisi();
      if (!params.c || !c) {
        return [];
      }
      const evals = await db.table_('evaluation').where('classe_id').equals(c.classe.id)
        .filter((e) => e['matiere_id'] === c.matiere.id && e['semestre_id'] === c.semestre.id).toArray();
      const notes = await db.table_('note').where('evaluation_id').anyOf(evals.map((e) => e.id)).toArray();
      return evals.map((e) => ({
        ...e,
        nbNotes: notes.filter((n) => n['evaluation_id'] === e.id).length,
        nbValidees: notes.filter((n) => n['evaluation_id'] === e.id && n['statut'] === 'VALIDEE').length,
      } as Ligne & { nbNotes: number; nbValidees: number }))
        .sort((a, b) => (ORDRE_TYPES[a['type_eval']] ?? 9) - (ORDRE_TYPES[b['type_eval']] ?? 9) || Number(a['session']) - Number(b['session'])
          || String(a['date_eval'] ?? '').localeCompare(String(b['date_eval'] ?? '')));
    },
  });

  readonly evaluation = computed(() => (this.evaluations.value() ?? []).find((e) => e.id === this.evaluationId()) ?? null);

  // -- Grille ---------------------------------------------------------------------------------
  readonly lignes = signal<LigneGrille[]>([]);
  readonly messageGrille = signal<string | null>(null);
  readonly envoi = signal(false);

  readonly modifiees = computed(() => this.lignes().filter((l) => !l.verrouillee && (l.texte.trim() !== l.initialTexte || l.absent !== l.initialAbsent)));
  readonly invalides = computed(() => new Set(this.lignes().filter((l) => !l.absent && Number.isNaN(lireNote(l.texte))).map((l) => l.inscriptionId)));
  readonly stats = computed(() => {
    const valeurs = this.lignes().filter((l) => !l.absent).map((l) => lireNote(l.texte)).filter((v): v is number => v !== null && !Number.isNaN(v));
    const absents = this.lignes().filter((l) => l.absent).length;
    return {
      effectif: this.lignes().length, notes: valeurs.length, absents, manquantes: this.lignes().length - valeurs.length - absents,
      moyenne: valeurs.length ? ecrireNote(Math.round((valeurs.reduce((s, v) => s + v, 0) / valeurs.length) * 100) / 100) : '—',
      max: valeurs.length ? ecrireNote(Math.max(...valeurs)) : '—',
      min: valeurs.length ? ecrireNote(Math.min(...valeurs)) : '—',
      sous: valeurs.filter((v) => v < 10).length,
    };
  });

  constructor() {
    // Sélection automatique quand il n'y a qu'un choix.
    effect(() => {
      const classes = this.classes();
      untracked(() => { if (!this.classeId() && classes.length) { this.classeId.set(classes[0].id); } });
    });
    effect(() => {
      const s = this.semestres();
      untracked(() => { if (s.length && !s.some((x) => x.id === this.semestreId())) { this.semestreId.set(s[0].id); } });
    });
    effect(() => {
      const m = this.matieres();
      untracked(() => { if (m.length && !m.some((x) => x.matiere.id === this.matiereId())) { this.matiereId.set(m[0].matiere.id); } });
    });
    effect(() => {
      const ev = this.evaluation();
      this.sync.revision();
      const enLigne = this.reseau.enLigne();
      untracked(() => void this.chargerGrille(ev, enLigne));
    });
  }

  changerCours(classe?: string, semestre?: string, matiere?: string): void {
    if (classe !== undefined) { this.classeId.set(classe); }
    if (semestre !== undefined) { this.semestreId.set(semestre); }
    if (matiere !== undefined) { this.matiereId.set(matiere); }
    this.evaluationId.set(null);
  }

  private async chargerGrille(ev: Ligne | null, enLigne: boolean): Promise<void> {
    this.messageGrille.set(null);
    if (!ev) {
      this.lignes.set([]);
      return;
    }
    if (this.modifiees().length && this.lignes()[0] && this.evaluationIdCharge === ev.id) {
      return;                                   // ne pas écraser une saisie en cours
    }
    this.evaluationIdCharge = ev.id;
    const c = this.coursChoisi()!;
    let etudiants: { inscriptionId: string; matricule: string | null; nom: string; prenoms: string }[];

    if (ev['type_eval'] === 'EXAMEN' && Number(ev['session']) === 2) {
      // 2e session : seulement les non-admis de la 1re session.
      const moyennes = await db.table_('moyenne_matiere').where('semestre_id').equals(c.semestre.id)
        .filter((m) => m['matiere_id'] === c.matiere.id).toArray();
      if (moyennes.length) {
        const seuil = await seuilValidation();
        const nonAdmis = new Set(moyennes.filter((m) => m['moyenne_session1'] === null || Number(m['moyenne_session1']) < seuil).map((m) => m['inscription_id']));
        etudiants = (await this.inscritsLocaux(c.classe.id)).filter((x) => nonAdmis.has(x.inscriptionId));
      } else if (enLigne && !ev['_en_attente']) {
        try {
          const g = await this.api.get(`/api/notes/evaluations/${ev.id}/grille/`);
          etudiants = g.etudiants.map((x: any) => ({ inscriptionId: x.inscription_id, matricule: x.matricule, nom: x.nom, prenoms: x.prenoms }));
        } catch (e) {
          this.messageGrille.set((e as ErreurApi).message);
          this.lignes.set([]);
          return;
        }
      } else {
        this.messageGrille.set('Examen de 2e session : la liste des étudiants concernés (non admis) nécessite la connexion.');
        this.lignes.set([]);
        return;
      }
    } else {
      etudiants = await this.inscritsLocaux(c.classe.id);
    }

    // Notes du serveur + saisies encore dans la file d'envoi.
    const notes = new Map((await db.table_('note').where('evaluation_id').equals(ev.id).toArray()).map((n) => [n['inscription_id'], n]));
    const attente = new Map<string, { valeur: number | null; absent: boolean }>();
    const ops = (await db.operations.where('statut').equals('attente').sortBy('seq'))
      .filter((o) => o.table === 'evaluation' && o.action === 'saisir' && o.id === ev.id);
    for (const o of ops) {
      for (const l of o.donnees?.['notes'] ?? []) {
        attente.set(l.inscription, { valeur: l.valeur ?? null, absent: !!l.absent });
      }
    }
    const validees = new Set((await db.table_('moyenne_matiere').where('semestre_id').equals(c.semestre.id)
      .filter((m) => m['matiere_id'] === c.matiere.id && m['statut'] === 'VALIDEE').toArray()).map((m) => m['inscription_id']));

    this.lignes.set(etudiants.map((x) => {
      const n = notes.get(x.inscriptionId);
      const a = attente.get(x.inscriptionId);
      const absent = a ? a.absent : !!n?.['absent'];
      const texte = a ? (a.absent ? '' : ecrireNote(a.valeur)) : (n && !n['absent'] ? ecrireNote(n['valeur']) : '');
      return { ...x, texte, absent, initialTexte: texte, initialAbsent: absent,
        verrouillee: n?.['statut'] === 'VALIDEE' || validees.has(x.inscriptionId) || !this.peutModifier(), enAttente: !!a };
    }));
  }

  private evaluationIdCharge: string | null = null;

  private async inscritsLocaux(classeId: string) {
    const inscriptions = await db.table_('inscription').where('classe_id').equals(classeId).filter((i) => i['etat'] === 'VALIDEE').toArray();
    const etudiants = await db.table_('etudiant').bulkGet(inscriptions.map((i) => i['etudiant_id']));
    return inscriptions.map((i, k) => ({ inscriptionId: i.id, matricule: etudiants[k]?.['matricule'] ?? null, nom: etudiants[k]?.['nom'] ?? '—', prenoms: etudiants[k]?.['prenoms'] ?? '' }))
      .sort((a, b) => `${a.nom} ${a.prenoms}`.localeCompare(`${b.nom} ${b.prenoms}`, 'fr'));
  }

  saisir(index: number, texte: string): void {
    this.lignes.update((l) => l.map((x, i) => (i === index ? { ...x, texte, absent: texte.trim() ? false : x.absent } : x)));
  }

  basculerAbsent(index: number, absent: boolean): void {
    this.lignes.update((l) => l.map((x, i) => (i === index ? { ...x, absent, texte: absent ? '' : x.texte } : x)));
  }

  /** Entrée / flèches : ligne suivante ; collage d'une colonne Excel : remplit les lignes suivantes. */
  clavier(ev: KeyboardEvent, index: number): void {
    if (ev.key === 'Enter' || ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      this.focus(index + (ev.key === 'ArrowUp' ? -1 : 1));
    }
  }

  coller(ev: ClipboardEvent, index: number): void {
    const texte = ev.clipboardData?.getData('text') ?? '';
    const valeurs = texte.split(/\r?\n/).map((v) => v.trim()).filter((v, i, t) => v !== '' || i < t.length - 1);
    if (valeurs.length <= 1) {
      return;
    }
    ev.preventDefault();
    this.lignes.update((l) => l.map((x, i) => {
      const v = valeurs[i - index];
      if (i < index || v === undefined || x.verrouillee) {
        return x;
      }
      const abs = /^(abs|absent|a)$/i.test(v);
      return { ...x, texte: abs ? '' : v, absent: abs };
    }));
  }

  private focus(index: number): void {
    const el = document.querySelector<HTMLInputElement>(`[data-ligne="${index}"]`);
    el?.focus();
    el?.select();
  }

  annulerSaisie(): void {
    this.lignes.update((l) => l.map((x) => ({ ...x, texte: x.initialTexte, absent: x.initialAbsent })));
  }

  async enregistrer(): Promise<void> {
    const ev = this.evaluation();
    if (!ev || !this.modifiees().length) {
      return;
    }
    if (this.invalides().size) {
      this.snack.open('Notes invalides (0 à 20, deux décimales au plus) : corriger les cases en rouge.', 'OK', { duration: 5000 });
      return;
    }
    this.envoi.set(true);
    try {
      const notes = this.modifiees().map((l) => ({ inscription: l.inscriptionId, valeur: l.absent ? null : lireNote(l.texte), absent: l.absent }));
      const c = this.coursChoisi()!;
      await this.sync.enregistrer({
        table: 'evaluation', action: 'saisir', id: ev.id, donnees: { notes },
        libelle: `Notes : ${ev['libelle']} — ${c.matiere['code']}, ${c.classe['libelle']} (${notes.length})`,
      });
      this.lignes.update((l) => l.map((x) => ({ ...x, initialTexte: x.texte.trim(), initialAbsent: x.absent, enAttente: x.enAttente || notes.some((n) => n.inscription === x.inscriptionId) })));
      this.snack.open(this.reseau.enLigne() ? `${notes.length} note(s) enregistrée(s).` : `${notes.length} note(s) enregistrée(s) sur ce poste : envoi au retour de la connexion.`, 'OK', { duration: 4000 });
    } finally {
      this.envoi.set(false);
    }
  }

  // -- Évaluations --------------------------------------------------------------------------------
  nouvelleEvaluation(): void {
    this.dialog.open(EvaluationFormulaire, { data: { cours: this.coursChoisi(), evaluation: null, existantes: this.evaluations.value() ?? [] }, width: '600px', maxWidth: '96vw' })
      .afterClosed().subscribe((id) => id && this.evaluationId.set(id));
  }

  modifierEvaluation(e: Ligne): void {
    this.dialog.open(EvaluationFormulaire, { data: { cours: this.coursChoisi(), evaluation: e, existantes: this.evaluations.value() ?? [] }, width: '600px', maxWidth: '96vw' });
  }

  async supprimerEvaluation(e: Ligne & { nbNotes: number }): Promise<void> {
    const ok = await confirmer(this.dialog, {
      titre: 'Supprimer l\'évaluation',
      message: `« ${e['libelle']} » et ses ${e.nbNotes} note(s) seront supprimées.`, confirmer: 'Supprimer', danger: true,
    });
    if (!ok) {
      return;
    }
    await this.sync.enregistrer({ table: 'evaluation', action: 'supprimer', id: e.id, version: e.version, libelle: `Suppression de l'évaluation ${e['libelle']}` });
    await db.table_('evaluation').delete(e.id);
    this.evaluationId.set(null);
    this.sync.revision.update((v) => v + 1);
  }
}
