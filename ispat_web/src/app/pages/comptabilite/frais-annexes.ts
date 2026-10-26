import { Component, computed, inject, viewChild } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';

import { ApiService, ErreurApi } from '../../core/api.service';
import { AuthService } from '../../core/auth/auth.service';
import { CATEGORIES_FRAIS, fcfa } from '../../core/finances';
import { ReseauService } from '../../core/reseau.service';
import { SyncService } from '../../core/sync/sync.service';
import { Descripteur, ReferenceChamp } from '../../shared/crud/crud';
import { FormulaireCrud } from '../../shared/crud/formulaire-crud';
import { TableCrud } from '../../shared/crud/table-crud';

const DROITS = {
  creer: ['comptabilite.frais_annexe.creer'],
  modifier: ['comptabilite.frais_annexe.modifier'],
  supprimer: ['comptabilite.frais_annexe.supprimer'],
};
const classesActives: ReferenceChamp = { chemin: '/api/referentiels/classes/', params: { annee: 'active' }, libelle: (c) => c.libelle };
const inscriptionsValidees: ReferenceChamp = {
  chemin: '/api/scolarite/inscriptions/', params: { annee: 'active', etat: 'VALIDEE' },
  libelle: (i) => `${i.etudiant_matricule ?? '—'} — ${i.etudiant_nom} ${i.etudiant_prenoms} (${i.classe_libelle})`,
};

/** Frais dus par inscription : frais annexes (tenue, sortie terrain…), remises motivées, affectation à une classe. */
@Component({
  selector: 'app-frais-annexes',
  imports: [TableCrud, MatButtonModule, MatIconModule],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Frais annexes et remises</h1>
          <p class="sous-titre">Frais d'inscription et de scolarité générés à la validation ; frais annexes affectés ici. Connexion nécessaire.</p>
        </div>
        @if (peutCreer()) {
          <div class="actions">
            <button mat-stroked-button (click)="affecterClasse()" [disabled]="!reseau.enLigne()" data-test="affecter-classe">
              <mat-icon>groups</mat-icon> Affecter à une classe
            </button>
            <button mat-flat-button (click)="ajouter()" [disabled]="!reseau.enLigne()" data-test="ajouter-frais">
              <mat-icon>add</mat-icon> Ajouter à un étudiant
            </button>
          </div>
        }
      </div>
      <section class="carte"><app-table-crud [descripteur]="descripteur" /></section>
    </div>
  `,
  styles: `.large { max-width: 1400px; } .actions { display: flex; gap: 8px; flex-wrap: wrap; }`,
})
export class FraisAnnexesPage {
  private readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly sync = inject(SyncService);
  readonly reseau = inject(ReseauService);
  private readonly table = viewChild(TableCrud);
  readonly peutCreer = computed(() => this.auth.peut(DROITS.creer));

  readonly descripteur: Descripteur = {
    code: 'frais', titre: 'Frais dus', singulier: 'des frais', chemin: '/api/comptabilite/frais/', droits: DROITS,
    creation: false,
    aide: 'Une remise exige un motif. Un frais ne peut pas descendre sous ce qui a déjà été versé.',
    filtres: [
      { cle: 'annee', libelle: 'Année', choix: [['active', 'Année active']], defaut: 'active' },
      { cle: 'classe', libelle: 'Classe', reference: classesActives },
      { cle: 'categorie', libelle: 'Catégorie', choix: Object.entries(CATEGORIES_FRAIS), defaut: 'ANNEXE' },
    ],
    colonnes: [
      { libelle: 'Matricule', cle: 'etudiant_matricule', type: 'code' },
      { libelle: 'Étudiant', cle: 'etudiant_nom' },
      { libelle: 'Classe', cle: 'classe_libelle' },
      { libelle: 'Frais', cle: 'type_frais_libelle' },
      { libelle: 'Montant', valeur: (f) => fcfa(f.montant) },
      { libelle: 'Remise', valeur: (f) => (Number(f.remise) ? fcfa(f.remise) : '—') },
      { libelle: 'Dû', valeur: (f) => fcfa(f.montant_du) },
      { libelle: 'Échéance', cle: 'date_echeance', type: 'date' },
    ],
    champs: [
      { cle: 'montant', libelle: 'Montant (FCFA)', type: 'nombre', min: 0, obligatoire: true },
      { cle: 'remise', libelle: 'Remise (FCFA)', type: 'nombre', min: 0, defaut: 0 },
      { cle: 'motif_remise', libelle: 'Motif de la remise', type: 'texte', pleineLargeur: true },
      { cle: 'date_echeance', libelle: 'Échéance', type: 'date' },
    ],
    tri: (a, b) => String(a.classe_libelle).localeCompare(String(b.classe_libelle), 'fr') || String(a.etudiant_nom).localeCompare(String(b.etudiant_nom), 'fr'),
  };

  ajouter(): void {
    const d: Descripteur = {
      code: 'frais-ajout', titre: '', singulier: 'des frais pour un étudiant', chemin: '/api/comptabilite/frais/', droits: DROITS, colonnes: [],
      aide: 'Montant vide : le barème de l\'année s\'applique.',
      champs: [
        { cle: 'inscription', libelle: 'Étudiant (inscription validée)', type: 'reference', reference: inscriptionsValidees, obligatoire: true, pleineLargeur: true },
        { cle: 'type_frais', libelle: 'Frais', type: 'reference', obligatoire: true,
          reference: { chemin: '/api/referentiels/types-frais/', libelle: (t) => t.libelle } },
        { cle: 'montant', libelle: 'Montant (FCFA)', type: 'nombre', min: 0 },
        { cle: 'date_echeance', libelle: 'Échéance', type: 'date' },
      ],
    };
    void this.ouvrir(d, () => 'Frais ajoutés.');
  }

  affecterClasse(): void {
    const d: Descripteur = {
      code: 'frais-classe', titre: '', singulier: 'une affectation à une classe', feminin: true,
      chemin: '/api/comptabilite/frais/affecter-classe/', droits: DROITS, colonnes: [],
      aide: 'Les frais sont ajoutés à tous les étudiants validés de la classe (sans doublon). Montant vide : barème de l\'année.',
      champs: [
        { cle: 'classe', libelle: 'Classe', type: 'reference', reference: classesActives, obligatoire: true },
        { cle: 'type_frais', libelle: 'Frais', type: 'reference', obligatoire: true,
          reference: { chemin: '/api/referentiels/types-frais/', params: { categorie: 'ANNEXE' }, libelle: (t) => t.libelle } },
        { cle: 'montant', libelle: 'Montant (FCFA)', type: 'nombre', min: 0 },
        { cle: 'date_echeance', libelle: 'Échéance', type: 'date' },
      ],
    };
    void this.ouvrir(d, (r) => `${r.frais} — ${r.classe} : ${r.crees} ajout(s), ${r.deja_affectes} déjà affecté(s)`
      + (r.sans_tarif?.length ? `, ${r.sans_tarif.length} sans tarif` : '') + '.');
  }

  private async ouvrir(d: Descripteur, message: (r: any) => string): Promise<void> {
    const options: Record<string, [any, string][]> = {};
    try {
      for (const c of d.champs) {
        if (c.reference) {
          const lignes = await this.api.lister(c.reference.chemin, c.reference.params ?? {});
          options[c.cle] = lignes.map((l) => [l.id, c.reference!.libelle(l)]);
        }
      }
    } catch (e) {
      this.snack.open((e as ErreurApi).message, 'OK', { duration: 5000 });
      return;
    }
    this.dialog.open(FormulaireCrud, { data: { descripteur: d, ligne: null, options }, width: '640px', maxWidth: '96vw' })
      .afterClosed().subscribe((r) => {
        if (r) {
          this.snack.open(message(r), 'OK', { duration: 6000 });
          void this.table()?.charger();
          this.sync.planifier(300);
        }
      });
  }
}
