import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, resource, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';

import { AuthService } from '../core/auth/auth.service';
import { db } from '../core/db';
import { anneeActive, rechercherEtudiants } from '../core/recherche-locale';
import { ReseauService } from '../core/reseau.service';
import { SyncService } from '../core/sync/sync.service';

const LIBELLES_ETAT: Record<string, string> = {
  EN_ATTENTE: 'En attente',
  VALIDEE: 'Validée',
  ANNULEE: 'Annulée',
  ABANDON: 'Abandon',
};

@Component({
  selector: 'app-tableau-de-bord',
  imports: [MatFormFieldModule, MatInputModule, MatIconModule, MatButtonModule, MatProgressBarModule, RouterLink,
    DatePipe, DecimalPipe],
  template: `
    <div class="page">
      <div class="page-entete">
        <div>
          <h1>Bonjour {{ auth.utilisateur()?.prenoms }}</h1>
          <p class="sous-titre">
            {{ auth.libelleRoles() }}
            @if (stats.value()?.annee; as a) { · Année {{ a }} }
          </p>
        </div>
        <p class="sous-titre synchro">
          @if (sync.derniereSynchro(); as d) {
            Données à jour du {{ d | date: 'dd/MM/yyyy à HH:mm' }}
          } @else {
            Données pas encore synchronisées
          }
        </p>
      </div>

      @if (sync.chargementInitial()) {
        <div class="carte chargement" data-test="chargement-initial">
          <strong>Préparation du mode hors ligne…</strong>
          <span>{{ sync.lignesRecues() | number: '1.0-0' : 'fr' }} enregistrements reçus</span>
          <mat-progress-bar mode="indeterminate" />
        </div>
      }

      @if (peutChercher()) {
        <section class="carte recherche">
          <h2>Rechercher un étudiant</h2>
          <mat-form-field appearance="outline" class="champ-recherche" subscriptSizing="dynamic">
            <mat-icon matPrefix>search</mat-icon>
            <mat-label>Matricule, nom ou prénoms</mat-label>
            <input matInput [value]="recherche()" (input)="recherche.set($any($event.target).value)"
                   placeholder="Ex. 26ATPV0001 ou Koné Awa" data-test="recherche-etudiant" autocomplete="off" />
            @if (recherche()) {
              <button mat-icon-button matSuffix (click)="recherche.set('')" aria-label="Effacer">
                <mat-icon>close</mat-icon>
              </button>
            }
          </mat-form-field>
          <p class="texte-secondaire aide">
            <mat-icon>offline_bolt</mat-icon> Recherche dans les données de ce poste : fonctionne aussi sans connexion.
          </p>

          @if (recherche().trim().length >= 2) {
            @if (resultats.value(); as liste) {
              @if (liste.length) {
                <div class="defilement-horizontal">
                  <table class="tableau" data-test="resultats-recherche">
                    <thead>
                      <tr><th>Matricule</th><th>Nom et prénoms</th><th>Sexe</th><th>Classe</th><th>Année</th><th>État</th></tr>
                    </thead>
                    <tbody>
                      @for (r of liste; track r.etudiant.id) {
                        <tr>
                          <td class="matricule">{{ r.etudiant['matricule'] ?? '—' }}</td>
                          <td><strong>{{ r.etudiant['nom'] }}</strong> {{ r.etudiant['prenoms'] }}</td>
                          <td>{{ r.etudiant['sexe'] === 'F' ? 'Fille' : 'Garçon' }}</td>
                          <td>{{ r.classe ?? '—' }}</td>
                          <td>{{ r.annee ?? '—' }}</td>
                          <td>
                            @if (r.etat) {
                              <span class="pastille" [class.neutre]="r.etat !== 'VALIDEE'">{{ libelleEtat(r.etat) }}</span>
                            }
                          </td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              } @else {
                <p class="vide" data-test="aucun-resultat">
                  <span class="material-symbols-outlined">person_off</span>
                  Aucun étudiant trouvé pour « {{ recherche() }} ».
                </p>
              }
            }
          }
        </section>
      }

      <section class="indicateurs">
        @for (i of indicateurs(); track i.libelle) {
          <a class="carte indicateur" [routerLink]="i.lien" [attr.data-test]="'indicateur-' + i.code">
            <span class="material-symbols-outlined icone">{{ i.icone }}</span>
            <span class="valeur">{{ i.valeur | number: '1.0-0' : 'fr' }}</span>
            <span class="libelle">{{ i.libelle }}</span>
          </a>
        }
      </section>

      @if (!reseau.enLigne()) {
        <p class="carte hors-ligne" data-test="message-hors-ligne">
          <span class="material-symbols-outlined">wifi_off</span>
          <span>
            Vous travaillez <strong>hors ligne</strong>. Vos saisies sont enregistrées sur ce poste et seront
            envoyées automatiquement au retour de la connexion.
          </span>
        </p>
      }
    </div>
  `,
  styles: `
    .synchro { font-size: 0.85rem; }
    .chargement { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
    .recherche { margin-bottom: 20px; }
    .champ-recherche { width: 100%; }
    .aide { display: flex; align-items: center; gap: 6px; margin: 6px 0 12px; }
    .aide mat-icon { font-size: 16px; width: 16px; height: 16px; color: var(--ispat-orange); }
    .indicateurs {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px;
    }
    .indicateur {
      display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; column-gap: 14px;
      text-decoration: none; color: inherit; transition: border-color 0.15s, transform 0.15s;
    }
    .indicateur:hover { border-color: var(--ispat-vert); transform: translateY(-1px); }
    .icone {
      grid-row: span 2; align-self: center; width: 44px; height: 44px; border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      background: var(--ispat-vert-clair); color: var(--ispat-vert);
    }
    .valeur { font-family: var(--ispat-police-titres); font-size: 1.6rem; font-weight: 700; color: var(--ispat-vert-fonce); }
    .libelle { font-size: 0.85rem; color: #5d6f68; }
    .hors-ligne {
      display: flex; gap: 12px; align-items: center; margin-top: 20px;
      background: var(--ispat-orange-clair); border-color: #f5d2ad; color: #7a3b04;
    }
  `,
})
export class TableauDeBordPage {
  readonly auth = inject(AuthService);
  readonly sync = inject(SyncService);
  readonly reseau = inject(ReseauService);

  readonly recherche = signal('');
  readonly peutChercher = computed(() =>
    this.auth.peut(['scolarite.inscription.lire', 'comptabilite.versement.lire', 'scolarite.liste_classe.lire']),
  );

  readonly resultats = resource({
    params: () => ({ texte: this.recherche(), revision: this.sync.revision() }),
    loader: ({ params }) => rechercherEtudiants(params.texte),
  });

  readonly stats = resource({
    params: () => ({ revision: this.sync.revision() }),
    loader: async () => {
      const annee = await anneeActive();
      const inscriptions = annee
        ? await db.table_('inscription').where('annee_id').equals(annee.id).filter((i) => i.etat === 'VALIDEE').count()
        : 0;
      return {
        annee: annee?.libelle ?? null,
        etudiants: await db.table_('etudiant').count(),
        inscriptions,
        prospects: await db.table_('prospect').count(),
        preinscriptions: await db.table_('preinscription').where('statut').equals('EN_ATTENTE').count(),
      };
    },
  });

  readonly indicateurs = computed(() => {
    const s = this.stats.value();
    const liste = [
      { code: 'etudiants', libelle: 'Étudiants', icone: 'school', valeur: s?.etudiants ?? 0, lien: '/scolarite/inscriptions',
        droits: ['scolarite.inscription.lire', 'comptabilite.versement.lire'] },
      { code: 'inscriptions', libelle: 'Inscriptions validées (année active)', icone: 'how_to_reg', valeur: s?.inscriptions ?? 0,
        lien: '/scolarite/inscriptions', droits: ['scolarite.inscription.lire', 'comptabilite.versement.lire'] },
      { code: 'prospects', libelle: 'Prospects', icone: 'person_search', valeur: s?.prospects ?? 0, lien: '/commercial/prospection',
        droits: ['commercial.prospection.lire', 'commercial.liste_prospect.lire'] },
      { code: 'preinscriptions', libelle: 'Pré-inscriptions à traiter', icone: 'assignment_ind', valeur: s?.preinscriptions ?? 0,
        lien: '/commercial/preinscriptions', droits: ['commercial.preinscription.lire'] },
      { code: 'attente', libelle: 'Saisies en attente d\'envoi', icone: 'cloud_upload', valeur: this.sync.aEnvoyer(),
        lien: '/synchronisation', droits: [] },
    ];
    return liste.filter((i) => this.auth.peut(i.droits));
  });

  libelleEtat(etat: string): string {
    return LIBELLES_ETAT[etat] ?? etat;
  }
}
