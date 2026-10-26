import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, resource, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ActivatedRoute } from '@angular/router';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { Ligne, db } from '../../core/db';
import { MODES_AVEC_REFERENCE, MODES_PAIEMENT, fcfa, libelleMode, situationLocale } from '../../core/finances';
import { ResultatEtudiant, anneeActive, rechercherEtudiants } from '../../core/recherche-locale';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { aujourdhui, normaliser, nouvelId } from '../../core/texte';
import { choisir } from '../../shared/choix';
import { telecharger } from '../../shared/telecharger';

/**
 * Caisse : encaissement d'un versement (hors ligne possible, reçu numéroté à la synchronisation)
 * et journal des versements.
 */
@Component({
  selector: 'app-versements',
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatButtonModule, MatIconModule,
    MatTooltipModule, DatePipe],
  templateUrl: './versements.html',
  styleUrl: './comptabilite.scss',
})
export class VersementsPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly sync = inject(SyncService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  readonly reseau = inject(ReseauService);

  readonly fcfa = fcfa;
  readonly libelleMode = libelleMode;
  readonly modes = MODES_PAIEMENT;
  readonly peutEncaisser = computed(() => this.auth.peut('comptabilite.versement.creer'));
  readonly peutAnnuler = computed(() => this.auth.peut('comptabilite.versement.supprimer'));
  readonly peutExporter = computed(() => this.auth.peut('comptabilite.versement.exporter'));

  // -- Choix de l'étudiant --------------------------------------------------------------------
  readonly recherche = signal('');
  readonly resultats = resource({ params: () => ({ q: this.recherche() }), loader: ({ params }) => rechercherEtudiants(params.q, 8) });
  readonly inscriptionId = signal<string | null>(null);

  readonly dossier = resource({
    params: () => ({ id: this.inscriptionId(), r: this.sync.revision() }),
    loader: async ({ params }) => {
      if (!params.id) {
        return null;
      }
      const inscription = await db.table_('inscription').get(params.id);
      if (!inscription) {
        return null;
      }
      const [etudiant, classe, situation] = await Promise.all([
        db.table_('etudiant').get(inscription['etudiant_id']),
        db.table_('classe').get(inscription['classe_id']),
        situationLocale(params.id),
      ]);
      return { inscription, etudiant, classe, situation };
    },
  });

  // -- Formulaire d'encaissement -------------------------------------------------------------
  readonly f = inject(FormBuilder).group({
    payeur: ['ETUDIANT', Validators.required],
    objet: [''],
    montant: [null as number | null, [Validators.required, Validators.min(1)]],
    mode_paiement: ['ESPECES', Validators.required],
    reference: [''],
    date_versement: [aujourdhui(), Validators.required],
  });
  readonly aujourdhui = aujourdhui();
  private readonly valeurs = toSignal(this.f.valueChanges, { initialValue: this.f.getRawValue() });
  readonly envoi = signal(false);
  readonly erreur = signal<string | null>(null);
  readonly dernier = signal<string | null>(null);

  /** Montant maximum autorisé pour la combinaison payeur / objet choisie. */
  readonly plafond = computed(() => {
    const s = this.dossier.value()?.situation;
    const v = this.valeurs();
    if (!s) {
      return 0;
    }
    let max = v.payeur === 'ETUDIANT' ? s.resteEtudiant : s.prises.find((p) => p.id === v.payeur)?.reste ?? 0;
    if (v.objet) {
      max = Math.min(max, s.frais.find((l) => l.typeFraisId === v.objet)?.reste ?? 0);
    }
    return max;
  });

  readonly referenceObligatoire = computed(() => MODES_AVEC_REFERENCE.includes(this.valeurs().mode_paiement ?? ''));

  // -- Journal --------------------------------------------------------------------------------
  readonly du = signal(aujourdhui());
  readonly au = signal(aujourdhui());
  readonly filtreMode = signal('');
  readonly texte = signal('');

  readonly journal = resource({
    params: () => ({ du: this.du(), au: this.au(), r: this.sync.revision() }),
    loader: async ({ params }) => {
      const versements = await db.table_('versement').filter((v) => v['date_versement'] >= params.du && v['date_versement'] <= params.au).toArray();
      const inscriptions = await db.table_('inscription').bulkGet(versements.map((v) => v['inscription_id']));
      const etudiants = await db.table_('etudiant').bulkGet(inscriptions.map((i) => i?.['etudiant_id'] ?? ''));
      const [classes, types, pecs] = await Promise.all([
        db.table_('classe').toArray(), db.table_('type_frais').toArray(), db.table_('prise_en_charge').toArray(),
      ]);
      const parId = new Map([...classes, ...types, ...pecs].map((x) => [x.id, x]));
      return versements.map((v, k) => ({
        v,
        etudiant: etudiants[k],
        classe: parId.get(inscriptions[k]?.['classe_id'])?.['libelle'] ?? '—',
        objet: v['type_frais_id'] ? parId.get(v['type_frais_id'])?.['libelle'] ?? '—' : 'Global',
        payeur: v['payeur'] === 'PRISE_EN_CHARGE' ? parId.get(v['prise_en_charge_id'])?.['organisme'] ?? 'Organisme' : 'Étudiant',
      })).sort((a, b) => String(b.v['date_versement']).localeCompare(String(a.v['date_versement']))
        || String(b.v['numero_recu'] ?? '~').localeCompare(String(a.v['numero_recu'] ?? '~')));
    },
  });

  readonly lignesJournal = computed(() => {
    const mots = normaliser(this.texte()).split(' ').filter(Boolean);
    return (this.journal.value() ?? []).filter((l) => (!this.filtreMode() || l.v['mode_paiement'] === this.filtreMode())
      && mots.every((m) => normaliser(`${l.v['numero_recu'] ?? ''} ${l.etudiant?.['matricule'] ?? ''} ${l.etudiant?.['nom'] ?? ''} ${l.etudiant?.['prenoms'] ?? ''} ${l.v['reference'] ?? ''}`).includes(m)));
  });

  readonly totalJournal = computed(() => this.lignesJournal().filter((l) => !l.v['annule']).reduce((s, l) => s + Number(l.v['montant']), 0));
  readonly totauxModes = computed(() => {
    const t = new Map<string, number>();
    for (const l of this.lignesJournal().filter((x) => !x.v['annule'])) {
      t.set(l.v['mode_paiement'], (t.get(l.v['mode_paiement']) ?? 0) + Number(l.v['montant']));
    }
    return [...t.entries()].map(([mode, total]) => ({ mode: libelleMode(mode), total }));
  });

  constructor() {
    const id = inject(ActivatedRoute).snapshot.queryParamMap.get('inscription');
    if (id) {
      this.inscriptionId.set(id);
    }
    // Montant proposé : le reste à payer pour le choix courant.
    effect(() => {
      const max = this.plafond();
      untracked(() => {
        if (!this.f.controls.montant.dirty) {
          this.f.controls.montant.setValue(max > 0 ? max : null, { emitEvent: false });
        }
      });
    });
  }

  async choisirEtudiant(r: ResultatEtudiant): Promise<void> {
    const annee = await anneeActive();
    const inscriptions = await db.table_('inscription').where('etudiant_id').equals(r.etudiant.id).toArray();
    const i = inscriptions.find((x) => x['annee_id'] === annee?.id && ['VALIDEE', 'ABANDON'].includes(x['etat']))
      ?? inscriptions.filter((x) => ['VALIDEE', 'ABANDON'].includes(x['etat'])).sort((a, b) => String(b['date_inscription']).localeCompare(String(a['date_inscription'])))[0];
    if (!i) {
      this.snack.open('Aucune inscription validée pour cet étudiant : valider d\'abord l\'inscription (Scolarité).', 'OK', { duration: 6000 });
      return;
    }
    this.recherche.set('');
    this.changerInscription(i.id);
  }

  changerInscription(id: string | null): void {
    this.inscriptionId.set(id);
    this.dernier.set(null);
    this.erreur.set(null);
    this.f.reset({ payeur: 'ETUDIANT', objet: '', montant: null, mode_paiement: 'ESPECES', reference: '', date_versement: aujourdhui() });
  }

  async encaisser(): Promise<void> {
    const d = this.dossier.value();
    this.f.markAllAsTouched();
    if (!d || this.f.invalid) {
      return;
    }
    const v = this.f.getRawValue();
    const montant = Number(v.montant);
    if (montant > this.plafond()) {
      this.erreur.set(`Le montant dépasse le reste à payer (${fcfa(this.plafond())}).`);
      return;
    }
    if (this.referenceObligatoire() && !(v.reference ?? '').trim()) {
      this.erreur.set('Référence obligatoire pour ce mode de paiement (n° de transaction ou de chèque).');
      return;
    }
    this.erreur.set(null);
    this.envoi.set(true);
    try {
      const id = nouvelId();
      const pec = v.payeur !== 'ETUDIANT' ? v.payeur : null;
      const donnees = {
        inscription: d.inscription.id, type_frais: v.objet || null, payeur: pec ? 'PRISE_EN_CHARGE' : 'ETUDIANT',
        prise_en_charge: pec, montant, date_versement: v.date_versement, mode_paiement: v.mode_paiement,
        reference: (v.reference ?? '').trim() || null,
      };
      await this.sync.enregistrer(
        { table: 'versement', action: 'creer', id, donnees, libelle: `Versement ${fcfa(montant)} — ${d.etudiant?.['nom']} ${d.etudiant?.['prenoms']}` },
        { id, version: 0, inscription_id: d.inscription.id, type_frais_id: donnees.type_frais, payeur: donnees.payeur,
          prise_en_charge_id: pec, montant, date_versement: v.date_versement, mode_paiement: v.mode_paiement,
          reference: donnees.reference, numero_recu: null, annule: false, encaisse_par_id: this.auth.utilisateur()?.id ?? null },
      );
      this.dernier.set(id);
      this.f.reset({ payeur: 'ETUDIANT', objet: '', montant: null, mode_paiement: 'ESPECES', reference: '', date_versement: aujourdhui() });
      this.snack.open(this.reseau.enLigne() ? 'Versement enregistré.' : 'Versement enregistré sur ce poste : le reçu sera numéroté à la synchronisation.',
        'OK', { duration: 5000 });
    } finally {
      this.envoi.set(false);
    }
  }

  dernierVersement(): Ligne | undefined {
    return this.dossier.value()?.situation.versements.find((x) => x.id === this.dernier());
  }

  async recu(v: Ligne): Promise<void> {
    try {
      const f = await this.api.fichier(`/api/comptabilite/versements/${v.id}/recu/`);
      const url = URL.createObjectURL(f.blob);
      const fenetre = window.open(url, '_blank');
      if (!fenetre) {
        telecharger(f.blob, f.nom || `${v['numero_recu']}.pdf`);
      }
      setTimeout(() => URL.revokeObjectURL(url), 120_000);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  async annuler(v: Ligne): Promise<void> {
    const motif = await choisir(this.dialog, {
      titre: `Annuler le reçu ${v['numero_recu']}`,
      message: `${fcfa(v['montant'])} — l'écriture de caisse liée est annulée elle aussi. Le reçu reste numéroté (mention « ANNULÉ »).`,
      libelle: 'Motif de l\'annulation', minimum: 3, confirmer: 'Annuler le versement',
    });
    if (!motif) {
      return;
    }
    try {
      await this.api.post(`/api/comptabilite/versements/${v.id}/annuler/`, { motif });
      this.snack.open('Versement annulé.', 'OK', { duration: 3000 });
      await this.sync.synchroniser();
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 6000 });
    }
  }

  async exporter(): Promise<void> {
    try {
      const f = await this.api.fichier('/api/comptabilite/versements/', { export: 'xlsx', du: this.du(), au: this.au(), mode: this.filtreMode() });
      telecharger(f.blob, f.nom);
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
    }
  }

  periode(jours: number): void {
    const d = new Date();
    d.setDate(d.getDate() - jours);
    this.du.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    this.au.set(aujourdhui());
  }
}
