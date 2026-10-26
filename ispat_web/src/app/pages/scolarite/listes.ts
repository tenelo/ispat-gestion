import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, resource, signal, untracked } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute, Router } from '@angular/router';

import { ApiService, ErreurApi, Parametres } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { ReseauService } from '../../core/reseau.service';
import { referentielsScolarite } from '../../core/scolarite';
import { SyncService } from '../../core/sync/sync.service';
import { telecharger } from '../../shared/telecharger';

type Mode = 'classe' | 'sexe' | 'statut' | 'notation';

const TITRES: Record<Mode, string> = {
  classe: 'Liste de classe',
  sexe: 'Liste par sexe',
  statut: 'Liste par statut',
  notation: 'Liste de notation',
};
const CODES: Record<Mode, string> = { classe: 'liste_classe', sexe: 'liste_sexe', statut: 'liste_statut', notation: 'liste_notation' };

interface LigneEtudiant {
  inscription: Ligne;
  etudiant: Ligne;
  classe: string;
  statut: string;
  statutCode: string;
}

interface Groupe {
  cle: string;
  libelle: string;
  lignes: LigneEtudiant[];
}

/**
 * Listes de scolarité. Classe, sexe, statut : calculées sur les données du poste (hors ligne possible).
 * Notation : notes du serveur (en ligne). Exports Excel / CSV : générés par l'API (en ligne).
 */
@Component({
  selector: 'app-listes-scolarite',
  imports: [MatFormFieldModule, MatSelectModule, MatButtonModule, MatIconModule, MatCheckboxModule, MatProgressBarModule,
    MatTooltipModule, DatePipe],
  templateUrl: './listes.html',
  styleUrl: './listes.scss',
})
export class ListesScolaritePage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly snack = inject(MatSnackBar);
  private readonly router = inject(Router);
  readonly reseau = inject(ReseauService);

  readonly mode: Mode = (inject(ActivatedRoute).snapshot.routeConfig?.path?.replace('scolarite/liste-', '') ?? 'classe') as Mode;
  readonly titre = TITRES[this.mode];
  readonly peutExporter = computed(() => this.auth.peut(`scolarite.${CODES[this.mode]}.exporter`));

  readonly anneeId = signal('');
  readonly classeId = signal('');
  readonly filiereId = signal('');
  readonly niveauId = signal('');
  readonly semestreId = signal('');
  readonly matiereId = signal('');
  readonly inclureAttente = signal(false);
  readonly exportEnCours = signal(false);

  readonly ref = resource({
    params: () => ({ r: this.sync.revision() }),
    loader: async () => {
      const r = await referentielsScolarite();
      const [semestres, matieres] = await Promise.all([db.table_('semestre').toArray(), db.table_('matiere').toArray()]);
      if (!this.anneeId() && r.anneeActive) {
        this.anneeId.set(r.anneeActive.id);
      }
      return { ...r, semestres, matieres };
    },
  });

  readonly classesAnnee = computed(() => (this.ref.value()?.classes ?? []).filter((c) => c['annee_id'] === this.anneeId()));
  readonly semestresAnnee = computed(() =>
    (this.ref.value()?.semestres ?? []).filter((s) => s['annee_id'] === this.anneeId()).sort((a, b) => a['numero'] - b['numero']));
  readonly matieresClasse = computed(() => {
    const c = this.ref.value()?.parId.get(this.classeId());
    const s = this.ref.value()?.semestres.find((x) => x.id === this.semestreId());
    return (this.ref.value()?.matieres ?? [])
      .filter((m) => c && m['filiere_id'] === c['filiere_id'] && m['niveau_id'] === c['niveau_id'] && (!s || m['semestre_numero'] === s['numero']))
      .sort((a, b) => String(a['code']).localeCompare(String(b['code'])));
  });

  // -- Données locales (classe, sexe, statut) --------------------------------------------------

  private readonly donnees = resource({
    params: () => ({ r: this.sync.revision(), annee: this.anneeId() }),
    loader: async ({ params }) => {
      if (!params.annee || this.mode === 'notation') {
        return [];
      }
      const inscriptions = await db.table_('inscription').where('annee_id').equals(params.annee).toArray();
      const etudiants = await db.table_('etudiant').bulkGet(inscriptions.map((i) => i['etudiant_id']));
      return inscriptions.map((i, k) => ({ inscription: i, etudiant: etudiants[k] })).filter((x) => !!x.etudiant) as { inscription: Ligne; etudiant: Ligne }[];
    },
  });

  readonly lignes = computed<LigneEtudiant[]>(() => {
    const r = this.ref.value();
    if (!r) {
      return [];
    }
    const etats = this.inclureAttente() ? ['VALIDEE', 'EN_ATTENTE'] : ['VALIDEE'];
    return (this.donnees.value() ?? [])
      .filter(({ inscription: i }) => etats.includes(i['etat']))
      .filter(({ inscription: i }) => {
        const c = r.parId.get(i['classe_id']);
        return (!this.classeId() || i['classe_id'] === this.classeId())
          && (!this.filiereId() || c?.['filiere_id'] === this.filiereId())
          && (!this.niveauId() || c?.['niveau_id'] === this.niveauId());
      })
      .map(({ inscription, etudiant }) => ({
        inscription,
        etudiant,
        classe: r.parId.get(inscription['classe_id'])?.['libelle'] ?? '—',
        statut: r.parId.get(inscription['statut_etudiant_id'])?.['libelle'] ?? '—',
        statutCode: r.parId.get(inscription['statut_etudiant_id'])?.['code'] ?? '',
      }))
      .sort((a, b) => a.classe.localeCompare(b.classe, 'fr')
        || `${a.etudiant['nom']} ${a.etudiant['prenoms']}`.localeCompare(`${b.etudiant['nom']} ${b.etudiant['prenoms']}`, 'fr'));
  });

  readonly groupes = computed<Groupe[]>(() => {
    const l = this.lignes();
    if (this.mode === 'sexe') {
      return [
        { cle: 'F', libelle: 'Féminin', lignes: l.filter((x) => x.etudiant['sexe'] === 'F') },
        { cle: 'M', libelle: 'Masculin', lignes: l.filter((x) => x.etudiant['sexe'] === 'M') },
      ];
    }
    if (this.mode === 'statut') {
      const parStatut = new Map<string, Groupe>();
      for (const x of l) {
        if (!parStatut.has(x.statutCode)) {
          parStatut.set(x.statutCode, { cle: x.statutCode, libelle: x.statut, lignes: [] });
        }
        parStatut.get(x.statutCode)!.lignes.push(x);
      }
      return [...parStatut.values()].sort((a, b) => a.libelle.localeCompare(b.libelle, 'fr'));
    }
    return [{ cle: 'tous', libelle: '', lignes: l }];
  });

  /** Effectifs par classe (liste de classe sans classe choisie). */
  readonly effectifs = computed(() => {
    const parClasse = new Map<string, { classe: string; id: string; total: number; F: number; M: number }>();
    for (const x of this.lignes()) {
      const id = x.inscription['classe_id'];
      if (!parClasse.has(id)) {
        parClasse.set(id, { classe: x.classe, id, total: 0, F: 0, M: 0 });
      }
      const c = parClasse.get(id)!;
      c.total++;
      c[x.etudiant['sexe'] as 'F' | 'M']++;
    }
    return [...parClasse.values()].sort((a, b) => a.classe.localeCompare(b.classe, 'fr'));
  });

  readonly totaux = computed(() => ({
    total: this.lignes().length,
    F: this.lignes().filter((x) => x.etudiant['sexe'] === 'F').length,
    M: this.lignes().filter((x) => x.etudiant['sexe'] === 'M').length,
  }));

  // -- Notation (serveur) -----------------------------------------------------------------------

  readonly notation = signal<any | null>(null);
  readonly chargementNotation = signal(false);
  readonly erreurNotation = signal<string | null>(null);

  constructor() {
    if (this.mode === 'notation') {
      effect(() => {
        const params = { classe: this.classeId(), semestre: this.semestreId(), matiere: this.matiereId(), enLigne: this.reseau.enLigne() };
        untracked(() => void this.chargerNotation(params));
      });
    }
  }

  private async chargerNotation(p: { classe: string; semestre: string; matiere: string; enLigne: boolean }): Promise<void> {
    this.notation.set(null);
    this.erreurNotation.set(null);
    if (!p.classe || !p.semestre || !p.enLigne) {
      return;
    }
    this.chargementNotation.set(true);
    try {
      this.notation.set(await this.api.get('/api/scolarite/listes/notation/', this.paramsServeur()));
    } catch (e) {
      this.erreurNotation.set((e as ErreurApi).message);
    } finally {
      this.chargementNotation.set(false);
    }
  }

  note(etudiant: any, evaluationId: string): string {
    const n = etudiant.notes?.[evaluationId];
    if (!n) {
      return '';
    }
    return n.absent ? 'ABS' : String(n.valeur).replace('.', ',');
  }

  // -- Export -----------------------------------------------------------------------------------

  private paramsServeur(): Parametres {
    const annee = this.ref.value()?.parId.get(this.anneeId());
    return {
      annee: annee?.['est_active'] ? 'active' : this.anneeId(),
      classe: this.classeId(),
      filiere: this.filiereId(),
      niveau: this.niveauId(),
      semestre: this.semestreId(),
      matiere: this.matiereId(),
      inclure_attente: this.inclureAttente() ? 'true' : '',
    };
  }

  peutLancerExport(): boolean {
    if (this.mode === 'classe' || this.mode === 'notation') {
      return !!this.classeId() && (this.mode !== 'notation' || !!this.semestreId());
    }
    return true;
  }

  async exporter(format: 'xlsx' | 'csv'): Promise<void> {
    this.exportEnCours.set(true);
    try {
      const chemin = this.mode === 'classe' && !this.classeId() ? '/api/scolarite/listes/effectifs/' : `/api/scolarite/listes/${this.mode}/`;
      const f = await this.api.fichier(chemin, { ...this.paramsServeur(), export: format });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    } finally {
      this.exportEnCours.set(false);
    }
  }

  ouvrir(etudiantId: string): void {
    if (this.auth.peut('scolarite.inscription.lire')) {
      void this.router.navigate(['/scolarite/etudiants', etudiantId]);
    }
  }

  imprimer(): void {
    window.print();
  }
}
