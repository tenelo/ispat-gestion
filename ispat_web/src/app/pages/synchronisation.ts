import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, resource } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTooltipModule } from '@angular/material/tooltip';

import { FichierAttente, Operation, SCHEMA_TABLES, db } from '../core/db';
import { ReseauService } from '../core/reseau.service';
import { SyncService } from '../core/sync/sync.service';
import { confirmer } from '../shared/confirmation';

const LIBELLES_TABLES: Record<string, string> = {
  annee_academique: 'Années académiques', semestre: 'Semestres', filiere: 'Filières', niveau: 'Niveaux',
  classe: 'Classes', matiere: 'Matières', enseignant: 'Enseignants', enseignement: 'Enseignements',
  statut_etudiant: 'Statuts étudiants', type_piece: 'Types de pièces', ville: 'Villes', ecole: 'Écoles',
  type_frais: 'Types de frais', categorie_mouvement: 'Catégories de caisse', parametre: 'Paramètres',
  tarif: 'Barème des frais', etudiant: 'Étudiants', contact_etudiant: 'Contacts étudiants',
  inscription: 'Inscriptions', piece_jointe: 'Pièces jointes', frais_inscription: 'Frais d\'inscription',
  prise_en_charge: 'Prises en charge', versement: 'Versements', mouvement_caisse: 'Mouvements de caisse',
  evaluation: 'Évaluations', note: 'Notes', moyenne_matiere: 'Moyennes par matière',
  moyenne_semestre: 'Moyennes semestrielles', campagne_prospection: 'Campagnes de prospection',
  prospect: 'Prospects', suivi_prospect: 'Suivis de prospects', preinscription: 'Pré-inscriptions',
};

@Component({
  selector: 'app-synchronisation',
  imports: [MatButtonModule, MatIconModule, MatProgressBarModule, MatTooltipModule, DatePipe, DecimalPipe],
  template: `
    <div class="page">
      <div class="page-entete">
        <div>
          <h1>Synchronisation</h1>
          <p class="sous-titre">Échanges entre ce poste et le serveur de l'ISPAT.</p>
        </div>
        <button mat-flat-button (click)="sync.synchroniser()" [disabled]="sync.enCours() || !reseau.enLigne()"
                data-test="synchroniser">
          <mat-icon>sync</mat-icon> Synchroniser maintenant
        </button>
      </div>

      <section class="etat-grille">
        <div class="carte">
          <span class="texte-secondaire">Connexion</span>
          <strong data-test="etat-connexion">{{ libelleReseau() }}</strong>
        </div>
        <div class="carte">
          <span class="texte-secondaire">Dernière synchronisation</span>
          <strong>{{ sync.derniereSynchro() ? (sync.derniereSynchro() | date: 'dd/MM/yyyy HH:mm:ss') : 'Jamais' }}</strong>
        </div>
        <div class="carte">
          <span class="texte-secondaire">En attente d'envoi</span>
          <strong data-test="compteur-attente">{{ sync.aEnvoyer() }}</strong>
        </div>
        <div class="carte" [class.alerte]="sync.aResoudre() > 0">
          <span class="texte-secondaire">À traiter</span>
          <strong data-test="compteur-a-traiter">{{ sync.aResoudre() }}</strong>
        </div>
      </section>
      @if (sync.enCours()) {
        <mat-progress-bar mode="indeterminate" class="progression" />
      }
      @if (sync.derniereErreur(); as e) {
        <p class="erreur-formulaire">Dernière tentative : {{ e }}</p>
      }

      <section class="carte bloc">
        <h2>Saisies de ce poste</h2>
        @if (operations.value(); as ops) {
          @if (ops.length) {
            <div class="defilement-horizontal">
              <table class="tableau" data-test="file-envoi">
                <thead><tr><th>Saisie</th><th>Le</th><th>État</th><th>Détail</th><th></th></tr></thead>
                <tbody>
                  @for (op of ops; track op.op_id) {
                    <tr [attr.data-statut]="op.statut">
                      <td>
                        <strong>{{ op.libelle }}</strong>
                        <div class="texte-secondaire">{{ libelleTable(op.table) }} · {{ op.action }}</div>
                      </td>
                      <td class="date">{{ op.cree_le | date: 'dd/MM HH:mm' }}</td>
                      <td>
                        @switch (op.statut) {
                          @case ('attente') { <span class="pastille attente"><mat-icon>schedule</mat-icon> En attente</span> }
                          @case ('conflit') { <span class="pastille alerte"><mat-icon>sync_problem</mat-icon> Conflit</span> }
                          @default { <span class="pastille alerte"><mat-icon>error</mat-icon> Refusée</span> }
                        }
                      </td>
                      <td class="detail">
                        @if (doublons(op).length) {
                          <div>Personne probablement déjà enregistrée sur le serveur :</div>
                        } @else if (op.message) {
                          <div>{{ op.message }}</div>
                        }
                        @if (doublons(op).length) {
                          <ul class="doublons" data-test="doublons">
                            @for (d of doublons(op); track d.id) {
                              <li>{{ d.nom }} {{ d.prenoms }} · {{ d.telephone ?? 'sans téléphone' }}
                                @if (d.agent) { · saisi par {{ d.agent }} }</li>
                            }
                          </ul>
                        }
                      </td>
                      <td class="boutons">
                        @if (op.statut !== 'attente') {
                          @if (doublons(op).length) {
                            <button mat-stroked-button (click)="renvoyer(op, true)" data-test="forcer"
                                    matTooltip="Ce n'est pas la même personne : enregistrer quand même">
                              Enregistrer quand même
                            </button>
                          } @else {
                            <button mat-stroked-button (click)="renvoyer(op)" data-test="renvoyer"
                                    [matTooltip]="op.statut === 'conflit' ? 'Appliquer ma saisie sur la version du serveur' : 'Réessayer'">
                              {{ op.statut === 'conflit' ? 'Garder ma saisie' : 'Réessayer' }}
                            </button>
                          }
                          <button mat-button (click)="abandonner(op)" data-test="abandonner">
                            {{ op.statut === 'conflit' ? 'Garder la version du serveur' : 'Abandonner' }}
                          </button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <p class="vide" data-test="file-vide">
              <span class="material-symbols-outlined">cloud_done</span>
              Toutes les saisies ont été envoyées.
            </p>
          }
        }
      </section>

      @if (fichiers.value()?.length) {
        <section class="carte bloc">
          <h2>Photos et pièces jointes à envoyer</h2>
          <div class="defilement-horizontal">
            <table class="tableau" data-test="fichiers-attente">
              <thead><tr><th>Fichier</th><th>Le</th><th>État</th><th>Détail</th><th></th></tr></thead>
              <tbody>
                @for (f of fichiers.value(); track f.seq) {
                  <tr [attr.data-statut]="f.statut">
                    <td><strong>{{ f.libelle }}</strong><div class="texte-secondaire">{{ f.nom }} · {{ taille(f.blob.size) }}</div></td>
                    <td class="date">{{ f.cree_le | date: 'dd/MM HH:mm' }}</td>
                    <td>
                      @if (f.statut === 'attente') {
                        <span class="pastille attente"><mat-icon>schedule</mat-icon> En attente</span>
                      } @else {
                        <span class="pastille alerte"><mat-icon>error</mat-icon> Refusé</span>
                      }
                    </td>
                    <td class="detail">{{ f.message }}</td>
                    <td class="boutons">
                      @if (f.statut === 'erreur') {
                        <button mat-stroked-button (click)="sync.reessayerFichier(f)">Réessayer</button>
                        <button mat-button (click)="abandonnerFichier(f)">Abandonner</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      }

      <section class="carte bloc">
        <h2>Données disponibles hors ligne</h2>
        <div class="comptes">
          @for (c of comptes.value() ?? []; track c.table) {
            <div class="compte" [attr.data-table]="c.table">
              <span>{{ c.libelle }}</span><strong>{{ c.nombre | number: '1.0-0' : 'fr' }}</strong>
            </div>
          }
        </div>
        <p class="texte-secondaire">
          Seules les données autorisées pour votre rôle sont copiées sur ce poste. Elles sont effacées à la déconnexion.
        </p>
      </section>
    </div>
  `,
  styles: `
    .etat-grille { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
    .etat-grille .carte { display: flex; flex-direction: column; gap: 4px; }
    .etat-grille strong { font-family: var(--ispat-police-titres); font-size: 1.15rem; color: var(--ispat-vert-fonce); }
    .etat-grille .alerte { border-color: #f1b7b0; }
    .etat-grille .alerte strong { color: var(--ispat-rouge); }
    .progression { margin-top: 12px; }
    .bloc { margin-top: 20px; }
    .date { white-space: nowrap; }
    .detail { max-width: 380px; font-size: 0.85rem; }
    .doublons { margin: 6px 0 0; padding-left: 18px; color: #5d6f68; }
    .boutons { white-space: nowrap; text-align: right; }
    .boutons button { margin-left: 6px; }
    .comptes { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 4px 24px; margin-bottom: 12px; }
    .compte { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px dashed #e3e9e6; font-size: 0.9rem; }
    .pastille mat-icon { font-size: 14px; width: 14px; height: 14px; }
  `,
})
export class SynchronisationPage {
  readonly sync = inject(SyncService);
  readonly reseau = inject(ReseauService);
  private readonly dialog = inject(MatDialog);

  readonly libelleReseau = computed(
    () => ({ en_ligne: 'En ligne', serveur_injoignable: 'Serveur injoignable', hors_ligne: 'Hors ligne' })[this.reseau.etat()],
  );

  readonly operations = resource({
    params: () => ({ r: this.sync.revision(), n: this.sync.aEnvoyer() }),
    loader: () => db.operations.orderBy('seq').toArray(),
  });

  readonly comptes = resource({
    params: () => ({ r: this.sync.revision() }),
    loader: async () => {
      const liste = await Promise.all(
        Object.keys(SCHEMA_TABLES).map(async (t) => ({ table: t, libelle: LIBELLES_TABLES[t] ?? t, nombre: await db.table_(t).count() })),
      );
      return liste.filter((c) => c.nombre > 0);
    },
  });

  readonly fichiers = resource({
    params: () => ({ r: this.sync.revision(), n: this.sync.aEnvoyer() }),
    loader: () => db.fichiers.orderBy('seq').toArray(),
  });

  taille(octets: number): string {
    return octets > 1024 * 1024 ? `${(octets / 1024 / 1024).toFixed(1)} Mo` : `${Math.ceil(octets / 1024)} Ko`;
  }

  async abandonnerFichier(f: FichierAttente): Promise<void> {
    const ok = await confirmer(this.dialog, {
      titre: 'Abandonner le fichier', message: `« ${f.libelle} » ne sera pas envoyé.`, confirmer: 'Abandonner', danger: true,
    });
    if (ok) {
      await this.sync.abandonnerFichier(f);
    }
  }

  libelleTable(t: string): string {
    return LIBELLES_TABLES[t] ?? t;
  }

  doublons(op: Operation): any[] {
    const d = op.details?.erreurs?.doublons ?? op.details?.doublons;
    return Array.isArray(d) ? d : [];
  }

  renvoyer(op: Operation, forcer = false): Promise<void> {
    return this.sync.renvoyer(op, forcer);
  }

  async abandonner(op: Operation): Promise<void> {
    const ok = await confirmer(this.dialog, {
      titre: op.statut === 'conflit' ? 'Garder la version du serveur' : 'Abandonner la saisie',
      message: `« ${op.libelle} »\n\nCette saisie sera retirée de ce poste et ne sera pas envoyée.`,
      confirmer: 'Abandonner ma saisie',
      danger: true,
    });
    if (ok) {
      await this.sync.garderServeur(op);
    }
  }
}
