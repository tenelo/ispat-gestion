import { Component } from '@angular/core';

import { STATUTS_PEC, TYPES_PAYEUR, fcfa } from '../../core/finances';
import { Descripteur } from '../../shared/crud/crud';
import { TableCrud } from '../../shared/crud/table-crud';

const STATUTS = Object.fromEntries(STATUTS_PEC);
const PAYEURS = Object.fromEntries(TYPES_PAYEUR);

/** Prises en charge (État, entreprise, ONG, bourse…) : montant fixe ou taux des frais concernés. */
@Component({
  selector: 'app-prises-en-charge',
  imports: [TableCrud],
  template: `
    <div class="page large">
      <div class="page-entete">
        <div>
          <h1>Prises en charge</h1>
          <p class="sous-titre">La part prise en charge est déduite du reste à payer de l'étudiant ; l'organisme règle par versements. Connexion nécessaire.</p>
        </div>
      </div>
      <section class="carte"><app-table-crud [descripteur]="descripteur" /></section>
    </div>
  `,
  styles: `.large { max-width: 1400px; }`,
})
export class PrisesEnChargePage {
  readonly descripteur: Descripteur = {
    code: 'pec', titre: 'Prises en charge', singulier: 'une prise en charge', feminin: true,
    chemin: '/api/comptabilite/prises-en-charge/',
    droits: {
      creer: ['comptabilite.prise_en_charge.creer'],
      modifier: ['comptabilite.prise_en_charge.modifier'],
      supprimer: ['comptabilite.prise_en_charge.supprimer'],
    },
    aide: 'Montant fixe, ou taux (%) appliqué aux frais concernés (tous les frais si aucun type n\'est choisi).',
    filtres: [
      { cle: 'annee', libelle: 'Année', choix: [['active', 'Année active']], defaut: 'active' },
      { cle: 'type_payeur', libelle: 'Payeur', choix: TYPES_PAYEUR },
      { cle: 'statut', libelle: 'Statut', choix: STATUTS_PEC },
    ],
    colonnes: [
      { libelle: 'Matricule', cle: 'etudiant_matricule', type: 'code' },
      { libelle: 'Étudiant', cle: 'etudiant_nom' },
      { libelle: 'Organisme', cle: 'organisme' },
      { libelle: 'Type', valeur: (p) => PAYEURS[p.type_payeur] ?? p.type_payeur },
      { libelle: 'Frais', valeur: (p) => p.type_frais_libelle ?? 'Tous les frais' },
      { libelle: 'Taux', valeur: (p) => (p.taux != null ? `${Number(p.taux)} %` : '—') },
      { libelle: 'Montant', valeur: (p) => fcfa(p.montant) },
      { libelle: 'Statut', type: 'pastille', pastille: (p) => ({ texte: STATUTS[p.statut] ?? p.statut, classe: p.statut === 'ACTIVE' ? '' : 'neutre' }) },
    ],
    champs: [
      {
        cle: 'inscription', libelle: 'Étudiant (inscription validée)', type: 'reference', obligatoire: true, creationSeulement: true, pleineLargeur: true,
        reference: {
          chemin: '/api/scolarite/inscriptions/', params: { annee: 'active', etat: 'VALIDEE' },
          libelle: (i) => `${i.etudiant_matricule ?? '—'} — ${i.etudiant_nom} ${i.etudiant_prenoms} (${i.classe_libelle})`,
        },
      },
      { cle: 'type_payeur', libelle: 'Type de payeur', type: 'choix', choix: TYPES_PAYEUR, obligatoire: true },
      { cle: 'organisme', libelle: 'Organisme', type: 'texte', obligatoire: true },
      { cle: 'type_frais', libelle: 'Frais concernés', type: 'reference', reference: { chemin: '/api/referentiels/types-frais/', libelle: (t) => t.libelle } },
      { cle: 'taux', libelle: 'Taux (%)', type: 'nombre', min: 0, max: 100 },
      { cle: 'montant', libelle: 'Montant (FCFA)', type: 'nombre', min: 0, aide: 'Vide = calculé à partir du taux' },
      { cle: 'reference_doc', libelle: 'Référence du document', type: 'texte' },
      { cle: 'date_accord', libelle: 'Date de l\'accord', type: 'date' },
      { cle: 'statut', libelle: 'Statut', type: 'choix', choix: STATUTS_PEC, defaut: 'ACTIVE', obligatoire: true },
    ],
    preparer: (d, ligne) => {
      if (ligne && (d['montant'] === null || d['montant'] === undefined)) {
        delete d['montant'];             // recalculé depuis le taux
      }
      return d;
    },
    tri: (a, b) => String(a.etudiant_nom).localeCompare(String(b.etudiant_nom), 'fr'),
  };
}
